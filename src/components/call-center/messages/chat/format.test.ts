import { describe, expect, it } from 'vitest'
import { channelLabel, insertMention, mentionQuery, preview, rowsFor, sectionOf, seenCount, upsertMessage } from './format'
import { strings } from './strings'
import type { Channel, Message } from './types'

/** The team chat's pure helpers: grouping, the new-messages line, mentions, read receipts, merging sends. */

const at = Date.UTC(2026, 9, 13, 17, 0, 0)
const msg = (id: string, uid: string, created: number, o: Partial<Message> = {}): Message => ({
  id, channel: 'c_1', uid, name: uid === 'u1' ? 'Ada Admin' : 'Gatsby Rep', body: 'hi', kind: 'message', parent_id: null, reply_count: 0, edited_at: null,
  deleted: false, pinned: false, attachments: [], mentions: [], reactions: {}, created_at: created, ...o,
})
const chan = (o: Partial<Channel>): Channel => ({
  id: 'c_1', kind: 'group', name: 'Ops', read_only: false, can_post: true, unread: 0, mentions: 0, pins: 0, last_msg: null, last_msg_at: null,
  members: [], member_count: 2, muted: false, notify: 'all', last_read_msg_id: null, ...o,
})

describe('team chat format', () => {
  it('groups one author within 5 minutes, splits days, marks the first unread from someone else', () => {
    const list = [msg('m_a', 'u2', at), msg('m_b', 'u2', at + 60_000), msg('m_c', 'u1', at + 120_000), msg('m_d', 'u2', at + 86_400_000)]
    const rows = rowsFor(list, 'en', 'm_b', 'u1', at + 86_400_000 + 1000)
    expect(rows.map((r) => (r.kind === 'msg' ? `${r.message.id}${r.grouped ? '+' : ''}` : r.kind))).toEqual(['day', 'm_a', 'm_b+', 'm_c', 'day', 'new', 'm_d'])
    expect(rows[0]).toMatchObject({ kind: 'day', label: 'Yesterday' })
  })

  it('never groups a client text with a team message', () => {
    const rows = rowsFor([msg('m_a', 'u2', at), msg('m_b', 'u2', at + 1000, { client: { dir: 'out', via: 'sms' } })], 'en', null, 'u1', at)
    expect(rows.filter((r) => r.kind === 'msg').map((r) => (r.kind === 'msg' ? r.grouped : null))).toEqual([false, false])
  })

  it('finds and completes an @mention at the caret', () => {
    expect(mentionQuery('hey @ma', 7)).toBe('ma')
    expect(mentionQuery('mail@example', 12)).toBeNull()
    expect(insertMention('hey @ma ok', 7, 'Mario M.')).toEqual({ text: 'hey @Mario M.  ok', caret: 14 })
  })

  it('counts read receipts for others only', () => {
    expect(seenCount({ u1: 'm_c', u2: 'm_b', u3: 'm_d' }, 'm_c', 'u1')).toBe(1)
  })

  it('replaces the optimistic copy by client id', () => {
    const local = msg('m_~pf1', 'u1', at, { client_id: 'pf1', pending: true })
    const merged = upsertMessage([msg('m_a', 'u2', at - 1), local], msg('m_z', 'u1', at, { client_id: 'pf1' }))
    expect(merged.map((m) => [m.id, Boolean(m.pending)])).toEqual([['m_a', false], ['m_z', false]])
  })

  it('sorts conversations into client chats, channels, DMs and groups', () => {
    const k = { lead_id: 'pf:x', host: 'prodigyflo' as const, stage: 'New', closed: false, rep_uid: 'u1', rep_name: null, phone4: '1234', appt_at: null, meet_uri: null, dialer_url: '/', type: null }
    expect(sectionOf(chan({ case: k }))).toBe('cases')
    expect(sectionOf(chan({ kind: 'main', name: 'general' }))).toBe('channels')
    expect(channelLabel(chan({ kind: 'main', name: 'general' }))).toBe('#general')
    expect(sectionOf(chan({ kind: 'dm' }))).toBe('dms')
    const t = strings('es')
    expect(preview(chan({ last_msg: { id: 'm_a', uid: 'u1', name: 'Ada', body: '', at, att: 'voice', deleted: false } }), t, 'u1')).toBe('Usted: 🎤 Nota de voz')
  })
})
