import { describe, it, expect } from 'vitest'
import { classifyInbound } from '@/lib/inbound/classify'
import { buildInboundDocumentUpsert } from '@/lib/inbound/record'

const ids = { organizationId: 'org_1', sourceId: 'src_1', clientId: 'client_9' }
const NOW = new Date('2026-08-25T12:00:00.000Z')

describe('buildInboundDocumentUpsert', () => {
  it('maps a GHL document-status payload into a keyed upsert', () => {
    const payload = {
      event_type: 'document.status',
      contact_id: 'aBc123',
      document_id: 'doc_777',
      document_name: 'Signed PPA',
      document_status: 'completed',
      document_note: 'Homeowner e-signed',
      document_url: 'https://files.example.com/doc_777.pdf',
    }
    const classified = classifyInbound(payload)
    expect(classified.category).toBe('DOCUMENT')

    const upsert = buildInboundDocumentUpsert(classified, ids, NOW)
    expect(upsert).not.toBeNull()
    expect(upsert!.where).toEqual({
      organizationId_externalId: { organizationId: 'org_1', externalId: 'doc_777' },
    })
    expect(upsert!.create).toEqual({
      organizationId: 'org_1',
      sourceId: 'src_1',
      clientId: 'client_9',
      externalId: 'doc_777',
      name: 'Signed PPA',
      status: 'completed',
      note: 'Homeowner e-signed',
      url: 'https://files.example.com/doc_777.pdf',
      receivedAt: NOW,
    })
    // Repeated pushes update the same row; clientId is filled, never blanked.
    expect(upsert!.update).toMatchObject({
      name: 'Signed PPA',
      status: 'completed',
      clientId: 'client_9',
      receivedAt: NOW,
    })
  })

  it('does not fill clientId on update when the submission is unmatched', () => {
    const payload = { document_id: 'doc_1', document_name: 'W-9', document_status: 'received' }
    const classified = classifyInbound(payload)
    const upsert = buildInboundDocumentUpsert(classified, { ...ids, clientId: null }, NOW)
    expect(upsert!.create.clientId).toBeNull()
    expect('clientId' in (upsert!.update as object)).toBe(false)
  })

  it('yields no document for a plain contact payload', () => {
    const payload = {
      contact_id: 'aBc123',
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane@example.com',
    }
    const classified = classifyInbound(payload)
    expect(classified.category).toBe('CONTACT')
    expect(classified.document).toBeNull()
    expect(buildInboundDocumentUpsert(classified, ids, NOW)).toBeNull()
  })
})
