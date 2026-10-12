import { describe, expect, it } from 'vitest'
import {
  badgeText, byActivity, catOf, channelLabel, filterChannels, groupPeople, insertMention, listTime, listable, mentionQuery, mostRecent, preview, relTime,
  roomInText, rowPreview, rowsFor, sectionOf, seenCount, splitRooms, tickOf, unseen, upsertMessage, validHHMM,
} from './format'
import { strings } from './strings'
import type { Channel, Message, Person, Room } from './types'

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

  it('puts conversations in the three list categories, groups with channels', () => {
    const k = { lead_id: 'pf:x', host: 'prodigyflo' as const, stage: 'New', closed: false, rep_uid: 'u2', rep_name: 'Gatsby Rep', phone4: null, appt_at: null, meet_uri: null, dialer_url: '/', type: null }
    expect(catOf(chan({ kind: 'dm' }))).toBe('dms')
    expect(catOf(chan({ kind: 'group' }))).toBe('chans')
    expect(catOf(chan({ kind: 'team' }))).toBe('chans')
    expect(catOf(chan({ kind: 'group', case: k }))).toBe('clients')
    // A search matches the rep on a client chat too.
    expect(filterChannels([chan({ id: 'c_a', name: 'Ana Client', case: k }), chan({ id: 'c_b', name: 'Ops' })], 'gatsby').map((c) => c.id)).toEqual(['c_a'])
  })

  it('orders by newest activity, hides archived, picks the most recent', () => {
    const lm = (at: number) => ({ id: 'm_a', uid: 'u2', name: 'G', body: 'x', at, att: null, deleted: false })
    const list = [chan({ id: 'c_old', last_msg: lm(at - 5000) }), chan({ id: 'c_none', name: 'A' }), chan({ id: 'c_new', last_msg: lm(at) }), chan({ id: 'c_arch', last_msg: lm(at + 9), archived_at: at })]
    expect(listable(list).sort(byActivity).map((c) => c.id)).toEqual(['c_new', 'c_old', 'c_none'])
    expect(mostRecent(list)?.id).toBe('c_new')
    expect(mostRecent([])).toBeNull()
  })

  it('counts unseen per category: muted adds no unread, mentions always count', () => {
    const u = unseen([chan({ unread: 3 }), chan({ unread: 5, muted: true, mentions: 1 }), chan({ unread: 120 })])
    expect(u).toEqual({ unread: 123, mentions: 1 })
    expect(badgeText(u)).toEqual({ text: '@1', mention: true })
    expect(badgeText({ unread: 123, mentions: 0 })).toEqual({ text: '99+', mention: false })
    expect(badgeText({ unread: 0, mentions: 0 })).toBeNull()
  })

  it('writes the row preview like the SunOff list', () => {
    const t = strings('en')
    const lm = (o: Partial<NonNullable<Channel['last_msg']>>) => ({ id: 'm_a', uid: 'u2', name: 'Gatsby Rep', body: 'see you', at, att: null, deleted: false, ...o })
    expect(rowPreview(chan({ kind: 'group', last_msg: lm({}) }), t, 'u1')).toBe('Gatsby: see you')
    expect(rowPreview(chan({ kind: 'dm', last_msg: lm({}) }), t, 'u1')).toBe('see you')
    expect(rowPreview(chan({ kind: 'dm', last_msg: lm({ uid: 'u1', body: '', att: 'image' }) }), t, 'u1')).toBe('You: 📎 Photo')
    expect(rowPreview(chan({ kind: 'group', last_msg: lm({ body: '🎤' }) }), t, 'u1')).toBe('Gatsby: 🎤 Voice note')
    expect(rowPreview(chan({ kind: 'group', last_msg: lm({ deleted: true, body: '' }) }), t, 'u1')).toBe('')
    const k = { lead_id: 'pf:x', host: 'prodigyflo' as const, stage: 'Booked', closed: false, rep_uid: 'u2', rep_name: 'Gatsby Rep', phone4: null, appt_at: null, meet_uri: null, dialer_url: '/', type: null }
    expect(rowPreview(chan({ case: k, last_msg: lm({ uid: 'u1', body: 'ok' }) }), t, 'u1')).toBe('Gatsby · Booked · You: ok')
    expect(rowPreview(chan({ case: { ...k, rep_uid: 'u1' }, last_msg: null }), t, 'u1')).toBe('Booked')
  })

  it('ticks my last message: sent, seen by some, seen by everyone; none over 200 members', () => {
    const mine = (seen: number, n = 4) => chan({ member_count: n, last_msg: { id: 'm_a', uid: 'u1', name: 'Ada', body: 'x', at, att: null, deleted: false, seen } })
    expect(tickOf(mine(0), 'u1')).toBe('sent')
    expect(tickOf(mine(1), 'u1')).toBe('seen')
    expect(tickOf(mine(3), 'u1')).toBe('all')
    expect(tickOf(mine(1, 2), 'u1')).toBe('all')
    expect(tickOf(mine(1, 201), 'u1')).toBeNull()
    expect(tickOf(mine(1), 'u9')).toBeNull()
  })

  it('labels rooms and splits them for staff', () => {
    const t = strings('es')
    const room = (o: Partial<Room>): Room => ({ id: 'r_1', name: 'Huddle', auto: false, team_id: null, badge: null, owner: { uid: 'u1', name: 'Ada' }, people: 3, uri: null, mine: false, in_line: false, can_manage: false, last_join_at: null, last_join_name: null, live: null, ...o })
    expect(roomInText(room({ live: { n: 2, names: ['A', 'B'] } }), t)).toBe('2 dentro')
    expect(roomInText(room({ live: { n: 0, names: [] } }), t)).toBe('Vacía')
    expect(roomInText(room({}), t)).toBe('')
    const a = room({ id: 'r_a', mine: true }), b = room({ id: 'r_b' }), c = room({ id: 'r_c', in_line: true })
    expect(splitRooms([a, b, c], true)).toEqual({ mine: [a, c], other: [b] })
    expect(splitRooms([a, b], false)).toEqual({ mine: [a, b], other: [] })
  })

  it('groups the directory like the SunOff picker and leaves out members', () => {
    const person = (uid: string, relation: string, name = uid): Person => ({ uid, name, role: 'rep', staff: false, online: false, relation })
    const g = groupPeople([person('u5', 'staff'), person('u2', 'downline', 'Gatsby'), person('u3', 'upline'), person('u4', 'downline'), person('u9', 'odd')], '', new Set(['u4']))
    expect(g.map((x) => [x.rel, x.people.map((p) => p.uid)])).toEqual([['upline', ['u3']], ['downline', ['u2']], ['staff', ['u5']], ['other', ['u9']]])
    expect(groupPeople([person('u2', 'team', 'José Núñez')], 'nunez', new Set()).length).toBe(1)
  })

  it('formats list times and checks quiet-hour times', () => {
    expect(listTime(at - 2 * 86_400_000, 'en', at)).toMatch(/^[A-Z][a-z]{2}$/)
    expect(listTime(at - 20 * 86_400_000, 'en', at)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)
    expect(relTime(at - 5 * 60_000, 'en', at)).toBe('5 minutes ago')
    expect(validHHMM('21:00')).toBe(true)
    expect(validHHMM('24:00')).toBe(false)
    expect(validHHMM('9:00')).toBe(false)
  })
})
