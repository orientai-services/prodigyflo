/**
 * The pure half of the dialer's Messages section (docs/DIALER_APP.md §4).
 *
 * No database and no `server-only`: thread keys, the SMS row body, the plain
 * failure reasons, day separators and search are unit-tested directly. The
 * loaders and the send path live in messages.ts.
 */

import { carrierCodeFrom, explainCarrierError } from '@/lib/telephony/carrier-errors'

export const MESSAGE_ZONE = 'America/Los_Angeles'
export const MAX_TEXT_LENGTH = 1000
export const A2P_PENDING = 'Texting is waiting on carrier approval'

export type ThreadKind = 'lead' | 'client'
export type ThreadKey = { kind: ThreadKind; id: string }

/** 'lead:<id>' | 'client:<id>'. Lead ids may be Meta ids ('meta:<org>:<leadgen>'). */
export function parseThreadKey(raw: string | string[] | null | undefined): ThreadKey | null {
  const value = (Array.isArray(raw) ? raw[0] : raw ?? '').trim()
  const m = /^(lead|client):([A-Za-z0-9:_-]{1,200})$/.exec(value)
  return m ? { kind: m[1] as ThreadKind, id: m[2] } : null
}

export function threadKeyString(key: ThreadKey): string {
  return `${key.kind}:${key.id}`
}

/** `base` already carries `?s=messages`; every link the section builds keeps it. */
export function messagesHref(base: string, extra: Record<string, string | null | undefined> = {}): string {
  const [path, query = ''] = base.split('?')
  const params = new URLSearchParams(query)
  for (const [k, v] of Object.entries(extra)) {
    if (v) params.set(k, v)
    else params.delete(k)
  }
  const q = params.toString()
  return q ? `${path}?${q}` : path
}

export type SmsStatus = 'received' | 'sending' | 'sent' | 'delivered' | 'failed'

/**
 * What a Messages SMS row stores in `body` (JSON, like every trail line, so
 * the lead panel keeps reading `label` / `detail`). Direction is NOT in here:
 * it is its own column.
 */
export type SmsEventCopy = {
  label: string
  /** The text itself. */
  detail: string
  userId?: string
  status?: SmsStatus
  /** Carrier or provider failure text as stored ("30034: …"). */
  error?: string
}

export function smsEventBody(copy: SmsEventCopy): string {
  return JSON.stringify(copy)
}

export function readSmsEvent(body: string): SmsEventCopy | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.detail !== 'string') return null
    const copy: SmsEventCopy = { label: typeof parsed.label === 'string' ? parsed.label : 'Text', detail: parsed.detail }
    if (typeof parsed.userId === 'string') copy.userId = parsed.userId
    if (isStatus(parsed.status)) copy.status = parsed.status
    if (typeof parsed.error === 'string') copy.error = parsed.error
    return copy
  } catch {
    return null
  }
}

function isStatus(value: unknown): value is SmsStatus {
  return value === 'received' || value === 'sending' || value === 'sent' || value === 'delivered' || value === 'failed'
}

/**
 * The plain reason a failed text shows on its bubble. A2P (30034) gets the
 * owner's words; other carrier codes their short meaning; anything else the
 * stored text with any code prefix and long digit runs removed.
 */
export function failureReason(error: string | null | undefined): string {
  const code = carrierCodeFrom(error ?? null) ?? (/\b30034\b/.test(error ?? '') ? '30034' : null)
  if (code === '30034') return A2P_PENDING
  if (code) {
    const meaning = explainCarrierError(code).meaning
    return `Not sent: ${meaning}`
  }
  const text = (error ?? '').replace(/^\s*\d{4,6}:\s*/, '').replace(/\d{5,}/g, '····').trim()
  return text ? `Not sent: ${text}` : 'Not sent'
}

/** A Communication row's status in Messages words. */
export function communicationSmsStatus(status: string): SmsStatus {
  switch (status) {
    case 'RECEIVED': return 'received'
    case 'QUEUED': return 'sending'
    case 'DELIVERED':
    case 'READ': return 'delivered'
    case 'FAILED': return 'failed'
    default: return 'sent'
  }
}

export function snippet(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The list's name: the person, else the masked number, else a plain word. */
export function displayName(name: string | null | undefined, last4: string | null | undefined): string {
  const n = (name ?? '').trim()
  if (n) return n
  return last4 && /^\d{4}$/.test(last4) ? `•••-•••-${last4}` : 'Unknown number'
}

/** Search by name or last 4 (digits only match the last 4). */
export function threadMatches(thread: { name: string; last4: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const digits = q.replace(/\D/g, '')
  if (digits && digits === q.replace(/[\s()+-]/g, '')) return Boolean(thread.last4?.includes(digits.slice(-4)))
  return thread.name.toLowerCase().includes(q)
}

function dayKey(at: Date, zone: string): string {
  return at.toLocaleDateString('en-CA', { timeZone: zone })
}

/** "Today", "Yesterday", "Mon, Oct 5" (adds the year when it isn't this one). */
export function dayLabel(at: Date, now: Date, zone = MESSAGE_ZONE): string {
  const key = dayKey(at, zone)
  if (key === dayKey(now, zone)) return 'Today'
  if (key === dayKey(new Date(now.getTime() - 86_400_000), zone)) return 'Yesterday'
  const sameYear = key.slice(0, 4) === dayKey(now, zone).slice(0, 4)
  return at.toLocaleDateString('en-US', {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

export function clockLabel(at: Date, zone = MESSAGE_ZONE): string {
  return at.toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' })
}

/** The list's time: a clock today, "Yesterday", a weekday this week, else "Oct 4". */
export function listTimeLabel(at: Date, now: Date, zone = MESSAGE_ZONE): string {
  const day = dayLabel(at, now, zone)
  if (day === 'Today') return clockLabel(at, zone)
  if (day === 'Yesterday') return day
  if (now.getTime() - at.getTime() < 6 * 86_400_000) return at.toLocaleDateString('en-US', { timeZone: zone, weekday: 'short' })
  return at.toLocaleDateString('en-US', { timeZone: zone, month: 'short', day: 'numeric' })
}

/** Messages in order with a day separator before each new day. */
export function withDaySeparators<T extends { at: string }>(
  messages: readonly T[],
  now: Date,
  zone = MESSAGE_ZONE,
): ({ kind: 'day'; key: string; label: string } | { kind: 'message'; message: T })[] {
  const out: ({ kind: 'day'; key: string; label: string } | { kind: 'message'; message: T })[] = []
  let last = ''
  for (const message of messages) {
    const at = new Date(message.at)
    const key = dayKey(at, zone)
    if (key !== last) {
      out.push({ kind: 'day', key, label: dayLabel(at, now, zone) })
      last = key
    }
    out.push({ kind: 'message', message })
  }
  return out
}

/** Trim, refuse empty, cap the length. */
export function cleanText(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Write a message first.' }
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (!text) return { ok: false, error: 'Write a message first.' }
  if (text.length > MAX_TEXT_LENGTH) return { ok: false, error: `Keep it under ${MAX_TEXT_LENGTH} characters.` }
  return { ok: true, text }
}
