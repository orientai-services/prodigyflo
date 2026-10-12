import { dividerId, groupsWith } from './message-logic'
import type { Channel, Lang, Message } from './types'

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

/** List-row time: a clock today, a short date before. */
export function listTime(ms: number | null | undefined, lang: Lang, now = Date.now()): string {
  if (!ms) return ''
  return dayKey(ms) === dayKey(now) ? clock(ms, lang) : new Intl.DateTimeFormat(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric', timeZone: TZ }).format(new Date(ms))
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

export function filterChannels(list: Channel[], q: string): Channel[] {
  const n = fold(q.trim())
  return n ? list.filter((c) => fold(c.name).includes(n)) : list
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
