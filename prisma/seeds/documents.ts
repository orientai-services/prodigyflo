import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PrismaClient } from '@prisma/client'

/**
 * Phase 4 seed: a standard document package, plus documents for the first few
 * clients in every review state — requested, under review with a conflict,
 * missing information, and approved. Deterministic and synthetic. Files are
 * written straight into the local storage directory with fixed keys so
 * re-seeding is idempotent.
 */

type Ctx = {
  organizationId: string
  users: { id: string; email: string; role: string }[]
  clientIds: string[]
}

const STORAGE_DIR = path.resolve(process.cwd(), process.env.FILE_STORAGE_LOCAL_DIR ?? 'storage/documents')

function storeFile(key: string, content: string): { checksum: string; sizeBytes: number } {
  mkdirSync(STORAGE_DIR, { recursive: true })
  const buf = Buffer.from(content, 'utf8')
  writeFileSync(path.join(STORAGE_DIR, key), buf)
  return { checksum: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.length }
}

const UTILITY_BILL = `Desert Sun Power & Electric
Statement of account

Account number: DSP-4417-2210
Service address: 88 Saguaro Court, Mesa AZ
Billing period: 2026-07-01 to 2026-07-31
Amount due: $221.40

Usage this period: 1,412 kWh
Thank you for being a Desert Sun customer.
`

const SOLAR_CONTRACT = `RESIDENTIAL SOLAR POWER PURCHASE AGREEMENT

Installer: Brightline Solar LLC
Contract date: 03/14/2024
System size: 7.2 kW photovoltaic
Monthly payment: $189.00
Term: 25 years
Escalator: 2.9%

The parties agree to the terms set out above.
`

export async function seedDocuments(db: PrismaClient, ctx: Ctx): Promise<void> {
  const existing = await db.documentPackage.findFirst({
    where: { organizationId: ctx.organizationId, name: 'Standard collection package' },
  })
  if (existing) return // idempotent — already seeded

  const reviewer =
    ctx.users.find((u) => u.role === 'SALES_MANAGER') ?? ctx.users.find((u) => u.role === 'ADMIN') ?? ctx.users[0]
  const collector = ctx.users.find((u) => u.role === 'DOCUMENT_COLLECTOR')

  const pkg = await db.documentPackage.create({
    data: {
      organizationId: ctx.organizationId,
      name: 'Standard collection package',
      description: 'Documents needed before a deal can be submitted.',
      isDefault: true,
      requirements: {
        create: [
          {
            key: 'utility_bill',
            name: 'Utility bill',
            category: 'OTHER',
            description: 'A recent electricity bill for the service address.',
            isRequired: true,
            position: 0,
            allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp', 'text/plain'],
            maxSizeMb: 25,
          },
          {
            key: 'government_id',
            name: 'Government ID',
            category: 'IDENTITY',
            description: 'Photo ID for the account holder.',
            isRequired: true,
            position: 1,
            allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp'],
            maxSizeMb: 15,
          },
          {
            key: 'solar_contract',
            name: 'Solar contract',
            category: 'CONTRACT',
            description: 'The signed solar agreement being reviewed.',
            isRequired: true,
            isAttorneyRequired: true,
            position: 2,
            allowedMimeTypes: ['application/pdf', 'text/plain'],
            maxSizeMb: 25,
          },
        ],
      },
    },
    include: { requirements: true },
  })
  const reqByKey = new Map(pkg.requirements.map((r) => [r.key, r]))

  const [clientA, clientB, clientC] = ctx.clientIds
  if (!clientA) return

  // Client A: an open request with an SLA, assigned to the collector when one exists.
  await db.clientDocument.create({
    data: {
      clientId: clientA,
      requirementId: reqByKey.get('government_id')!.id,
      collectorId: collector?.id ?? null,
      status: 'REQUESTED',
      version: 1,
      label: 'Government ID',
      slaDueAt: new Date(Date.now() + 3 * 24 * 3600_000),
    },
  })

  // Client A: a utility bill UNDER_REVIEW with a completed mock extraction —
  // the service address deliberately conflicts with nothing (plain suggestion).
  {
    const key = 'seed-docs-utility-a.bin'
    const { checksum, sizeBytes } = storeFile(key, UTILITY_BILL)
    const doc = await db.clientDocument.create({
      data: {
        clientId: clientA,
        requirementId: reqByKey.get('utility_bill')!.id,
        status: 'UNDER_REVIEW',
        version: 1,
        label: 'Utility bill',
        fileName: 'desert-sun-july.txt',
        storageKey: key,
        mimeType: 'text/plain',
        sizeBytes,
        checksum,
        scanStatus: 'clean',
        receivedAt: new Date(Date.now() - 6 * 3600_000),
      },
    })
    await db.documentExtraction.create({
      data: {
        documentId: doc.id,
        status: 'COMPLETED',
        provider: 'mock',
        detectedTypeKey: 'utility_bill',
        detectedTypeLabel: 'Utility bill',
        typeConfidence: 91,
        pageCount: 1,
        rawText: UTILITY_BILL,
        summary: 'Deterministic (mock) extraction read 5 of 5 utility bill fields from the document text.',
        warnings: [],
        missingFieldKeys: [],
        startedAt: new Date(Date.now() - 6 * 3600_000),
        completedAt: new Date(Date.now() - 6 * 3600_000 + 4000),
        fields: {
          create: [
            { key: 'utility_name', label: 'Utility name', value: 'Desert Sun Power & Electric', confidence: 82, sourcePage: 1, sourceSnippet: 'Desert Sun Power & Electric' },
            { key: 'account_number', label: 'Account number', value: 'DSP-4417-2210', confidence: 92, sourcePage: 1, sourceSnippet: 'Account number: DSP-4417-2210' },
            {
              key: 'service_address',
              label: 'Service address',
              value: '88 Saguaro Court, Mesa AZ',
              confidence: 90,
              sourcePage: 1,
              sourceSnippet: 'Service address: 88 Saguaro Court, Mesa AZ',
              conflictNote: 'Document says "88 Saguaro Court, Mesa AZ" — confirm it matches the client address on file.',
            },
            { key: 'billing_period', label: 'Billing period', value: '2026-07-01 to 2026-07-31', confidence: 88, sourcePage: 1, sourceSnippet: 'Billing period: 2026-07-01 to 2026-07-31' },
            { key: 'amount_due', label: 'Amount due', value: '$221.40', confidence: 92, sourcePage: 1, sourceSnippet: 'Amount due: $221.40' },
          ],
        },
      },
    })
  }

  // Client B: a solar contract fully verified and APPROVED, with review trail.
  if (clientB && reviewer) {
    const key = 'seed-docs-contract-b.bin'
    const { checksum, sizeBytes } = storeFile(key, SOLAR_CONTRACT)
    const doc = await db.clientDocument.create({
      data: {
        clientId: clientB,
        requirementId: reqByKey.get('solar_contract')!.id,
        status: 'APPROVED',
        version: 1,
        label: 'Solar contract',
        fileName: 'brightline-ppa.txt',
        storageKey: key,
        mimeType: 'text/plain',
        sizeBytes,
        checksum,
        scanStatus: 'clean',
        receivedAt: new Date(Date.now() - 2 * 24 * 3600_000),
      },
    })
    const verified = { verification: 'VERIFIED' as const, verifiedById: reviewer.id, verifiedAt: new Date(Date.now() - 24 * 3600_000) }
    await db.documentExtraction.create({
      data: {
        documentId: doc.id,
        status: 'COMPLETED',
        provider: 'mock',
        detectedTypeKey: 'solar_contract',
        detectedTypeLabel: 'Solar contract',
        typeConfidence: 95,
        pageCount: 1,
        rawText: SOLAR_CONTRACT,
        summary: 'Deterministic (mock) extraction read 6 of 6 solar contract fields from the document text.',
        warnings: [],
        missingFieldKeys: [],
        startedAt: new Date(Date.now() - 2 * 24 * 3600_000),
        completedAt: new Date(Date.now() - 2 * 24 * 3600_000 + 4000),
        fields: {
          create: [
            { key: 'installer_name', label: 'Installer', value: 'Brightline Solar LLC', confidence: 90, sourcePage: 1, sourceSnippet: 'Installer: Brightline Solar LLC', ...verified },
            { key: 'contract_date', label: 'Contract date', value: '03/14/2024', confidence: 90, sourcePage: 1, sourceSnippet: 'Contract date: 03/14/2024', ...verified },
            { key: 'system_size_kw', label: 'System size (kW)', value: '7.2', confidence: 85, sourcePage: 1, sourceSnippet: 'System size: 7.2 kW photovoltaic', ...verified },
            { key: 'monthly_payment', label: 'Monthly payment', value: '$189.00', confidence: 92, sourcePage: 1, sourceSnippet: 'Monthly payment: $189.00', ...verified },
            { key: 'term_months', label: 'Term (months)', value: '300', confidence: 90, sourcePage: 1, sourceSnippet: 'Term: 25 years', ...verified },
            { key: 'escalator_pct', label: 'Annual escalator (%)', value: '2.9', confidence: 90, sourcePage: 1, sourceSnippet: 'Escalator: 2.9%', ...verified },
          ],
        },
      },
    })
    await db.documentReview.create({
      data: { documentId: doc.id, reviewerId: reviewer.id, decision: 'APPROVED', reviewedAt: new Date(Date.now() - 23 * 3600_000) },
    })
  }

  // Client C: a scanned-image ID → no OCR in mock mode → MISSING_INFORMATION.
  if (clientC) {
    // Smallest valid PNG (1×1 transparent pixel) — a stand-in for a photo of an ID.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    )
    const key = 'seed-docs-id-c.bin'
    mkdirSync(STORAGE_DIR, { recursive: true })
    writeFileSync(path.join(STORAGE_DIR, key), png)
    const checksum = createHash('sha256').update(png).digest('hex')

    const doc = await db.clientDocument.create({
      data: {
        clientId: clientC,
        requirementId: reqByKey.get('government_id')!.id,
        status: 'MISSING_INFORMATION',
        version: 1,
        label: 'Government ID',
        fileName: 'id-front.png',
        storageKey: key,
        mimeType: 'image/png',
        sizeBytes: png.length,
        checksum,
        scanStatus: 'clean',
        receivedAt: new Date(Date.now() - 26 * 3600_000),
      },
    })
    await db.documentExtraction.create({
      data: {
        documentId: doc.id,
        status: 'COMPLETED',
        provider: 'mock',
        detectedTypeKey: 'government_id',
        detectedTypeLabel: 'Government ID',
        typeConfidence: 55,
        pageCount: 1,
        summary: 'Deterministic (mock) extraction read 0 of 4 government id fields from the document text.',
        warnings: [
          'OCR is not available in mock mode, so this image was not read. Field values must be entered by a reviewer using the Correct action.',
        ],
        missingFieldKeys: ['full_name', 'date_of_birth', 'id_number', 'expiration_date'],
        startedAt: new Date(Date.now() - 26 * 3600_000),
        completedAt: new Date(Date.now() - 26 * 3600_000 + 2000),
        fields: {
          create: [
            { key: 'full_name', label: 'Full name', value: null, confidence: 0 },
            { key: 'date_of_birth', label: 'Date of birth', value: null, confidence: 0 },
            { key: 'id_number', label: 'ID number', value: null, confidence: 0 },
            { key: 'expiration_date', label: 'Expiration date', value: null, confidence: 0 },
          ],
        },
      },
    })
  }
}
