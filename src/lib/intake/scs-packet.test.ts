import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
  validateUpload: vi.fn(),
  sha256: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    survey: { findFirst: vi.fn().mockResolvedValue(null) },
    clientAddress: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    clientDocument: {
      findFirst: mocks.findFirst,
      create: mocks.create,
      update: mocks.update,
    },
  },
}))
vi.mock('@/lib/cys/data', () => ({ refreshCysMirror: mocks.refresh }))
vi.mock('@/lib/storage', () => ({ getFileStorage: () => ({ put: mocks.put }) }))
vi.mock('@/lib/extraction/sniff', () => ({
  sha256: mocks.sha256,
  validateUpload: mocks.validateUpload,
}))

import { ingestScsPacket } from './scs-packet'

const documentRef = {
  id: 'scs_doc_1',
  doc_type: 'agreement',
  original_filename: 'solar-agreement.pdf',
  storage_path: 'lead_1/source.pdf',
  mime: 'application/pdf',
  size_bytes: 12,
  signed_get_url: 'https://storage.example.test/signed',
}

describe('ingestScsPacket document retention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findFirst.mockResolvedValue(null)
    mocks.create.mockResolvedValue({ id: 'pf_doc_1' })
    mocks.update.mockResolvedValue({ id: 'pf_doc_1' })
    mocks.put.mockResolvedValue({ key: 'stored-document-key.bin' })
    mocks.validateUpload.mockReturnValue({ ok: true, mimeType: 'application/pdf' })
    mocks.sha256.mockReturnValue('checksum-1')
    mocks.refresh.mockResolvedValue(undefined)
  })

  it('copies the signed SCS document into ProdigyFlo storage instead of retaining its URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(Buffer.from('%PDF-1.7'), {
      status: 200,
      headers: { 'content-length': '8', 'content-type': 'application/pdf' },
    })))

    await ingestScsPacket({
      organizationId: 'org_1',
      clientId: 'client_1',
      rawPayload: { data: { schema_version: 'schema_42.v1', documents: { files: [documentRef] } } },
    })

    expect(mocks.put).toHaveBeenCalledWith(Buffer.from('%PDF-1.7'), {
      fileName: 'solar-agreement.pdf', mimeType: 'application/pdf', clientId: 'client_1',
    })
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientId: 'client_1',
        storageKey: 'stored-document-key.bin',
        checksum: 'checksum-1',
        internalComment: 'scs_path=lead_1/source.pdf\nscs_id=scs_doc_1',
      }),
    })
    expect(JSON.stringify(mocks.create.mock.calls[0][0])).not.toContain('signed_get_url')
  })

  it('refuses a metadata-only document so the SCS outbox can retry it', async () => {
    await expect(ingestScsPacket({
      organizationId: 'org_1',
      clientId: 'client_1',
      rawPayload: {
        data: {
          schema_version: 'schema_42.v1',
          documents: { files: [{ ...documentRef, signed_get_url: undefined }] },
        },
      },
    })).rejects.toThrow('no signed download URL')

    expect(mocks.put).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
