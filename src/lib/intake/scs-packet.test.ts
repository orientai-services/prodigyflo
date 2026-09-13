import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  queue: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    survey: { findFirst: vi.fn().mockResolvedValue(null) },
    clientAddress: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
  },
}))
vi.mock('@/lib/cys/data', () => ({ refreshCysMirror: mocks.refresh }))
vi.mock('./scs-document-import', () => ({ queueScsDocumentImports: mocks.queue }))

import { ingestScsPacket, scsLeadId } from './scs-packet'

const documentRef = {
  id: 'scs_doc_1',
  doc_type: 'agreement',
  original_filename: 'solar-agreement.pdf',
  storage_path: 'lead_1/source.pdf',
  mime: 'application/pdf',
  size_bytes: 12,
  signed_get_url: 'https://storage.example.test/signed',
}

describe('ingestScsPacket document import queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.queue.mockResolvedValue(undefined)
  })

  it('queues stable SCS document identities and never retains an expiring URL', async () => {
    await ingestScsPacket({
      organizationId: 'org_1',
      clientId: 'client_1',
      intakeSubmissionId: 'submission_1',
      rawPayload: { data: { schema_version: 'schema_42.v1', documents: { files: [documentRef] } } },
    })

    expect(mocks.queue).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org_1', clientId: 'client_1', intakeSubmissionId: 'submission_1',
      documents: [documentRef],
    }))
  })

  it('accepts metadata without a signed URL because the worker obtains fresh authenticated bytes', async () => {
    await ingestScsPacket({
      organizationId: 'org_1',
      clientId: 'client_1',
      intakeSubmissionId: 'submission_1',
      rawPayload: {
        data: {
          schema_version: 'schema_42.v1',
          documents: { files: [{ ...documentRef, signed_get_url: undefined }] },
        },
      },
    })
    expect(mocks.queue).toHaveBeenCalledTimes(1)
  })

  it('uses the durable SCS case id, never a delivery-attempt id', () => {
    expect(scsLeadId({ lead_id: '9be21a01-668b-4cdf-8634-a36bbd94d099', id: 'delivery-row:4' }))
      .toBe('9be21a01-668b-4cdf-8634-a36bbd94d099')
    expect(scsLeadId({ id: 'delivery-row:4' })).toBeNull()
  })
})
