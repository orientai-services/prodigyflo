import { dividerId, groupsWith } from './message-logic'
import type { Channel, ChatFeatures, Lang, MeAnswer, Message, Person, Room } from './types'

/** Pure helpers for the team chat screen (unit-tested in format.test.ts). */

const TZ = 'America/Los_Angeles'

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean)
  if (!parts.length) return '#'
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

export function clock(ms: number, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-MX' : 'en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }).format(new Date(ms))
}

function dayKey(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

export function dayLabel(ms: number, lang: Lang, now = Date.now()): string {
  const k = dayKey(ms)
  if (k === dayKey(now)) return lang === 'es' ? 'Hoy' : 'Today'
  if (k === dayKey(now - 86_400_000)) return lang === 'es' ? 'Ayer' : 'Yesterday'
  const sameYear = dayKey(ms).slice(0, 4) === dayKey(now).slice(0, 4)
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-MX' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: TZ }).format(new Date(ms))
}

/** List-row time: a clock today, the weekday within 6 days, a short date before (SunOff chat fmtShort). */
export function listTime(ms: number | null | undefined, lang: Lang, now = Date.now()): string {
  if (!ms) return ''
  if (dayKey(ms) === dayKey(now)) return clock(ms, lang)
  const loc = lang === 'es' ? 'es-MX' : 'en-US'
  if ((now - ms) / 86_400_000 < 6) return new Intl.DateTimeFormat(loc, { weekday: 'short', timeZone: TZ }).format(new Date(ms))
  return new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', timeZone: TZ }).format(new Date(ms))
}

/** "5 minutes ago", "yesterday" (rooms: last join). */
export function relTime(ms: number, lang: Lang, now = Date.now()): string {
  const s = (now - ms) / 1000
  const f = new Intl.RelativeTimeFormat(lang === 'es' ? 'es-MX' : 'en-US', { numeric: 'auto' })
  if (s < 60) return f.format(0, 'second')
  if (s < 3600) return f.format(-Math.round(s / 60), 'minute')
  if (s < 86400) return f.format(-Math.round(s / 3600), 'hour')
  return f.format(-Math.round(s / 86400), 'day')
}

export type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'new'; key: string }
  | { kind: 'msg'; message: Message; grouped: boolean }

/**
 * Day separators, the "New" line before the first unread message from someone
 * else, and grouping: the same author within 5 minutes shows without a
 * repeated name (message-logic.ts `groupsWith`, `dividerId`).
 */
export function rowsFor(messages: Message[], lang: Lang, lastRead: string | null, meUid: string, now = Date.now(), unread = 0): Row[] {
  const out: Row[] = []
  const divider = dividerId(messages, lastRead, unread, meUid)
  let prevDay = ''
  let prev: Message | null = null
  for (const m of messages) {
    const d = dayKey(m.created_at)
    if (d !== prevDay) {
      out.push({ kind: 'day', key: d, label: dayLabel(m.created_at, lang, now) })
      prevDay = d
      prev = null
    }
    if (m.id === divider) {
      out.push({ kind: 'new', key: `new-${m.id}` })
      prev = null
    }
    out.push({ kind: 'msg', message: m, grouped: groupsWith(prev, m) })
    prev = m
  }
  return out
}

export type Section = 'cases' | 'channels' | 'dms' | 'groups'
export function sectionOf(c: Channel): Section {
  if (c.case) return 'cases'
  if (c.kind === 'dm') return 'dms'
  if (c.kind === 'group') return 'groups'
  return 'channels'
}

export function channelLabel(c: Channel): string {
  return c.kind === 'main' || c.kind === 'announcements' || c.kind === 'team' ? `#${c.name}` : c.name
}

/** A search over the list matches the conversation name and, on client chats, the rep's name. */
export function filterChannels(list: Channel[], q: string): Channel[] {
  const n = fold(q.trim())
  return n ? list.filter((c) => fold(`${c.name} ${c.case?.rep_name ?? ''}`).includes(n)) : list
}

// ── Conversation list (SunOff chat renderSide / rowHTML) ──────────────────

/** The list's three categories, in the owner's order (2026-10-12): DMs, client chats, channels (groups count as channels). */
export type Cat = 'dms' | 'clients' | 'chans'
export const CATS: readonly Cat[] = ['dms', 'clients', 'chans']
export const isCat = (v: unknown): v is Cat => v === 'dms' || v === 'clients' || v === 'chans'
export function catOf(c: Channel): Cat {
  return c.case ? 'clients' : c.kind === 'dm' ? 'dms' : 'chans'
}

/** What the list shows: not removed, not archived. */
export const listable = (list: Channel[]): Channel[] => list.filter((c) => !c.removed && !c.archived_at)

const lastAt = (c: Channel) => (c.last_msg ? c.last_msg.at || c.last_msg_at || 0 : 0)
/** Newest activity first; conversations without messages last. */
export function byActivity(a: Channel, b: Channel): number {
  return lastAt(b) - lastAt(a) || (b.last_msg_at ?? 0) - (a.last_msg_at ?? 0) || a.name.localeCompare(b.name)
}

/** The most recent conversation (desktop opens it when nothing is asked for). */
export function mostRecent(list: Channel[]): Channel | null {
  return listable(list).sort(byActivity)[0] ?? null
}

/** Unseen in a set of conversations: muted ones add no unread count, mentions always count. */
export function unseen(list: Channel[]): { unread: number; mentions: number } {
  let unread = 0
  let mentions = 0
  for (const c of list) {
    if (!c.muted) unread += c.unread || 0
    mentions += c.mentions || 0
  }
  return { unread, mentions }
}

/** "@3" (red) when mentioned, else the unread count, else nothing. */
export function badgeText(u: { unread: number; mentions: number }): { text: string; mention: boolean } | null {
  if (u.mentions) return { text: `@${u.mentions > 99 ? '99+' : u.mentions}`, mention: true }
  if (u.unread) return { text: u.unread > 99 ? '99+' : String(u.unread), mention: false }
  return null
}

type PreviewWords = { you: string; voiceNote: string; image: string; file: string }

/** The row's second line: "You: …" / "Ana: …" (not in a DM); client chats lead with the rep (when not me) and the stage. */
export function rowPreview(c: Channel, t: PreviewWords, meUid: string): string {
  const lm = c.last_msg
  const pv = lm && !lm.deleted ? lastBody(lm, t) : ''
  const who = lm ? (lm.uid === meUid ? `${t.you}: ` : c.kind === 'dm' ? '' : `${(lm.name || '').split(' ')[0]}: `) : ''
  if (c.case) {
    const rep = c.case.rep_uid !== meUid && c.case.rep_name ? c.case.rep_name.split(' ')[0] : ''
    return [rep, c.case.stage ?? '', pv ? who + pv : ''].filter(Boolean).join(' · ')
  }
  return pv ? who + pv : ''
}

function lastBody(lm: NonNullable<Channel['last_msg']>, t: PreviewWords): string {
  const voice = lm.att === 'voice' || lm.body === '🎤'
  const body = lm.body === '🎤' ? '' : lm.body
  return body || (voice ? `🎤 ${t.voiceNote}` : lm.att === 'image' ? `📎 ${t.image}` : `📎 ${t.file}`)
}

/**
 * Ticks on my own last message in the list: ✓ sent, ✓✓ seen by someone, green ✓✓ seen by everyone else.
 * Off in channels over 200 members (the Worker skips read markers there).
 */
export function tickOf(c: Channel, meUid: string): null | 'sent' | 'seen' | 'all' {
  const lm = c.last_msg
  if (!lm || lm.uid !== meUid || lm.deleted || (c.member_count || 0) > 200) return null
  const seen = lm.seen || 0
  if (!seen) return 'sent'
  return seen >= Math.max(1, (c.member_count || 2) - 1) ? 'all' : 'seen'
}

// ── Rooms ────────────────────────────────────────────────────────────────

/** "3 inside" / "Empty"; '' when Meet can't say. */
export function roomInText(r: Pick<Room, 'live'>, t: { roomIn: (n: number) => string; roomEmpty: string }): string {
  if (!r.live) return ''
  return r.live.n ? t.roomIn(r.live.n) : t.roomEmpty
}

/** Staff see their own line's rooms first, then the rest; everyone else one list. */
export function splitRooms(rooms: Room[], staff: boolean): { mine: Room[]; other: Room[] } {
  if (!staff) return { mine: rooms, other: [] }
  const mine = rooms.filter((r) => r.mine || r.in_line)
  return { mine, other: rooms.filter((r) => !mine.includes(r)) }
}

// ── People ───────────────────────────────────────────────────────────────

const REL_ORDER = ['upline', 'downline', 'team', 'staff'] as const

/**
 * The directory grouped like the SunOff picker: above you, your downline, same team, staff, then anyone else
 * (shown under "same team"). Filters on name or team name; leaves out anyone already in the conversation.
 */
export function groupPeople(people: Person[], q: string, exclude: Set<string>): Array<{ rel: string; people: Person[] }> {
  const n = fold(q.trim())
  const list = people.filter((p) => !exclude.has(p.uid) && (!n || fold(p.name).includes(n) || fold(p.team?.name ?? '').includes(n)))
  const out: Array<{ rel: string; people: Person[] }> = []
  for (const rel of REL_ORDER) {
    const g = list.filter((p) => p.relation === rel)
    if (g.length) out.push({ rel, people: g })
  }
  const rest = list.filter((p) => !(REL_ORDER as readonly string[]).includes(p.relation))
  if (rest.length) out.push({ rel: 'other', people: rest })
  return out
}

// ── Preferences ──────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
export const validHHMM = (v: string): boolean => HHMM.test(v)

/** The browser's IANA time zone (quiet hours run on it); Los Angeles when the browser won't say. */
export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || TZ
  } catch {
    return TZ
  }
}

export function fold(s: string): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** "@ma" right before the caret → "ma"; null when the caret isn't in a mention. */
export function mentionQuery(text: string, caret: number): string | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([\p{L}\p{N}_.-]{0,30})$/u.exec(before)
  return m ? m[2] : null
}

/** Replace the "@query" before the caret with "@Full Name ". */
export function insertMention(text: string, caret: number, name: string): { text: string; caret: number } {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  const head = before.slice(0, at) + `@${name} `
  return { text: head + text.slice(caret), caret: head.length }
}

/** How many other members have read up to (or past) this message. */
export function seenCount(reads: Record<string, string>, msgId: string, meUid: string): number {
  let n = 0
  for (const [uid, last] of Object.entries(reads)) if (uid !== meUid && last >= msgId) n++
  return n
}

export function fmtDur(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function preview(c: Channel, t: { you: string; voiceNote: string; image: string; file: string; deleted: string }, meUid: string): string {
  const m = c.last_msg
  if (!m) return ''
  if (m.deleted) return t.deleted
  const who = m.uid === meUid ? `${t.you}: ` : c.kind === 'dm' ? '' : `${m.name.split(' ')[0]}: `
  const body = m.body || (m.att === 'voice' ? `🎤 ${t.voiceNote}` : m.att === 'image' ? `📎 ${t.image}` : m.att ? `📎 ${t.file}` : '')
  return who + body
}

/** Merge a message into a list, newest last, replacing the optimistic copy by client_id. */
export function upsertMessage(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.id === m.id || (m.client_id && x.client_id === m.client_id && x.pending))
  if (i >= 0) {
    const next = list.slice()
    next[i] = { ...m, pending: false, failed: null }
    return next
  }
  const next = [...list, m]
  next.sort((a, b) => (a.pending === b.pending ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.pending ? 1 : -1))
  return next
}

// ── Front-door scope ─────────────────────────────────────────────────────

/**
 * Which SunOff-side tools the ProdigyFlo chat shows. Each is off unless the Worker turns it on explicitly in
 * `GET /api/me` (top level or under `me`): video rooms, Announce (#anuncios) and Sync now all act on SunOff's org.
 */
export function chatFeatures(ans: Pick<MeAnswer, 'features' | 'scope'> & { me?: { features?: ChatFeatures } } | null | undefined): Required<ChatFeatures> {
  const f = ans?.features ?? ans?.me?.features ?? {}
  return { rooms: f.rooms === true, announce: f.announce === true, sync: f.sync === true }
}
export const NO_FEATURES: Required<ChatFeatures> = { rooms: false, announce: false, sync: false }
