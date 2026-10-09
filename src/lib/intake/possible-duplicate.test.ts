import { describe, it, expect, vi } from 'vitest'
import { flagPossibleDuplicate, matchPossibleDuplicate } from './possible-duplicate'

const sep21 = { id: 'cmuc64nyj002j04l8n98g6j35', firstName: 'Daryl', lastName: 'Schelin', email: 'd.s@example.test', phone: '(702) 555-0142' }
const incoming = { firstName: 'daryl ', lastName: 'SCHELIN', email: 'other@example.test', phone: '+1 702-555-0142' }

describe('SCS possible-duplicate rule', () => {
  it('matches the same normalized name plus phone digits', () => {
    expect(matchPossibleDuplicate(incoming, [sep21])).toEqual({ clientId: sep21.id, matchedOn: 'name+phone' })
  })
  it('matches the same name plus email when the phone differs', () => {
    expect(matchPossibleDuplicate({ ...incoming, phone: '7025550000', email: 'D.S@example.test' }, [sep21])).toEqual({ clientId: sep21.id, matchedOn: 'name+email' })
  })
  it('never matches on name alone or contact alone', () => {
    expect(matchPossibleDuplicate({ ...incoming, phone: '7025550000' }, [sep21])).toBeNull()
    expect(matchPossibleDuplicate({ ...incoming, firstName: 'Darryl' }, [sep21])).toBeNull()
  })
})

describe('flagPossibleDuplicate', () => {
  it('only writes an internal note on the new client; never updates or deletes', async () => {
    const store = { client: { findMany: vi.fn().mockResolvedValue([sep21]), update: vi.fn(), delete: vi.fn() }, note: { create: vi.fn() } }
    const hit = await flagPossibleDuplicate(store as never, { id: 'cmv1hr24c000106l9h9zzjw8m', organizationId: 'org', ...incoming })
    expect(hit?.clientId).toBe(sep21.id)
    expect(store.note.create).toHaveBeenCalledWith({ data: expect.objectContaining({ clientId: 'cmv1hr24c000106l9h9zzjw8m', isInternal: true, body: expect.stringContaining(sep21.id) }) })
    expect(store.client.update).not.toHaveBeenCalled()
    expect(store.client.delete).not.toHaveBeenCalled()
    expect(store.client.findMany.mock.calls[0][0].where.id).toEqual({ not: 'cmv1hr24c000106l9h9zzjw8m' })
  })
  it('does nothing when there is no candidate', async () => {
    const store = { client: { findMany: vi.fn().mockResolvedValue([]) }, note: { create: vi.fn() } }
    expect(await flagPossibleDuplicate(store as never, { id: 'x', organizationId: 'org', ...incoming })).toBeNull()
    expect(store.note.create).not.toHaveBeenCalled()
  })
})
