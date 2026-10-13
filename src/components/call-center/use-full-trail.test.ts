import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/call-center/actions', () => ({ loadLeadTrail: vi.fn() }))
const { mergeTrail } = await import('./use-full-trail')

const ev = (kind: 'call' | 'note' | 'lock', at: string, detail = '') => ({ kind, at, label: kind, detail })

describe('mergeTrail', () => {
  const full = [ev('lock', '2026-09-01T10:00:00.000Z'), ev('call', '2026-10-01T10:00:00.000Z'), ev('note', '2026-10-12T10:00:00.000Z', 'Roof')]

  it('is the whole trail when the trimmed one adds nothing', () => {
    expect(mergeTrail(full, [full[2]])).toEqual(full)
  })

  it('keeps what the desk added after the read, in time order', () => {
    const added = ev('note', '2026-10-13T09:00:00.000Z', 'Call after 5')
    expect(mergeTrail(full, [full[2], added])).toEqual([...full, added])
  })

  it('keeps two identical lines when both happened', () => {
    const twice = ev('call', '2026-10-13T09:00:00.000Z')
    expect(mergeTrail([...full, twice], [twice, twice])).toHaveLength(5)
  })
})
