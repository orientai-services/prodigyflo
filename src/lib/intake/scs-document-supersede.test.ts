import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/storage', () => ({ getFileStorage: () => ({}) }))
vi.mock('@/lib/extraction/run', () => ({ runExtraction: vi.fn() }))
vi.mock('./scs-document-requirements', () => ({ scsRequirementId: vi.fn() }))
vi.mock('./scs-analysis', () => ({ materializeScsAnalysis: vi.fn() }))

import { retireSupersededScsDocuments } from './scs-document-import'

function store() {
  return {
    externalDocumentImport: { findMany: vi.fn() },
    clientDocument: { updateMany: vi.fn(async () => ({ count: 1 })) },
    documentExtraction: { updateMany: vi.fn(async () => ({ count: 1 })) },
    auditEvent: { create: vi.fn() },
  }
}
const base = { organizationId: 'org_1', clientId: 'client_1', sourceLeadId: 'lead_1' }

describe('retireSupersededScsDocuments', () => {
  let s: ReturnType<typeof store>
  beforeEach(() => { s = store() })

  it('retires the old copy of a replaced SCS file on the same tile', async () => {
    s.externalDocumentImport.findMany.mockResolvedValue([{ clientDocumentId: 'doc_old', sourceDocumentId: 'scs_old', sourceDocumentType: 'agreement' }])
    const n = await retireSupersededScsDocuments({ ...base, documents: [{ id: 'scs_new', doc_type: 'agreement' } as never] }, s as never)
    expect(n).toBe(1)
    const where = s.externalDocumentImport.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ sourceLeadId: 'lead_1', clientId: 'client_1', status: 'IMPORTED', sourceDocumentType: { in: ['agreement'] }, sourceDocumentId: { notIn: ['scs_new'] } })
    expect(s.clientDocument.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'EXPIRED' } }))
    expect(s.documentExtraction.updateMany).toHaveBeenCalledWith({ where: { documentId: { in: ['doc_old'] } }, data: { sourceActive: false } })
    expect(s.auditEvent.create).toHaveBeenCalled()
  })

  it('does nothing without a lead id or an empty packet', async () => {
    expect(await retireSupersededScsDocuments({ ...base, sourceLeadId: null, documents: [{ id: 'x', doc_type: 'agreement' } as never] }, s as never)).toBe(0)
    expect(await retireSupersededScsDocuments({ ...base, documents: [] }, s as never)).toBe(0)
    expect(s.externalDocumentImport.findMany).not.toHaveBeenCalled()
  })

  it('leaves other tiles alone when nothing is stale', async () => {
    s.externalDocumentImport.findMany.mockResolvedValue([])
    expect(await retireSupersededScsDocuments({ ...base, documents: [{ id: 'scs_bill', doc_type: 'utility_bill' } as never] }, s as never)).toBe(0)
    expect(s.clientDocument.updateMany).not.toHaveBeenCalled()
  })
})
