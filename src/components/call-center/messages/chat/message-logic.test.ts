import { describe, expect, it } from 'vitest'
import {
  EMOJI,
  QUICK,
  canDeleteMessage,
  canEditMessage,
  canPinMessage,
  counter,
  dividerId,
  draftKey,
  enterSends,
  firstAttempt,
  fitsAlready,
  groupsWith,
  isAllowedFile,
  isJumbo,
  mentionAt,
  mentionItems,
  nextAttempt,
  nextRate,
  pickedMentions,
  readRate,
  receiptTarget,
  receiptText,
  recompressible,
  scaled,
  seenOf,
  segments,
  tickFor,
  voiceFileName,
  waveBars,
  waveOf,
} from './message-logic'
import { strings } from './strings'
import type { Message } from './types'

/** The message list and composer rules ported from SunOff Chat (TEAM_CHAT_PARITY C1–D5). */

const at = Date.UTC(2026, 9, 13, 17, 0, 0)
const msg = (id: string, uid: string, created: number, o: Partial<Message> = {}): Message => ({
  id, channel: 'c_1', uid, name: uid === 'u1' ? 'Ada Admin' : 'Gatsby Rep', body: 'hi', kind: 'message', parent_id: null, reply_count: 0, edited_at: null,
  deleted: false, pinned: false, attachments: [], mentions: [], reactions: {}, created_at: created, ...o,
})
const me = { uid: 'u1', staff: false }
const staff = { uid: 'u9', staff: true }

describe('emoji sets', () => {
  // The contract says 62; SunOff's list (public/index.html EMOJI) has 61 distinct, and this is that list verbatim.
  it('match SunOff: 6 quick reactions and the picker list that starts with them', () => {
    expect([...QUICK]).toEqual(['👍', '✅', '🔥', '🙏', '😂', '❤️'])
    expect(EMOJI).toHaveLength(61)
    expect(EMOJI.slice(0, 6)).toEqual([...QUICK])
    expect(new Set(EMOJI).size).toBe(61)
  })
})

describe('message text', () => {
  it('shows short emoji-only messages big, never digits or text', () => {
    expect(isJumbo('🔥')).toBe(true)
    expect(isJumbo(' 👍👍 ')).toBe(true)
    expect(isJumbo('❤️')).toBe(true)
    expect(isJumbo('ok 👍')).toBe(false)
    expect(isJumbo('123')).toBe(false)
    expect(isJumbo('#')).toBe(false)
    expect(isJumbo('😀'.repeat(9))).toBe(false)
  })

  it('splits links (trailing punctuation stays text) and mentions (longest name first, mine marked)', () => {
    const s = segments('See https://x.com/a?b=1. @Ana Maria and @Ana, @todos', ['Ana', 'Ana Maria'], 'Ana')
    expect(s).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', href: 'https://x.com/a?b=1', text: 'https://x.com/a?b=1' },
      { kind: 'text', text: '. ' },
      { kind: 'mention', text: '@Ana Maria', me: false },
      { kind: 'text', text: ' and ' },
      { kind: 'mention', text: '@Ana', me: true },
      { kind: 'text', text: ', ' },
      { kind: 'mention', text: '@todos', me: true },
    ])
    expect(segments('hi @Anaxyz', ['Ana'], 'Bob')).toEqual([{ kind: 'text', text: 'hi @Anaxyz' }])
    expect(segments('javascript:alert(1)', [], 'Bob')).toEqual([{ kind: 'text', text: 'javascript:alert(1)' }])
  })
})

describe('read ticks and the receipt line', () => {
  const reads = { u1: 'm_c', u2: 'm_c', u3: 'm_a' }
  it('✓ sent, grey ✓✓ some, green ✓✓ everyone else', () => {
    expect(tickFor(msg('m_c', 'u1', at), {}, 'u1', 3)).toEqual({ double: false, all: false })
    expect(tickFor(msg('m_c', 'u1', at), reads, 'u1', 3)).toEqual({ double: true, all: false })
    expect(tickFor(msg('m_c', 'u1', at), { ...reads, u3: 'm_d' }, 'u1', 3)).toEqual({ double: true, all: true })
  })
  it('carries no tick on others, pending, failed, client SMS or channels over 200', () => {
    expect(tickFor(msg('m_c', 'u2', at), reads, 'u1', 3)).toBeNull()
    expect(tickFor(msg('m_~x', 'u1', at, { pending: true }), reads, 'u1', 3)).toBeNull()
    expect(tickFor(msg('m_c', 'u1', at, { failed: 'no' }), reads, 'u1', 3)).toBeNull()
    expect(tickFor(msg('m_c', 'u1', at, { client: { dir: 'out', via: 'sms' } }), reads, 'u1', 3)).toBeNull()
    expect(tickFor(msg('m_c', 'u1', at), reads, 'u1', 201)).toBeNull()
  })
  it('puts the line under my newest sent message', () => {
    const list = [msg('m_a', 'u1', at), msg('m_b', 'u2', at), msg('m_c', 'u1', at, { deleted: true }), msg('m_~d', 'u1', at, { pending: true })]
    expect(receiptTarget(list, 'u1', 5)?.id).toBe('m_a')
    expect(receiptTarget(list, 'u1', 300)).toBeNull()
    expect(seenOf({ u1: 'm_z', u2: 'm_a' }, 'm_a', 'u1', 2)).toEqual({ who: ['u2'], all: true })
  })
  it('words it like SunOff: Sent, Seen (DM), Seen by everyone, Seen by A, B, C and n more', () => {
    const t = strings('en')
    const w = { sent: t.sent, seen: t.seen, seenAll: t.seenAll, seenByNames: t.seenByNames, andMore: t.andMore }
    expect(receiptText('group', [], false, w)).toBe('Sent')
    expect(receiptText('dm', ['Gatsby'], true, w)).toBe('Seen')
    expect(receiptText('group', ['A', 'B'], false, w)).toBe('Seen by A, B')
    expect(receiptText('group', ['A', 'B', 'C', 'D', 'E'], false, w)).toBe('Seen by A, B, C and 2 more')
    expect(receiptText('group', ['A', 'B', 'C', 'D'], true, w)).toBe('Seen by everyone')
    const es = strings('es')
    expect(receiptText('group', ['A', 'B', 'C', 'D'], false, { sent: es.sent, seen: es.seen, seenAll: es.seenAll, seenByNames: es.seenByNames, andMore: es.andMore })).toBe('Visto por A, B, C y 1 más')
  })
})

describe('grouping and the New line', () => {
  it('groups one author within 5 minutes, not across a failed send or a system line', () => {
    expect(groupsWith(msg('m_a', 'u2', at), msg('m_b', 'u2', at + 60_000))).toBe(true)
    expect(groupsWith(msg('m_a', 'u2', at), msg('m_b', 'u2', at + 5 * 60_000))).toBe(false)
    expect(groupsWith(msg('m_a', 'u2', at, { failed: 'x' }), msg('m_b', 'u2', at + 1))).toBe(false)
    expect(groupsWith(msg('m_a', 'u2', at, { kind: 'system' }), msg('m_b', 'u2', at + 1))).toBe(false)
    expect(groupsWith(null, msg('m_b', 'u2', at))).toBe(false)
  })
  it('places New after my read marker, or n unread from the end without one', () => {
    const list = [msg('m_a', 'u2', at), msg('m_b', 'u1', at), msg('m_c', 'u2', at), msg('m_d', 'u2', at)]
    expect(dividerId(list, 'm_a', 0, 'u1')).toBe('m_c')
    expect(dividerId(list, 'm_d', 0, 'u1')).toBeNull()
    expect(dividerId(list, null, 2, 'u1')).toBe('m_c')
    expect(dividerId(list, null, 0, 'u1')).toBeNull()
  })
})

describe('who may do what', () => {
  it('edit: author within 24 h, or staff; never a client SMS', () => {
    expect(canEditMessage(msg('m_a', 'u1', at), me, at + 3_600_000)).toBe(true)
    expect(canEditMessage(msg('m_a', 'u1', at), me, at + 86_400_001)).toBe(false)
    expect(canEditMessage(msg('m_a', 'u2', at), me, at)).toBe(false)
    expect(canEditMessage(msg('m_a', 'u2', at), staff, at + 9e9)).toBe(true)
    expect(canEditMessage(msg('m_a', 'u1', at, { client: { dir: 'out', via: 'sms' } }), me, at)).toBe(false)
  })
  it('delete: author unless flagged, or staff', () => {
    expect(canDeleteMessage(msg('m_a', 'u1', at), me)).toBe(true)
    expect(canDeleteMessage(msg('m_a', 'u1', at, { flagged: true }), me)).toBe(false)
    expect(canDeleteMessage(msg('m_a', 'u2', at), me)).toBe(false)
    expect(canDeleteMessage(msg('m_a', 'u2', at, { flagged: true }), staff)).toBe(true)
  })
  it('pin: staff or the channel creator, thread roots only', () => {
    expect(canPinMessage(msg('m_a', 'u2', at), me, 'u1')).toBe(true)
    expect(canPinMessage(msg('m_a', 'u2', at), me, 'u5')).toBe(false)
    expect(canPinMessage(msg('m_a', 'u2', at), me, null)).toBe(false)
    expect(canPinMessage(msg('m_a', 'u2', at), staff, null)).toBe(true)
    expect(canPinMessage(msg('m_a', 'u2', at, { parent_id: 'm_0' }), staff, null)).toBe(false)
  })
})

describe('composer', () => {
  it('counts past 3,500 and flags past 4,000', () => {
    expect(counter(3500)).toEqual({ text: '', over: false })
    expect(counter(3501)).toEqual({ text: '3501/4000', over: false })
    expect(counter(4001)).toEqual({ text: '4001/4000', over: true })
  })
  it('Enter sends on a keyboard; Shift+Enter, IME and phones make a new line', () => {
    expect(enterSends({ key: 'Enter', shiftKey: false }, false)).toBe(true)
    expect(enterSends({ key: 'Enter', shiftKey: true }, false)).toBe(false)
    expect(enterSends({ key: 'Enter', shiftKey: false, isComposing: true }, false)).toBe(false)
    expect(enterSends({ key: 'Enter', shiftKey: false }, true)).toBe(false)
  })
  it('keys drafts per person and conversation', () => {
    expect(draftKey('u1', 'c_1')).toBe('pf_chat_draft:u1:c_1')
    expect(draftKey('u1', 'c_1')).not.toBe(draftKey('u2', 'c_1'))
  })
  it('finds a mention at the caret, spaces allowed inside a name', () => {
    expect(mentionAt('hi @Ana Ma', 10)).toEqual({ q: 'Ana Ma', start: 3 })
    expect(mentionAt('mail@x', 6)).toBeNull()
    expect(mentionAt('@a  b', 5)).toBeNull()
  })
  it('offers members, then the directory only when members are not listed; everyone words to staff only', () => {
    const members = [
      { uid: 'u1', name: 'Ada Admin', role: 'admin', staff: true, online: true },
      { uid: 'u2', name: 'Gatsby Rep', role: 'rep', staff: false, online: false },
    ]
    const dir = [{ uid: 'u7', name: 'Gina Dir', role: 'rep', staff: false, online: false, relation: 'team' }]
    const base = { members, directory: dir, authors: [], meUid: 'u1', staff: false, kind: 'group', lang: 'en' as const }
    expect(mentionItems({ ...base, q: 'g' }).map((x) => x.uid)).toEqual(['u2'])
    expect(mentionItems({ ...base, q: 'rep' }).map((x) => x.uid)).toEqual(['u2'])
    expect(mentionItems({ ...base, members: [], q: 'g' }).map((x) => x.uid)).toEqual(['u7'])
    expect(mentionItems({ ...base, staff: true, q: '' })[0]).toMatchObject({ uid: '*', name: 'all', special: true })
    expect(mentionItems({ ...base, staff: true, lang: 'es', q: '' })[0]).toMatchObject({ name: 'todos' })
    expect(mentionItems({ ...base, staff: true, q: 'ca' }).map((x) => x.name)).toEqual(['canal'])
    expect(mentionItems({ ...base, staff: true, kind: 'dm', q: '' }).some((x) => x.special)).toBe(false)
  })
  it('sends only the picks still in the text', () => {
    const picked = new Map([['u2', 'Gatsby Rep'], ['u3', 'Gone'], ['*', 'todos']])
    expect(pickedMentions('hi @Gatsby Rep and @todos', picked)).toEqual(['u2', '*'])
  })
})

describe('attachments', () => {
  it('takes photos (HEIC by extension too) and PDF only', () => {
    expect(isAllowedFile('image/jpeg', 'a.jpg')).toBe(true)
    expect(isAllowedFile('application/pdf', 'a.pdf')).toBe(true)
    expect(isAllowedFile('', 'IMG_1.HEIC')).toBe(true)
    expect(isAllowedFile('text/plain', 'a.txt')).toBe(false)
  })
  it('recompresses jpeg/png/webp over 1.5 MB or 2560 px, never gif or heic', () => {
    expect(recompressible('image/jpeg')).toBe(true)
    expect(recompressible('image/gif')).toBe(false)
    expect(recompressible('image/heic')).toBe(false)
    expect(fitsAlready(1_400_000, 2000, 1500)).toBe(true)
    expect(fitsAlready(1_600_000, 2000, 1500)).toBe(false)
    expect(fitsAlready(100_000, 4032, 3024)).toBe(false)
  })
  it('steps quality down while it is over 0.62, then shrinks a fifth at a time', () => {
    let a = firstAttempt(4032, 3024)
    expect(a).toEqual({ dim: 2560, q: 0.85 })
    expect(scaled(4032, 3024, a.dim)).toEqual({ w: 2560, h: 1920 })
    a = nextAttempt(a)
    expect(a).toEqual({ dim: 2560, q: 0.75 })
    a = nextAttempt(a)
    expect(a).toEqual({ dim: 2560, q: 0.65 })
    a = nextAttempt(a)
    expect(a).toEqual({ dim: 2560, q: 0.55 })
    a = nextAttempt(a)
    expect(a).toEqual({ dim: 2048, q: 0.55 })
  })
})

describe('voice', () => {
  it('builds a 40-step 0–9 wave and 32 bar heights', () => {
    const w = waveOf(Array.from({ length: 100 }, (_, i) => i / 100))
    expect(w).toHaveLength(40)
    expect(w.at(-1)).toBe('9')
    expect(waveOf([])).toBe('0'.repeat(40))
    expect(waveBars(w, 'a')).toHaveLength(32)
    expect(waveBars(null, 'a')).toEqual(waveBars(undefined, 'a'))
  })
  it('remembers 1× / 1.5× / 2× and cycles them', () => {
    expect(readRate('1.5')).toBe(1.5)
    expect(readRate('3')).toBe(1)
    expect(readRate(null)).toBe(1)
    expect([nextRate(1), nextRate(1.5), nextRate(2)]).toEqual([1.5, 2, 1])
  })
  it('names files like SunOff', () => {
    expect(voiceFileName(new Date(2026, 9, 12, 15, 30, 45), 'audio/webm;codecs=opus')).toBe('voz-20261012-153045.webm')
    expect(voiceFileName(new Date(2026, 0, 2, 3, 4, 5), 'audio/mp4')).toBe('voz-20260102-030405.m4a')
  })
})
