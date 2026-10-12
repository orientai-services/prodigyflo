/**
 * History (docs/DIALER_APP.md §3): the pure, client-safe half. URL state,
 * cursors, labels and masking live here so the loader, the server action
 * and the screen agree on them, and so they test without a database.
 */

export const HISTORY_PAGE = 50
export const HISTORY_TZ = 'America/Los_Angeles'

export type HistoryTab = 'calls' | 'activity'
export type HistoryFilter = 'all' | 'calls' | 'answered' | 'missed' | 'sms' | 'unattached'

export const HISTORY_FILTERS: readonly { id: HistoryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'calls', label: 'Calls' },
  { id: 'answered', label: 'Answered' },
  { id: 'missed', label: 'Missed' },
  { id: 'sms', label: 'SMS' },
  { id: 'unattached', label: 'Unattached' },
]

export type HistoryRowKind = 'out' | 'in' | 'missed' | 'voicemail' | 'sms-in' | 'sms-out'

/** One line of Calls & SMS. Never carries a full number. */
export type HistoryRow = {
  /** 'vc:<VoiceCall id>' | 'cm:<Communication id>' | 'ev:<CallCenterEvent id>' */
  key: string
  at: string
  /** "Sun 11" this week, else "Oct 4" (Pacific). */
  day: string
  /** "2:14 PM" (Pacific). */
  time: string
  kind: HistoryRowKind
  /** Lead or client name, else "•••-•••-1234". */
  name: string
  rep: string | null
  seconds: number | null
  /** Short state when it isn't obvious from the icon: "No answer", "Not sent", … */
  status: string | null
  recording: { src: string; seconds: number } | null
  transcript: string | null
  /** SMS body, phone numbers masked. */
  text: string | null
  /** The lead on the desk or the client page. */
  href: string | null
}

export type HistoryPage = { rows: HistoryRow[]; nextCursor: string | null }

export type ActivityKind = 'outcome' | 'note' | 'lock' | 'intake' | 'form' | 'hold' | 'confirm' | 'visit' | 'dnc' | 'audit'

export type ActivityRow = {
  key: string
  at: string
  day: string
  time: string
  kind: ActivityKind
  title: string
  detail: string | null
  /** Who did it: a first name, "Auto-book", "Facebook", or null when unknown. */
  who: string | null
  /** The lead or client it is about. */
  subject: string | null
  href: string | null
}

export type ActivityPage = { rows: ActivityRow[]; nextCursor: string | null }

export type HistoryState = { tab: HistoryTab; filter: HistoryFilter; q: string }

type Params = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

/** `ht` (sub-tab), `hf` (filter), `hq` (search): prefixed so they never clash with the shell's own params. */
export function parseHistoryParams(params: Params): HistoryState {
  const tab: HistoryTab = one(params.ht) === 'activity' ? 'activity' : 'calls'
  const f = one(params.hf)
  const filter = HISTORY_FILTERS.some((x) => x.id === f) ? (f as HistoryFilter) : 'all'
  const q = one(params.hq).replace(/\s+/g, ' ').trim().slice(0, 60)
  return { tab, filter, q }
}

export function isHistoryFilter(value: unknown): value is HistoryFilter {
  return typeof value === 'string' && HISTORY_FILTERS.some((x) => x.id === value)
}

/** A link inside the section: `base` plus the history state. Defaults are left out of the URL. */
export function historyHref(base: string, state: Partial<HistoryState>): string {
  const [path, query = ''] = base.split('?')
  const sp = new URLSearchParams(query)
  for (const key of ['ht', 'hf', 'hq']) sp.delete(key)
  if (state.tab && state.tab !== 'calls') sp.set('ht', state.tab)
  if (state.tab !== 'activity') {
    if (state.filter && state.filter !== 'all') sp.set('hf', state.filter)
    if (state.q) sp.set('hq', state.q)
  }
  const out = sp.toString()
  return out ? `${path}?${out}` : path
}

/** The base's own query, as hidden inputs for the search form. */
export function baseFields(base: string): { path: string; fields: [string, string][] } {
  const [path, query = ''] = base.split('?')
  const fields = [...new URLSearchParams(query).entries()].filter(([k]) => !['ht', 'hf', 'hq'].includes(k))
  return { path, fields }
}

// ── Cursor ──────────────────────────────────────────────────────────────────
// Rows from several tables are merged newest first, so the page boundary is
// (time, key) and ties on the same millisecond still have one order.

export type Cursor = { at: number; key: string }

const CURSOR = /^(\d{1,15})_([a-z]{2}:[A-Za-z0-9:_-]{1,200})$/

export function encodeCursor(row: { at: string; key: string }): string {
  return `${new Date(row.at).getTime()}_${row.key}`
}

export function decodeCursor(value: unknown): Cursor | null {
  if (typeof value !== 'string') return null
  const m = CURSOR.exec(value)
  if (!m) return null
  const at = Number(m[1])
  return Number.isFinite(at) ? { at, key: m[2] } : null
}

/** Newest first; on the same millisecond, the larger key first. */
export function newestFirst(a: { at: string; key: string }, b: { at: string; key: string }): number {
  const d = new Date(b.at).getTime() - new Date(a.at).getTime()
  if (d !== 0) return d
  return a.key < b.key ? 1 : a.key > b.key ? -1 : 0
}

/** True when the row comes after the cursor in newest-first order. */
export function afterCursor(row: { at: string; key: string }, cursor: Cursor | null): boolean {
  if (!cursor) return true
  const at = new Date(row.at).getTime()
  return at < cursor.at || (at === cursor.at && row.key < cursor.key)
}

/** Merge sorted-or-not rows into one page. */
export function pageOf<T extends { at: string; key: string }>(rows: T[], cursor: Cursor | null, size = HISTORY_PAGE): { rows: T[]; nextCursor: string | null } {
  const byKey = new Map<string, T>()
  for (const r of rows) if (afterCursor(r, cursor) && !byKey.has(r.key)) byKey.set(r.key, r)
  const merged = [...byKey.values()].sort(newestFirst)
  const page = merged.slice(0, size)
  return { rows: page, nextCursor: merged.length > size && page.length ? encodeCursor(page[page.length - 1]) : null }
}

// ── Labels ──────────────────────────────────────────────────────────────────

function ymd(date: Date, tz: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return { y: get('year'), m: get('month'), d: get('day') }
}

/** "Sun 11" within the last 7 days, "Oct 4" earlier this year, "Oct 4, 2025" before that. */
export function dayLabel(date: Date, now: Date, tz = HISTORY_TZ): string {
  const a = ymd(date, tz)
  const b = ymd(now, tz)
  const days = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000)
  if (days >= 0 && days < 7) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date)
    return `${wd} ${a.d}`
  }
  const md = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(date)
  return a.y === b.y ? md : `${md}, ${a.y}`
}

export function timeLabel(date: Date, tz = HISTORY_TZ): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(date)
}

export function maskedNumber(last4: string | null | undefined): string {
  return last4 && /^\d{4}$/.test(last4) ? `•••-•••-${last4}` : 'Unknown number'
}

/** Phone-shaped runs in free text become "•••-•••-1234"; other numbers stay. */
export function maskPhones(text: string): string {
  return text.replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?(\d{4})(?!\d)/g, (_m, last4: string) => `•••-•••-${last4}`)
}

export function firstName(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0]
  return first || null
}

export function durationLabel(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** What the search box asked for: the last 4 of a number, or words of a name. */
export function parseSearch(q: string): { last4: string | null; words: string[] } {
  const trimmed = q.trim()
  if (!trimmed) return { last4: null, words: [] }
  const digits = trimmed.replace(/[\s().+-]/g, '')
  if (/^\d{4,}$/.test(digits)) return { last4: digits.slice(-4), words: [] }
  const words = trimmed
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[%_\\]/g, ''))
    .filter(Boolean)
    .slice(0, 4)
  return { last4: null, words }
}

/** Every word appears somewhere in the name. */
export function nameMatches(name: string, words: string[]): boolean {
  const n = name.toLowerCase()
  return words.length > 0 && words.every((w) => n.includes(w))
}
