import { describe, expect, it } from 'vitest'
import { parseInstagramEvents } from './instagram'

const BIZ = '17841400000000000'

describe('parseInstagramEvents', () => {
  it('parses a Direct Message', () => {
    const ev = parseInstagramEvents({
      object: 'instagram',
      entry: [{ id: BIZ, messaging: [{ sender: { id: '6123' }, recipient: { id: BIZ }, message: { mid: 'm1', text: 'Interested in solar' } }] }],
    })
    expect(ev).toEqual([{ kind: 'dm', igsid: '6123', text: 'Interested in solar', eventId: 'm1' }])
  })

  it('parses a comment and keeps the username', () => {
    const ev = parseInstagramEvents({
      object: 'instagram',
      entry: [{ id: BIZ, changes: [{ field: 'comments', value: { id: 'c1', text: 'How much?', from: { id: '6123', username: 'jane_doe' } } }] }],
    })
    expect(ev).toEqual([{ kind: 'comment', igsid: '6123', username: 'jane_doe', text: 'How much?', eventId: 'c1' }])
  })

  it('tags a story reply', () => {
    const ev = parseInstagramEvents({
      object: 'instagram',
      entry: [{ id: BIZ, messaging: [{ sender: { id: '6123' }, message: { mid: 'm2', text: '🔥', reply_to: { story: { id: 's1' } } } }] }],
    })
    expect(ev[0].kind).toBe('story')
  })

  it('ignores our own echoes and messages from the business account itself', () => {
    const ev = parseInstagramEvents({
      object: 'instagram',
      entry: [
        { id: BIZ, messaging: [{ sender: { id: '6123' }, message: { mid: 'e1', text: 'hi', is_echo: true } }] },
        { id: BIZ, messaging: [{ sender: { id: BIZ }, message: { mid: 'e2', text: 'hi' } }] },
      ],
    })
    expect(ev).toEqual([])
  })

  it('skips empty text, unhandled change fields, and the business own comments', () => {
    const ev = parseInstagramEvents({
      object: 'instagram',
      entry: [
        { id: BIZ, messaging: [{ sender: { id: '6123' }, message: { mid: 'm3', text: '   ' } }] },
        { id: BIZ, changes: [{ field: 'mentions', value: { id: 'x', text: 'nope', from: { id: '9' } } }] },
        { id: BIZ, changes: [{ field: 'comments', value: { id: 'c9', text: 'our own reply', from: { id: BIZ, username: 'scs' } } }] },
      ],
    })
    expect(ev).toEqual([])
  })

  it('caps a hostile oversized delivery', () => {
    const messaging = Array.from({ length: 5000 }, (_, i) => ({ sender: { id: 'u' + i }, message: { mid: 'm' + i, text: 'hi' } }))
    const ev = parseInstagramEvents({ object: 'instagram', entry: [{ id: BIZ, messaging }] })
    expect(ev.length).toBeLessThanOrEqual(200)
  })
})
