import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'

const mock = vi.hoisted(() => ({ db: {} as Record<string, unknown> }))
vi.mock('@/lib/db', () => ({ db: mock.db }))
vi.mock('@/lib/rbac', () => ({ findClientInScope: vi.fn().mockResolvedValue({ id: 'client' }), ForbiddenError: class extends Error {} }))
import { materializeScsAnalysis } from './scs-analysis'
import { hash } from './analysis-contract'
import { resolveForClient } from '@/lib/cys/data'
import type { SessionUser } from '@/lib/rbac'

function fixture() {
  const identity = { first_name: 'example', last_name: 'person', address_line1: '1 test st', city: 'las vegas', state: 'nv', zip: '89101' }
  const client = { id: 'client', firstName: 'Example', lastName: 'Person', email: 'example@example.test', phone: '7025550100', preferredLanguage: 'en', addresses: [{ line1: '1 Test St', line2: null, city: 'Las Vegas', state: 'NV', postalCode: '89101' }] }
  const source = { documentId: 'doc', sha256: 'a'.repeat(64), fields: {}, classification: ['loan'], readableAgreement: true, clientMatch: 'matched', coverage: { complete: true, totalPages: 9, processedPages: 9 }, runs: ['new-run'], reviewDecisions: {}, manifestId: 'manifest', manifest_version: 1, evidence_revision: 2, identity_fingerprint: hash(identity) }
  const receipt = { id: 'receipt', organizationId: 'org', clientId: 'client', clientDocumentId: 'doc', clientDocument: { checksum: source.sha256 }, sourceAnalysis: source, analysisIdentity: hash(source), analysisPending: true, analysisAttempts: 0 }
  const old = { id: 'old', sourceIdentity: 'old-identity', status: 'COMPLETED', sourceActive: true, detectedTypeKey: 'finance_agreement', fields: [{ id: 'old-account', key: 'account_number', value: '74045', correctedValue: null, verification: 'UNVERIFIED', confidence: 90, sourcePage: 1 }] }
  const extractions: Array<Record<string, unknown>> = [old]
  const definition = { key: 'account_number', label: 'Account number', groupName: 'GX', position: 28, isRequired: false, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.finance_agreement.account_number' }
  const saved: Array<Record<string, unknown>> = [{ id: 'mirror', clientId: 'client', fieldKey: 'account_number', value: '74045', status: 'SUGGESTED', verifiedById: null }]
  Object.assign(mock.db, {
    externalDocumentImport: {
      findMany: vi.fn().mockResolvedValue([receipt]), findUniqueOrThrow: vi.fn().mockImplementation(async () => receipt),
      update: vi.fn().mockImplementation(async ({ data }) => Object.assign(receipt, data)), updateMany: vi.fn(),
    },
    client: { findUniqueOrThrow: vi.fn().mockResolvedValue(client), findMany: vi.fn().mockResolvedValue([client]) },
    documentExtraction: {
      updateMany: vi.fn().mockImplementation(async () => { old.sourceActive = false }),
      upsert: vi.fn().mockImplementation(async ({ create }) => { extractions.unshift({ ...create, sourceActive: true, fields: create.fields.create }) }),
    },
    clientDocument: {
      updateMany: vi.fn(), findMany: vi.fn().mockImplementation(async () => [{ id: 'doc', clientId: 'client', fileName: 'test.pdf', label: null, status: 'RECEIVED', storageKey: 'original', requirement: { key: 'finance_agreement', name: 'Finance agreement' }, extractions }]),
    },
    surveyResponse: { findMany: vi.fn().mockResolvedValue([]) },
    cysFieldDefinition: { findMany: vi.fn().mockResolvedValue([definition]) },
    cysFieldValue: { findMany: vi.fn().mockImplementation(async () => saved) },
    cysReadiness: { findUnique: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn(), $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn().mockImplementation(async callback => callback(mock.db)),
  })
  return { old, source, saved, extractions }
}

beforeEach(() => { for (const key of Object.keys(mock.db)) delete mock.db[key] })

describe('SCS materialization refreshes current CYS evidence', () => {
  it('writes a missing-account mirror update after the newer evidence omits a prior automatic account', async () => {
    const f = fixture()
    expect(await materializeScsAnalysis(1, { clientId: 'client' })).toEqual({ applied: 1, failed: 0 })
    expect(f.old.sourceActive).toBe(false)
    expect(f.old.fields[0].value).toBe('74045') // Immutable audit history remains.
    expect(f.extractions[0].sourceEvidence).toEqual(f.source)
    const sql = mock.db.$executeRaw.mock.calls[0][0] as Prisma.Sql
    // Actual refreshCysMirror generated this row from the committed evidence.
    expect(sql.values.slice(1, 5)).toEqual(['client', 'account_number', null, 'MISSING'])
    expect(sql.sql).toContain('WHERE NOT ("CysFieldValue".status=\'VERIFIED\' AND "CysFieldValue"."verifiedById" IS NOT NULL)')
    expect(mock.db.$executeRaw.mock.invocationCallOrder[0]).toBeGreaterThan(mock.db.documentExtraction.upsert.mock.invocationCallOrder[0])
  })

  it('retains a staff account override in the live projection while refresh SQL protects that row', async () => {
    const f = fixture()
    Object.assign(f.saved[0], { value: 'STAFF-CORRECTED', status: 'VERIFIED', verifiedById: 'staff' })
    await materializeScsAnalysis(1, { clientId: 'client' })
    const result = await resolveForClient({ organizationId: 'org' } as SessionUser, 'client')
    expect(result.values[0]).toMatchObject({ value: 'STAFF-CORRECTED', status: 'VERIFIED', verifiedById: 'staff' })
    const sql = mock.db.$executeRaw.mock.calls[0][0] as Prisma.Sql
    expect(sql.sql).toContain('"verifiedById" IS NOT NULL')
  })
})
