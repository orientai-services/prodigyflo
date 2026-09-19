import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '@/lib/extraction/sniff'

const mocks = vi.hoisted(() => ({
  clientDocumentCreate: vi.fn(),
  clientDocumentFindFirst: vi.fn(),
  clientDocumentUpdateMany: vi.fn(),
  importFindMany: vi.fn(),
  importFindFirst: vi.fn(),
  importFindUnique: vi.fn(),
  importUpdate: vi.fn(),
  importUpdateMany: vi.fn(),
  extractionUpdateMany: vi.fn(),
  extractionGroupBy: vi.fn(),
  auditEventCreate: vi.fn(),
  transaction: vi.fn(),
  storagePut: vi.fn(),
  storageDelete: vi.fn(),
  queryRaw: vi.fn(),
  runExtraction: vi.fn(),
  scsRequirementId: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    clientDocument: { create: mocks.clientDocumentCreate, findFirst: mocks.clientDocumentFindFirst, updateMany: mocks.clientDocumentUpdateMany },
    externalDocumentImport: {
      findMany: mocks.importFindMany,
      findFirst: mocks.importFindFirst,
      findUnique: mocks.importFindUnique,
      update: mocks.importUpdate,
      updateMany: mocks.importUpdateMany,
    },
    documentExtraction: { updateMany: mocks.extractionUpdateMany, groupBy: mocks.extractionGroupBy },
    auditEvent: { create: mocks.auditEventCreate },
    $transaction: mocks.transaction,
    $queryRaw: mocks.queryRaw,
  },
}))
vi.mock('@/lib/storage', () => ({
  getFileStorage: () => ({ put: mocks.storagePut, delete: mocks.storageDelete }),
}))
vi.mock('@/lib/extraction/run', () => ({ runExtraction: mocks.runExtraction }))
vi.mock('./scs-document-requirements', () => ({ scsRequirementId: mocks.scsRequirementId }))

import { db } from '@/lib/db'
import { queueScsDocumentImports, runPendingScsDocumentExtractions, runPendingScsDocumentImports } from './scs-document-import'

const bytes = Buffer.from('%PDF-1.4\nQA document\n')
const checksum = sha256(bytes)
const row = {
  id: 'import_1',
  organizationId: 'org_1',
  clientId: 'client_1',
  sourceDocumentId: 'scs_document_1',
  sourceLeadId: 'lead_1',
  sourceFileName: 'qa-document.pdf',
  sourceDocumentType: 'agreement',
  sourceMimeType: 'application/pdf',
  attempts: 1,
}

function transactionOperation(kind: string, args: unknown) {
  return { kind, args }
}

describe('runPendingScsDocumentImports', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    process.env.SCS_DOCUMENT_EXPORT_BASE_URL = 'https://scs.example.test'
    process.env.SCS_DOCUMENT_EXPORT_TOKEN = 'test-token'
    mocks.importFindMany.mockResolvedValue([{ id: row.id }])
    mocks.importFindFirst.mockResolvedValue(null)
    mocks.importUpdateMany.mockResolvedValue({ count: 1 })
    mocks.importFindUnique.mockResolvedValue(row)
    mocks.clientDocumentCreate.mockImplementation((args) => transactionOperation('document', args))
    mocks.clientDocumentFindFirst.mockResolvedValue(null)
    mocks.importUpdate.mockImplementation((args) => transactionOperation('import', args))
    mocks.auditEventCreate.mockImplementation((args) => transactionOperation('audit', args))
    mocks.transaction.mockImplementation(async fn => fn(db))
    mocks.queryRaw.mockResolvedValue([{ id: row.id }])
    mocks.storageDelete.mockResolvedValue(undefined)
    mocks.storagePut.mockResolvedValue({ key: 'private/client_1/imported.pdf' })
    mocks.runExtraction.mockResolvedValue(undefined)
    mocks.scsRequirementId.mockResolvedValue('requirement_1')
    mocks.extractionUpdateMany.mockResolvedValue({ count: 0 })
    mocks.extractionGroupBy.mockResolvedValue([])
    mocks.clientDocumentUpdateMany.mockResolvedValue({ count: 1 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, {
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(bytes.length),
        'x-scs-document-id': row.sourceDocumentId,
        'x-scs-lead-id': row.sourceLeadId,
        'x-scs-sha256': checksum,
      },
    })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    delete process.env.SCS_DOCUMENT_EXPORT_BASE_URL
    delete process.env.SCS_DOCUMENT_EXPORT_TOKEN
    delete process.env.SCS_DOCUMENT_IMPORTS_PAUSED
    delete process.env.SCS_IMPORT_EXECUTION_COHORT
    delete process.env.SCS_IMPORT_REQUIRE_COHORT
    delete process.env.SCS_VERCEL_PROTECTION_BYPASS
  })

  it('atomically persists a document, ledger update, and audit event with one generated ID', async () => {
    await expect(runPendingScsDocumentImports()).resolves.toEqual({ attempted: 1, imported: 1, failed: 0, skipped: 0 })

    expect(mocks.transaction).toHaveBeenCalledOnce()
    const operations = [mocks.clientDocumentCreate, mocks.importUpdate, mocks.auditEventCreate].map(mock => ({ args: mock.mock.calls[0][0] }))
    const documentId = operations[0].args.data.id
    expect(documentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(operations[1].args.data).toMatchObject({
      status: 'IMPORTED', clientDocumentId: documentId, sourceChecksum: checksum, importedChecksum: checksum,
    })
    expect(operations[0].args.data.requirementId).toBe('requirement_1')
    expect(operations[2].args.data.entityId).toBe(documentId)
    expect(mocks.runExtraction).not.toHaveBeenCalled()
  })

  it('retains a persistence-stage error on the retryable import row', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('database transaction failed'))

    await expect(runPendingScsDocumentImports()).resolves.toEqual({ attempted: 1, imported: 0, failed: 1, skipped: 0 })

    expect(mocks.storageDelete).toHaveBeenCalledWith('private/client_1/imported.pdf')
    expect(mocks.importUpdateMany).toHaveBeenLastCalledWith({
      where: { id: row.id, status: 'IMPORTING', attempts: 1 },
      data: {
        status: 'FAILED',
        lastError: 'SCS import failed while persisting the imported document: database transaction failed',
      },
    })
  })

  it('suppresses a queued duplicate after the source document is already imported', async () => {
    mocks.importFindFirst.mockResolvedValueOnce({ id: 'imported-first' })

    await expect(runPendingScsDocumentImports()).resolves.toEqual({ attempted: 1, imported: 0, failed: 0, skipped: 1 })

    expect(mocks.importUpdate).toHaveBeenCalledWith({
      where: { id: row.id },
      data: {
        status: 'FAILED',
        attempts: 8,
        lastError: 'Duplicate SCS source document; already imported by ledger row imported-first.',
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('imports one cohort-approved case while the normal worker remains paused', async () => {
    const leadId = '11111111-1111-4111-8111-111111111111'
    const documentId = '22222222-2222-4222-8222-222222222222'
    process.env.SCS_DOCUMENT_IMPORTS_PAUSED = 'true'
    process.env.SCS_IMPORT_EXECUTION_COHORT = JSON.stringify({
      mode: 'synthetic',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      organizationId: row.organizationId,
      sourceId: 'scs_source_1',
      cases: [{ leadId, documentIds: [documentId] }],
    })
    mocks.importFindUnique.mockResolvedValue({ ...row, sourceLeadId: leadId, sourceDocumentId: documentId })
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(bytes, {
      headers: {
        'content-type': 'application/pdf', 'content-length': String(bytes.length),
        'x-scs-document-id': documentId, 'x-scs-lead-id': leadId, 'x-scs-sha256': checksum,
      },
    }))

    await expect(runPendingScsDocumentImports()).resolves.toEqual({ attempted: 0, imported: 0, failed: 0, skipped: 0 })
    await expect(runPendingScsDocumentImports(1, { leadId, documentId })).resolves.toEqual({ attempted: 1, imported: 1, failed: 0, skipped: 0 })
    expect(mocks.importFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        organizationId: row.organizationId,
        OR: [{ sourceLeadId: leadId, sourceDocumentId: { in: [documentId] } }],
      }),
      take: 1,
    }))
  })

  it('never selects archived imports for a normal worker run', async () => {
    mocks.importFindMany.mockResolvedValueOnce([])

    await expect(runPendingScsDocumentImports()).resolves.toEqual({ attempted: 0, imported: 0, failed: 0, skipped: 0 })

    expect(mocks.importFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['PENDING', 'FAILED'] } }),
    }))
  })

  it('reprocesses only eligible imported SCS documents through the append-only extractor', async () => {
    mocks.importFindMany.mockResolvedValue([{ clientDocumentId: 'document_1' }, { clientDocumentId: 'document_2' }])
    mocks.runExtraction
      .mockResolvedValueOnce({ status: 'COMPLETED' })
      .mockResolvedValueOnce({ status: 'FAILED' })

    await expect(runPendingScsDocumentExtractions()).resolves.toEqual({ attempted: 2, completed: 1, failed: 1, skipped: 0 })

    expect(mocks.importFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'IMPORTED',
        clientDocument: expect.objectContaining({
          status: { notIn: ['APPROVED', 'REJECTED', 'PROCESSING'] },
          AND: expect.arrayContaining([
            expect.objectContaining({ extractions: { none: { provider: 'anthropic', status: 'COMPLETED' } } }),
          ]),
        }),
      }),
      orderBy: { createdAt: 'desc' },
      take: 5,
    }))
    expect(mocks.extractionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ provider: 'anthropic', OR: expect.arrayContaining([expect.objectContaining({ status: 'RUNNING' })]) }),
      data: expect.objectContaining({ status: 'FAILED' }),
    }))
    expect(mocks.runExtraction).toHaveBeenNthCalledWith(1, 'document_1')
    expect(mocks.runExtraction).toHaveBeenNthCalledWith(2, 'document_2')
  })

  it('retains application authentication when crossing protected preview middleware', async () => {
    process.env.SCS_VERCEL_PROTECTION_BYPASS = 'preview-test-secret'
    await runPendingScsDocumentImports()
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: { 'X-SCS-Export-Token': 'test-token', 'x-vercel-protection-bypass': 'preview-test-secret' },
      redirect: 'error',
    }))
    expect(mocks.storagePut).toHaveBeenCalledOnce()
  })

  it('does not run an extraction already claimed by another worker', async () => {
    mocks.importFindMany.mockResolvedValue([{ clientDocumentId: 'document_1' }])
    mocks.clientDocumentUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 })
    expect(await runPendingScsDocumentExtractions()).toEqual({ attempted: 1, completed: 0, failed: 0, skipped: 1 })
    expect(mocks.runExtraction).not.toHaveBeenCalled()
  })

  it('honors the import pause for the extraction worker too', async () => {
    process.env.SCS_DOCUMENT_IMPORTS_PAUSED = 'true'
    expect(await runPendingScsDocumentExtractions()).toEqual({ attempted: 0, completed: 0, failed: 0, skipped: 0 })
    expect(mocks.extractionUpdateMany).not.toHaveBeenCalled()
    expect(mocks.runExtraction).not.toHaveBeenCalled()
  })

  it('does not silently use the mock in the automated live extraction worker', async () => {
    vi.stubEnv('AI_PROVIDER', 'mock')
    expect(await runPendingScsDocumentExtractions()).toMatchObject({ attempted: 0, blockedReason: expect.stringMatching(/live Anthropic/) })
    expect(mocks.runExtraction).not.toHaveBeenCalled()
  })

  it('persists a second agreement when the solar_contract slot is already filled', async () => {
    mocks.clientDocumentFindFirst.mockResolvedValueOnce({ id: 'existing-agreement' })
    mocks.importFindUnique.mockResolvedValue({
      ...row,
      id: 'import_amendment',
      sourceDocumentId: 'scs_document_amendment',
      sourceFileName: 'Agreement Amendment.pdf',
    })
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(bytes, {
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(bytes.length),
        'x-scs-document-id': 'scs_document_amendment',
        'x-scs-lead-id': row.sourceLeadId,
        'x-scs-sha256': checksum,
      },
    }))

    await expect(runPendingScsDocumentImports()).resolves.toEqual({ attempted: 1, imported: 1, failed: 0, skipped: 0 })

    expect(mocks.clientDocumentCreate).toHaveBeenCalledOnce()
    expect(mocks.clientDocumentCreate.mock.calls[0][0].data.requirementId).toBeNull()
    expect(mocks.clientDocumentCreate.mock.calls[0][0].data.fileName).toBe('Agreement Amendment.pdf')
    expect(mocks.clientDocumentCreate.mock.calls[0][0].data.label).toBe('Agreement Amendment.pdf')
  })

  it('does not queue the same durable SCS source document twice', async () => {
    mocks.importFindFirst.mockResolvedValueOnce({ id: 'already-queued', clientId: 'client_1', sourceLeadId: 'lead_1' })

    await queueScsDocumentImports({
      organizationId: 'org_1',
      clientId: 'client_1',
      intakeSubmissionId: 'submission_2',
      sourceLeadId: 'lead_1',
      documents: [{ id: row.sourceDocumentId }],
    })

    expect(mocks.importUpdate).not.toHaveBeenCalled()
  })
})
