import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTextPdf } from './fixtures/pdf'

import { DEFAULT_ALLOWED_MIME_TYPES, sha256, sniffMimeType, validateUpload } from '@/lib/extraction/sniff'
import { planUpload } from '@/lib/extraction/versioning'
import { signFileToken, verifyFileToken } from '@/lib/storage/sign'
import { LocalFileStorage } from '@/lib/storage/local'
import { extractPdfText } from '@/lib/extraction/pdf-text'
import { extractFieldsFromText } from '@/lib/extraction/parse'
import {
  canApproveDocument,
  computeConflictNotes,
  computeMissingFieldKeys,
  detectDocumentType,
  documentStatusAfterExtraction,
  specForType,
  type ReviewableField,
} from '@/lib/extraction/spec'
import type { SessionUser } from '@/lib/rbac'
import type { PermissionKey } from '@/lib/permissions'

process.env.AUTH_SECRET ??= 'test-secret'
process.env.AI_PROVIDER = 'mock' // extraction tests must never call a real model

const PDF_HEADER = Buffer.from('%PDF-1.4\n')
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(16)])

const BILL_TEXT = `Desert Sun Power & Electric
Account number: DSP-4417-2210
Service address: 88 Saguaro Court, Mesa AZ
Billing period: 2026-07-01 to 2026-07-31
Amount due: $221.40
Usage: 1,412 kWh this billing period
`

describe('magic-byte sniffing', () => {
  it('identifies each supported format', () => {
    expect(sniffMimeType(PDF_HEADER)).toBe('application/pdf')
    expect(sniffMimeType(PNG)).toBe('image/png')
    expect(sniffMimeType(JPEG)).toBe('image/jpeg')
    expect(sniffMimeType(WEBP)).toBe('image/webp')
    expect(sniffMimeType(HEIC)).toBe('image/heic')
    expect(sniffMimeType(Buffer.from('plain old text'))).toBe('text/plain')
  })

  it('rejects unrecognized binary content', () => {
    expect(sniffMimeType(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]))).toBeNull()
  })
})

describe('upload validation', () => {
  const base = { maxSizeMb: 25, allowedMimeTypes: [] as string[] }

  it('accepts a well-formed PDF declared as PDF', () => {
    const res = validateUpload({ ...base, buffer: PDF_HEADER, declaredMime: 'application/pdf' })
    expect(res).toEqual({ ok: true, mimeType: 'application/pdf' })
  })

  it('accepts a PDF whose %PDF- marker is after a short header', () => {
    const res = validateUpload({ ...base, buffer: Buffer.concat([Buffer.from('\x00\x00'), PDF_HEADER]), declaredMime: 'application/pdf' })
    expect(res).toEqual({ ok: true, mimeType: 'application/pdf' })
  })

  it('rejects a spoofed declaration (PNG bytes declared as PDF)', () => {
    const res = validateUpload({ ...base, buffer: PNG, declaredMime: 'application/pdf' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/does not match/i)
  })

  it('rejects a type outside the requirement allow-list', () => {
    const res = validateUpload({ ...base, allowedMimeTypes: ['application/pdf'], buffer: PNG, declaredMime: 'image/png' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/not accepted/i)
  })

  it('rejects oversize and empty files with clear reasons', () => {
    const big = validateUpload({ ...base, maxSizeMb: 1, buffer: Buffer.alloc(1024 * 1024 + 1, 0x41), declaredMime: 'text/plain' })
    expect(big.ok).toBe(false)
    const empty = validateUpload({ ...base, buffer: Buffer.alloc(0), declaredMime: 'text/plain' })
    expect(empty.ok).toBe(false)
  })

  it('normalizes MIME aliases (image/jpg)', () => {
    const res = validateUpload({ ...base, buffer: JPEG, declaredMime: 'image/jpg' })
    expect(res).toEqual({ ok: true, mimeType: 'image/jpeg' })
  })

  it('has a sane default allow-list', () => {
    expect(DEFAULT_ALLOWED_MIME_TYPES).toContain('application/pdf')
    expect(DEFAULT_ALLOWED_MIME_TYPES).toContain('image/heic')
  })
})

describe('checksum', () => {
  it('is a stable sha256 hex digest', () => {
    expect(sha256(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('version chaining (planUpload)', () => {
  it('starts at version 1 with nothing on file', () => {
    expect(planUpload([])).toEqual({ mode: 'new', version: 1, supersedesId: null })
  })

  it('fills a REQUESTED placeholder on first upload instead of duplicating', () => {
    const plan = planUpload([{ id: 'a', version: 1, status: 'REQUESTED', storageKey: null }])
    expect(plan).toEqual({ mode: 'fill', documentId: 'a', version: 1 })
  })

  it('re-upload creates version N+1 superseding the latest file — never overwrites', () => {
    const plan = planUpload([
      { id: 'a', version: 1, status: 'REJECTED', storageKey: 'k1.bin' },
      { id: 'b', version: 2, status: 'UNDER_REVIEW', storageKey: 'k2.bin' },
    ])
    expect(plan).toEqual({ mode: 'new', version: 3, supersedesId: 'b' })
  })

  it('a pending re-upload request placeholder is filled, keeping its version', () => {
    const plan = planUpload([
      { id: 'a', version: 1, status: 'MISSING_INFORMATION', storageKey: 'k1.bin' },
      { id: 'b', version: 2, status: 'REQUESTED', storageKey: null },
    ])
    expect(plan).toEqual({ mode: 'fill', documentId: 'b', version: 2 })
  })
})

describe('signed file tokens', () => {
  it('round-trips a valid token', () => {
    const token = signFileToken({ key: 'abc.bin', exp: Math.floor(Date.now() / 1000) + 60 })
    expect(verifyFileToken(token)).toMatchObject({ key: 'abc.bin' })
  })

  it('rejects an expired token', () => {
    const token = signFileToken({ key: 'abc.bin', exp: 100 })
    expect(verifyFileToken(token, { now: 101 })).toBeNull()
  })

  it('rejects tampering with the payload', () => {
    const token = signFileToken({ key: 'abc.bin', exp: Math.floor(Date.now() / 1000) + 60 })
    const [, sig] = token.split('.')
    const forged = `${Buffer.from(JSON.stringify({ key: 'other.bin', exp: 9999999999 })).toString('base64url')}.${sig}`
    expect(verifyFileToken(forged)).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    const token = signFileToken({ key: 'abc.bin', exp: Math.floor(Date.now() / 1000) + 60 }, 'other-secret')
    expect(verifyFileToken(token)).toBeNull()
  })
})

describe('local storage driver', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pf-storage-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('stores under an opaque key and reads back the same bytes', async () => {
    const storage = new LocalFileStorage(dir)
    const { key } = await storage.put(Buffer.from('hello'), { fileName: 'a.txt', mimeType: 'text/plain', clientId: 'c' })
    expect(key).toMatch(/^[a-f0-9]{32}\.bin$/)
    expect((await storage.get(key)).toString()).toBe('hello')
    await storage.delete(key)
    await expect(storage.get(key)).rejects.toThrow()
  })

  it('refuses path-traversal keys', async () => {
    const storage = new LocalFileStorage(dir)
    await expect(storage.get('../../etc/passwd')).rejects.toThrow(/invalid storage key/i)
    await expect(storage.get('..\\secrets.bin')).rejects.toThrow(/invalid storage key/i)
  })
})

describe('pdf text extraction', () => {
  it('reads hex-encoded text out of a valid compressed PDF', async () => {
    const pdf = makeTextPdf(['Account number: DSP-1. Amount due: $10.00 for the billing period.'])
    const { pages, pageCount } = await extractPdfText(pdf)
    expect(pageCount).toBe(1)
    expect(pages.join('\n')).toContain('Account number: DSP-1')
    expect(pages.join('\n')).toContain('Amount due: $10.00')
  })

  it('preserves a text-free physical page and requires vision instead of inventing content', async () => {
    const { pages, warnings, needsVision } = await extractPdfText(makeTextPdf(['']))
    expect(pages).toEqual([''])
    expect(needsVision).toBe(true)
    expect(warnings.join(' ')).toMatch(/vision is required/i)
  })
})

describe('document type detection', () => {
  it('detects a utility bill from text alone', () => {
    const d = detectDocumentType({ text: BILL_TEXT })
    expect(d.spec.key).toBe('utility_bill')
    expect(d.confidence).toBeGreaterThanOrEqual(30)
  })

  it('trusts the requirement key as the strongest signal', () => {
    const d = detectDocumentType({ text: 'unreadable scan', requirementKey: 'government_id' })
    expect(d.spec.key).toBe('government_id')
  })

  it('falls back to the generic type on no signal', () => {
    expect(detectDocumentType({ text: 'grocery list: eggs, milk' }).spec.key).toBe('other')
  })
})

describe('deterministic field extraction', () => {
  const spec = specForType('utility_bill')

  it('reads labeled fields with source snippets and pages', () => {
    const fields = extractFieldsFromText(spec, [BILL_TEXT])
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]))
    expect(byKey.account_number.value).toBe('DSP-4417-2210')
    expect(byKey.account_number.sourcePage).toBe(1)
    expect(byKey.account_number.sourceSnippet).toContain('Account number')
    expect(byKey.service_address.value).toBe('88 Saguaro Court, Mesa AZ')
    expect(byKey.amount_due.value).toBe('$221.40')
  })

  it('emits absent fields with null value and zero confidence — never a guess', () => {
    const fields = extractFieldsFromText(spec, ['completely unrelated text'])
    for (const f of fields) {
      expect(f.value).toBeNull()
      expect(f.confidence).toBe(0)
    }
  })
})

describe('missing fields and status', () => {
  const spec = specForType('utility_bill')

  it('treats empty and low-confidence values as missing', () => {
    const missing = computeMissingFieldKeys(spec, [
      { key: 'utility_name', value: 'Desert Sun', confidence: 82 },
      { key: 'account_number', value: null, confidence: 0 },
      { key: 'service_address', value: '88 Saguaro Ct', confidence: 45 }, // below floor
      { key: 'amount_due', value: '$221.40', confidence: 92 },
    ])
    expect(missing.sort()).toEqual(['account_number', 'service_address'])
    expect(documentStatusAfterExtraction(missing)).toBe('MISSING_INFORMATION')
  })

  it('is UNDER_REVIEW when every required field is present with confidence', () => {
    const fields = spec.fields.map((f) => ({ key: f.key, value: 'x', confidence: 90 }))
    expect(documentStatusAfterExtraction(computeMissingFieldKeys(spec, fields))).toBe('UNDER_REVIEW')
  })
})

describe('conflict computation', () => {
  const client = { firstName: 'Maria', lastName: 'Lopez', email: null, phone: null, address: '12 Elm Street, Mesa AZ' }

  it('flags a different name and a different address', () => {
    const notes = computeConflictNotes(
      [
        { key: 'full_name', value: 'Robert Smith' },
        { key: 'service_address', value: '400 Oak Avenue, Tucson AZ' },
      ],
      client,
    )
    expect(notes.full_name).toMatch(/Maria Lopez/)
    expect(notes.service_address).toMatch(/12 Elm Street/)
  })

  it('stays quiet when values agree', () => {
    const notes = computeConflictNotes(
      [
        { key: 'full_name', value: 'Maria B. Lopez' },
        { key: 'service_address', value: '12 Elm St, Mesa AZ 85201' },
      ],
      client,
    )
    expect(notes).toEqual({})
  })
})

describe('approval invariant', () => {
  const spec = specForType('government_id')
  const field = (key: string, verification: ReviewableField['verification'], value: string | null = 'v'): ReviewableField => ({
    key,
    label: key,
    value,
    correctedValue: null,
    verification,
  })

  it('refuses approval while any required field is UNVERIFIED', () => {
    const check = canApproveDocument(spec, [
      field('full_name', 'VERIFIED'),
      field('date_of_birth', 'UNVERIFIED'),
      field('id_number', 'VERIFIED'),
      field('expiration_date', 'VERIFIED'),
    ])
    expect(check.ok).toBe(false)
    expect(check.blocking.map((b) => b.key)).toEqual(['date_of_birth'])
  })

  it('refuses approval on a rejected required field without a correction', () => {
    const check = canApproveDocument(spec, [
      field('full_name', 'REJECTED'),
      field('date_of_birth', 'VERIFIED'),
      field('id_number', 'VERIFIED'),
      field('expiration_date', 'VERIFIED'),
    ])
    expect(check.ok).toBe(false)
  })

  it('approves only when every required field is VERIFIED or CORRECTED with a value', () => {
    const corrected: ReviewableField = { key: 'id_number', label: 'ID', value: null, correctedValue: 'D123', verification: 'CORRECTED' }
    const check = canApproveDocument(spec, [
      field('full_name', 'VERIFIED'),
      field('date_of_birth', 'CORRECTED', null), // corrected but empty → still blocked
      corrected,
      field('expiration_date', 'VERIFIED'),
    ])
    expect(check.ok).toBe(false)

    const ok = canApproveDocument(spec, [
      field('full_name', 'VERIFIED'),
      { ...field('date_of_birth', 'CORRECTED', null), correctedValue: '01/02/1980' },
      corrected,
      field('expiration_date', 'VERIFIED'),
    ])
    expect(ok.ok).toBe(true)
  })
})

// ── DB-backed: scope denial and the extraction pipeline ─────────

describe('database-backed document flows', () => {
  const run = `docs-test-${Date.now()}`
  const storageDir = mkdtempSync(path.join(os.tmpdir(), 'pf-docs-'))
  let orgA: string
  let orgB: string
  let clientId: string
  let documentId: string
  // Deferred imports so FILE_STORAGE_LOCAL_DIR is set before the driver reads it.
  let db: typeof import('@/lib/db').db
  let findDocumentInScope: typeof import('@/lib/storage/access').findDocumentInScope
  let runExtraction: typeof import('@/lib/extraction/run').runExtraction

  const fakeUser = (organizationId: string, permissions: PermissionKey[], role: SessionUser['role'] = 'SUPER_ADMIN'): SessionUser => ({
    id: `${run}-user-${role}`,
    name: 'Test User',
    email: `${role.toLowerCase()}@${run}.test`,
    organizationId,
    organizationName: 'Test',
    roleId: 'r', isOwner: false,
    role,
    roleName: role,
    regionId: null,
    teamId: null,
    managerId: null,
    avatarUrl: null,
    title: null,
    permissions: new Set(permissions),
    portalClientId: null,
  })

  beforeAll(async () => {
    process.env.FILE_STORAGE_LOCAL_DIR = storageDir
    ;({ db } = await import('@/lib/db'))
    ;({ findDocumentInScope } = await import('@/lib/storage/access'))
    ;({ runExtraction } = await import('@/lib/extraction/run'))

    const a = await db.organization.create({ data: { name: `Org A ${run}`, slug: `a-${run}` } })
    const b = await db.organization.create({ data: { name: `Org B ${run}`, slug: `b-${run}` } })
    orgA = a.id
    orgB = b.id

    const pipeline = await db.pipeline.create({ data: { organizationId: orgA, name: 'P', isDefault: true } })
    const stage = await db.pipelineStage.create({
      data: { pipelineId: pipeline.id, key: 'DOCUMENT_COLLECTION', name: 'Docs', category: 'FULFILLMENT', position: 0 },
    })
    const client = await db.client.create({
      data: {
        organizationId: orgA,
        pipelineId: pipeline.id,
        currentStageId: stage.id,
        firstName: 'Test',
        lastName: 'Client',
        email: `client@${run}.test`,
        phone: '5550001111',
      },
    })
    clientId = client.id

    const { LocalFileStorage: Driver } = await import('@/lib/storage/local')
    const { key } = await new Driver(storageDir).put(Buffer.from(BILL_TEXT), {
      fileName: 'bill.txt',
      mimeType: 'text/plain',
      clientId,
    })
    const doc = await db.clientDocument.create({
      data: {
        clientId,
        status: 'RECEIVED',
        version: 1,
        label: 'Utility bill',
        fileName: 'bill.txt',
        storageKey: key,
        mimeType: 'text/plain',
        sizeBytes: BILL_TEXT.length,
        checksum: sha256(Buffer.from(BILL_TEXT)),
        receivedAt: new Date(),
      },
    })
    documentId = doc.id
  })

  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
    rmSync(storageDir, { recursive: true, force: true })
  })

  it('grants document access inside scope', async () => {
    const admin = fakeUser(orgA, ['clients:read_all', 'documents:read'])
    expect(await findDocumentInScope(admin, documentId)).not.toBeNull()
  })

  it('denies the signed-URL route lookup to an out-of-scope user', async () => {
    // Another organization entirely.
    const otherOrgAdmin = fakeUser(orgB, ['clients:read_all', 'documents:read'])
    expect(await findDocumentInScope(otherOrgAdmin, documentId)).toBeNull()

    // Same org, but a closer with no assignment to this client.
    const unassignedCloser = fakeUser(orgA, ['clients:read_assigned', 'documents:read'], 'CLOSER')
    expect(await findDocumentInScope(unassignedCloser, documentId)).toBeNull()
  })

  it('runs the extraction pipeline end to end with correct status transitions', async () => {
    const result = await runExtraction(documentId)
    expect(result.status).toBe('COMPLETED')
    expect(result.documentStatus).toBe('UNDER_REVIEW')
    expect(result.missingFieldKeys).toEqual([])

    const extraction = await db.documentExtraction.findUniqueOrThrow({
      where: { id: result.extractionId },
      include: { fields: true },
    })
    expect(extraction.status).toBe('COMPLETED')
    expect(extraction.provider).toBe('mock')
    expect(extraction.detectedTypeKey).toBe('utility_bill')
    expect(extraction.startedAt).not.toBeNull()
    expect(extraction.completedAt).not.toBeNull()
    const byKey = Object.fromEntries(extraction.fields.map((f) => [f.key, f]))
    expect(byKey.account_number.value).toBe('DSP-4417-2210')
    expect(byKey.account_number.verification).toBe('UNVERIFIED') // AI output is never pre-verified

    const doc = await db.clientDocument.findUniqueOrThrow({ where: { id: documentId } })
    expect(doc.status).toBe('UNDER_REVIEW')
  })

  it('a failed extraction returns the document to RECEIVED and records the error', async () => {
    const broken = await db.clientDocument.create({
      data: {
        clientId,
        status: 'RECEIVED',
        version: 1,
        label: 'Broken',
        fileName: 'gone.txt',
        storageKey: 'aaaabbbbccccddddaaaabbbbccccdddd.bin', // valid shape, no file on disk
        mimeType: 'text/plain',
        receivedAt: new Date(),
      },
    })
    const result = await runExtraction(broken.id)
    expect(result.status).toBe('FAILED')
    const doc = await db.clientDocument.findUniqueOrThrow({ where: { id: broken.id } })
    expect(doc.status).toBe('RECEIVED')
    const extraction = await db.documentExtraction.findUniqueOrThrow({ where: { id: result.extractionId } })
    expect(extraction.status).toBe('FAILED')
    expect(extraction.error).toBeTruthy()
  })

  it('records zero-yield processing as a failure and preserves its original and each attempt', async () => {
    const source = Buffer.from('Unrelated text with no supported document facts.')
    const { key } = await new LocalFileStorage(storageDir).put(source, { fileName: 'unknown.txt', mimeType: 'text/plain', clientId })
    const doc = await db.clientDocument.create({ data: { clientId, status: 'RECEIVED', storageKey: key, fileName: 'unknown.txt', mimeType: 'text/plain' } })
    const first = await runExtraction(doc.id)
    const second = await runExtraction(doc.id)
    expect(first.status).toBe('FAILED')
    expect(second.status).toBe('FAILED')
    expect(first.error).toMatch(/no supported fields/)
    expect(await db.documentExtraction.count({ where: { documentId: doc.id } })).toBe(2)
    expect((await db.documentExtraction.findUniqueOrThrow({ where: { id: first.extractionId } })).rawText).toBe(source.toString())
    expect(await new LocalFileStorage(storageDir).get(key)).toEqual(source)
  })

  it('records a missing live credential failure without overwriting a previous successful extraction', async () => {
    const previousKey = process.env.ANTHROPIC_API_KEY
    process.env.AI_PROVIDER = 'anthropic'
    delete process.env.ANTHROPIC_API_KEY
    try {
      const result = await runExtraction(documentId)
      expect(result.status).toBe('FAILED')
      expect(result.error).toMatch(/not configured/)
      const attempt = await db.documentExtraction.findUniqueOrThrow({ where: { id: result.extractionId } })
      expect(attempt.provider).toBe('anthropic')
      expect(attempt.rawText).toBe(BILL_TEXT.trim())
      expect(await db.documentExtraction.count({ where: { documentId, status: 'COMPLETED' } })).toBe(1)
    } finally {
      process.env.AI_PROVIDER = 'mock'
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousKey
    }
  })

  it('does not Anthropic-extract SCS uploads; analysis waits for the SCS packet', async () => {
    const { runPendingScsDocumentExtractions } = await import('@/lib/intake/scs-document-import')
    const sourceLeadId = randomUUID()
    const sourceDocumentId = randomUUID()
    const source = await db.intakeSource.create({ data: { organizationId: orgA, name: 'Retry test', slug: `retry-${run}`, kind: 'WEB_FORM' } })
    const submission = await db.intakeSubmission.create({ data: { organizationId: orgA, sourceId: source.id, externalId: sourceLeadId, clientId } })
    const { key } = await new LocalFileStorage(storageDir).put(Buffer.from(BILL_TEXT), { fileName: 'retry.txt', mimeType: 'text/plain', clientId })
    const doc = await db.clientDocument.create({ data: { clientId, status: 'RECEIVED', storageKey: key, fileName: 'retry.txt', mimeType: 'text/plain', label: 'utility_bill' } })
    await db.externalDocumentImport.create({ data: { organizationId: orgA, intakeSubmissionId: submission.id, clientId, sourceLeadId, sourceDocumentId, status: 'IMPORTED', clientDocumentId: doc.id } })
    const previousKey = process.env.ANTHROPIC_API_KEY
    const previousCohort = process.env.SCS_IMPORT_EXECUTION_COHORT
    process.env.AI_PROVIDER = 'anthropic'
    delete process.env.ANTHROPIC_API_KEY
    process.env.SCS_IMPORT_EXECUTION_COHORT = JSON.stringify({ mode: 'resume', expiresAt: new Date(Date.now() + 60_000).toISOString(), organizationId: orgA, sourceId: source.id, cases: [{ leadId: sourceLeadId, documentIds: [sourceDocumentId] }] })
    try {
      expect(await runPendingScsDocumentExtractions(1)).toEqual({ attempted: 0, completed: 0, failed: 0, skipped: 0 })
      expect(await db.documentExtraction.count({ where: { documentId: doc.id, provider: 'anthropic' } })).toBe(0)
      expect(await db.clientDocument.count({ where: { id: doc.id } })).toBe(1)
      expect(await new LocalFileStorage(storageDir).get(key)).toEqual(Buffer.from(BILL_TEXT))
    } finally {
      process.env.AI_PROVIDER = 'mock'
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousKey
      if (previousCohort === undefined) delete process.env.SCS_IMPORT_EXECUTION_COHORT
      else process.env.SCS_IMPORT_EXECUTION_COHORT = previousCohort
    }
  })

  it('blocks manual extraction of generated record references while keeping their original accessible', async () => {
    const source = await db.intakeSource.create({ data: { organizationId: orgA, name: 'Reference test', slug: `reference-${run}`, kind: 'WEB_FORM' } })
    const submission = await db.intakeSubmission.create({ data: { organizationId: orgA, sourceId: source.id, externalId: randomUUID(), clientId } })
    // Readable known facts would normally extract successfully. Classification,
    // rather than missing text or provider configuration, must prevent this.
    const { key } = await new LocalFileStorage(storageDir).put(Buffer.from(BILL_TEXT), { fileName: 'generated-reference.txt', mimeType: 'text/plain', clientId })
    const doc = await db.clientDocument.create({ data: { clientId, status: 'RECEIVED', storageKey: key, fileName: 'generated-reference.txt', mimeType: 'text/plain' } })
    await db.externalDocumentImport.create({ data: { organizationId: orgA, intakeSubmissionId: submission.id, clientId, sourceLeadId: randomUUID(), sourceDocumentId: randomUUID(), sourceDocumentType: 'public_record_summary', status: 'IMPORTED', clientDocumentId: doc.id } })
    const result = await runExtraction(doc.id)
    expect(result.status).toBe('FAILED')
    expect(result.error).toMatch(/generated public-record search reference/)
    expect(await db.extractedField.count({ where: { extraction: { documentId: doc.id } } })).toBe(0)
    expect((await db.clientDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('RECEIVED')
    expect(await new LocalFileStorage(storageDir).get(key)).toEqual(Buffer.from(BILL_TEXT))
  })
})
