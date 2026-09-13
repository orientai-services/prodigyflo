import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '@/lib/extraction/sniff'

const mocks = vi.hoisted(() => ({
  clientDocumentCreate: vi.fn(),
  importFindMany: vi.fn(),
  importFindFirst: vi.fn(),
  importFindUnique: vi.fn(),
  importUpdate: vi.fn(),
  importUpdateMany: vi.fn(),
  extractionUpdateMany: vi.fn(),
  auditEventCreate: vi.fn(),
  transaction: vi.fn(),
  storagePut: vi.fn(),
  runExtraction: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    clientDocument: { create: mocks.clientDocumentCreate },
    externalDocumentImport: {
      findMany: mocks.importFindMany,
      findFirst: mocks.importFindFirst,
      findUnique: mocks.importFindUnique,
      update: mocks.importUpdate,
      updateMany: mocks.importUpdateMany,
    },
    documentExtraction: { updateMany: mocks.extractionUpdateMany },
    auditEvent: { create: mocks.auditEventCreate },
    $transaction: mocks.transaction,
  },
}))
vi.mock('@/lib/storage', () => ({
  getFileStorage: () => ({ put: mocks.storagePut }),
}))
vi.mock('@/lib/extraction/run', () => ({ runExtraction: mocks.runExtraction }))

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
}

function transactionOperation(kind: string, args: unknown) {
  return { kind, args }
}

describe('runPendingScsDocumentImports', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SCS_DOCUMENT_EXPORT_BASE_URL = 'https://scs.example.test'
    process.env.SCS_DOCUMENT_EXPORT_TOKEN = 'test-token'
    mocks.importFindMany.mockResolvedValue([{ id: row.id }])
    mocks.importFindFirst.mockResolvedValue(null)
    mocks.importUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 })
    mocks.importFindUnique.mockResolvedValue(row)
    mocks.clientDocumentCreate.mockImplementation((args) => transactionOperation('document', args))
    mocks.importUpdate.mockImplementation((args) => transactionOperation('import', args))
    mocks.auditEventCreate.mockImplementation((args) => transactionOperation('audit', args))
    mocks.transaction.mockResolvedValue([])
    mocks.storagePut.mockResolvedValue({ key: 'private/client_1/imported.pdf' })
    mocks.runExtraction.mockResolvedValue(undefined)
    mocks.extractionUpdateMany.mockResolvedValue({ count: 0 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, {
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(bytes.length),
        'x-scs-document-id': row.sourceDocumentId,
        'x-scs-sha256': checksum,
      },
    })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.SCS_DOCUMENT_EXPORT_BASE_URL
    delete process.env.SCS_DOCUMENT_EXPORT_TOKEN
  })

  it('atomically persists a document, ledger update, and audit event with one generated ID', async () => {
    await expect(runPendingScsDocumentImports()).resolves.toEqual({ attempted: 1, imported: 1, failed: 0, skipped: 0 })

    const operations = mocks.transaction.mock.calls[0][0]
    expect(operations).toHaveLength(3)
    const documentId = operations[0].args.data.id
    expect(documentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(operations[1].args.data).toMatchObject({
      status: 'IMPORTED', clientDocumentId: documentId, sourceChecksum: checksum, importedChecksum: checksum,
    })
    expect(operations[2].args.data.entityId).toBe(documentId)
    expect(mocks.runExtraction).toHaveBeenCalledWith(documentId)
  })

  it('retains a persistence-stage error on the retryable import row', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('database transaction failed'))

    await expect(runPendingScsDocumentImports()).resolves.toEqual({ attempted: 1, imported: 0, failed: 1, skipped: 0 })

    expect(mocks.importUpdateMany).toHaveBeenLastCalledWith({
      where: { id: row.id, status: 'IMPORTING' },
      data: {
        status: 'FAILED',
        lastError: 'SCS import failed while persisting the imported document: database transaction failed',
      },
    })
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
          status: { notIn: ['APPROVED', 'REJECTED'] },
          AND: expect.arrayContaining([
            expect.objectContaining({ extractions: { none: { provider: 'anthropic', status: { in: ['COMPLETED', 'RUNNING'] } } } }),
          ]),
        }),
      }),
      orderBy: { createdAt: 'desc' },
      take: 5,
    }))
    expect(mocks.extractionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ provider: 'anthropic', status: 'RUNNING' }),
      data: expect.objectContaining({ status: 'FAILED' }),
    }))
    expect(mocks.runExtraction).toHaveBeenNthCalledWith(1, 'document_1')
    expect(mocks.runExtraction).toHaveBeenNthCalledWith(2, 'document_2')
  })

  it('does not queue the same durable SCS source document twice', async () => {
    mocks.importFindFirst.mockResolvedValueOnce({ id: 'already-queued' })

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
