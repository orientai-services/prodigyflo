import { normalizeState } from '@/lib/meta/attribution'
import NANP from './data/nanp-timezones.json'
import type { OutboundPurpose } from './voice-contract'

/**
 * Calling hours in the CALLEE's local time.
 *
 * Pure (no DB, no network) so every edge — 7:59 vs 8:00, DST days, Sundays,
 * each federal holiday — is unit-tested. The rules:
 *
 *  - Candidate zones are the UNION of every hint (a zone staff set on the lead,
 *    the lead's state, the number's area code). Mobiles port and people move,
 *    so a call must be inside the window in EVERY candidate zone.
 *  - Area-code zones come from Google libphonenumber's data, vendored and
 *    generated (data/nanp-timezones.json, scripts/gen-nanp-timezones.ts).
 *    Nothing is hand-typed, and a prefix missing from the data is unknown.
 *  - No candidates at all is UNKNOWN, which blocks. We never assume Nevada.
 *  - The legal ceiling is 8:00–21:00 callee-local (federal), intersected with
 *    any cited per-state rule. The account window (default 8:00–20:00) sits
 *    inside it.
 *  - Marketing calls and texts skip Sundays and US federal holidays until
 *    counsel fills STATE_WINDOWS.
 *    TODO(counsel): several states restrict Sunday/holiday telemarketing; confirm per state.
 */

export type CallWindow = { start: number; end: number }

/** Federal ceiling: 8:00 inclusive to 21:00 exclusive, callee-local. */
export const LEGAL_WINDOW: CallWindow = { start: 8, end: 21 }
/** The account default, deliberately an hour inside the ceiling. */
export const DEFAULT_WINDOW: CallWindow = { start: 8, end: 20 }

/**
 * IANA zones per state. Multi-zone states list every zone they span
 * (US DOT time zone boundaries, 49 CFR part 71), so a call into one of them
 * must suit all of them.
 */
export const STATE_ZONES: Record<string, string[]> = {
  AL: ['America/Chicago'],
  AK: ['America/Anchorage', 'America/Adak'],
  AZ: ['America/Phoenix', 'America/Denver'], // the Navajo Nation keeps DST
  AR: ['America/Chicago'],
  CA: ['America/Los_Angeles'],
  CO: ['America/Denver'],
  CT: ['America/New_York'],
  DE: ['America/New_York'],
  DC: ['America/New_York'],
  FL: ['America/New_York', 'America/Chicago'],
  GA: ['America/New_York'],
  HI: ['Pacific/Honolulu'],
  ID: ['America/Boise', 'America/Los_Angeles'],
  IL: ['America/Chicago'],
  IN: ['America/Indiana/Indianapolis', 'America/Chicago'],
  IA: ['America/Chicago'],
  KS: ['America/Chicago', 'America/Denver'],
  KY: ['America/New_York', 'America/Chicago'],
  LA: ['America/Chicago'],
  ME: ['America/New_York'],
  MD: ['America/New_York'],
  MA: ['America/New_York'],
  MI: ['America/Detroit', 'America/Menominee'],
  MN: ['America/Chicago'],
  MS: ['America/Chicago'],
  MO: ['America/Chicago'],
  MT: ['America/Denver'],
  NE: ['America/Chicago', 'America/Denver'],
  NV: ['America/Los_Angeles', 'America/Denver'], // West Wendover is on Mountain time
  NH: ['America/New_York'],
  NJ: ['America/New_York'],
  NM: ['America/Denver'],
  NY: ['America/New_York'],
  NC: ['America/New_York'],
  ND: ['America/Chicago', 'America/Denver'],
  OH: ['America/New_York'],
  OK: ['America/Chicago'],
  OR: ['America/Los_Angeles', 'America/Boise'],
  PA: ['America/New_York'],
  RI: ['America/New_York'],
  SC: ['America/New_York'],
  SD: ['America/Chicago', 'America/Denver'],
  TN: ['America/Chicago', 'America/New_York'],
  TX: ['America/Chicago', 'America/Denver'],
  UT: ['America/Denver'],
  VT: ['America/New_York'],
  VA: ['America/New_York'],
  WA: ['America/Los_Angeles'],
  WV: ['America/New_York'],
  WI: ['America/Chicago'],
  WY: ['America/Denver'],
  PR: ['America/Puerto_Rico'],
}

type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export type StateWindowRule = {
  /** Per-weekday window (0 = Sunday). null = no calls that day. Omitted days use the default. */
  days?: Partial<Record<Weekday, CallWindow | null>>
  /** 'federal' = no calls on US federal holidays. */
  holidays?: 'federal' | null
  /** Statute or counsel note. A rule without a source is not added. */
  source: string
}

/**
 * Per-state telemarketing windows. Ships EMPTY on purpose: adding a state needs
 * a cited rule from the owner or counsel. Rules only ever narrow the window.
 */
export const STATE_WINDOWS: Record<string, StateWindowRule> = {}

// ── Federal holidays ─────────────────────────────────────────────────────────

export type Holiday = { date: string; name: string }

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Day of week (0 = Sunday) of a calendar date, zone-free. */
function dow(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** The n-th `weekday` of a month (n = -1 for the last one). */
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = dow(y, m, 1)
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const last = dow(y, m, lastDay)
  return lastDay - ((last - weekday + 7) % 7)
}

/**
 * US federal holidays (5 U.S.C. 6103) for a year. Fixed-date holidays also list
 * their observed weekday when they fall on a weekend, so both days are skipped.
 */
export function FEDERAL_HOLIDAYS(year: number): Holiday[] {
  const fixed: [number, number, string][] = [
    [1, 1, "New Year's Day"],
    [6, 19, 'Juneteenth'],
    [7, 4, 'Independence Day'],
    [11, 11, 'Veterans Day'],
    [12, 25, 'Christmas Day'],
  ]
  const out: Holiday[] = []
  for (const [m, d, name] of fixed) {
    out.push({ date: ymd(year, m, d), name })
    const wd = dow(year, m, d)
    if (wd === 6) {
      const obs = new Date(Date.UTC(year, m - 1, d - 1))
      out.push({ date: ymd(obs.getUTCFullYear(), obs.getUTCMonth() + 1, obs.getUTCDate()), name: `${name} (observed)` })
    } else if (wd === 0) {
      const obs = new Date(Date.UTC(year, m - 1, d + 1))
      out.push({ date: ymd(obs.getUTCFullYear(), obs.getUTCMonth() + 1, obs.getUTCDate()), name: `${name} (observed)` })
    }
  }
  out.push({ date: ymd(year, 1, nthWeekday(year, 1, 1, 3)), name: 'Martin Luther King Jr. Day' })
  out.push({ date: ymd(year, 2, nthWeekday(year, 2, 1, 3)), name: "Washington's Birthday" })
  out.push({ date: ymd(year, 5, nthWeekday(year, 5, 1, -1)), name: 'Memorial Day' })
  out.push({ date: ymd(year, 9, nthWeekday(year, 9, 1, 1)), name: 'Labor Day' })
  out.push({ date: ymd(year, 10, nthWeekday(year, 10, 1, 2)), name: 'Columbus Day' })
  out.push({ date: ymd(year, 11, nthWeekday(year, 11, 4, 4)), name: 'Thanksgiving Day' })
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

function holidayOn(date: string): Holiday | null {
  const year = Number(date.slice(0, 4))
  // The Dec 31 observed New Year's Day belongs to the next year's list.
  return [...FEDERAL_HOLIDAYS(year), ...FEDERAL_HOLIDAYS(year + 1)].find((h) => h.date === date) ?? null
}

// ── Zones ────────────────────────────────────────────────────────────────────

const PREFIXES = (NANP as { entries: Record<string, string[]> }).entries
const MAX_PREFIX = Math.max(...Object.keys(PREFIXES).map((k) => k.length))

/** Zones for a NANP number by longest prefix match. Unknown or non-NANP → []. */
export function zonesForNumber(e164: string | null | undefined): string[] {
  const digits = (e164 ?? '').replace(/\D/g, '')
  if (!(e164 ?? '').startsWith('+1') || digits.length !== 11) return []
  for (let len = Math.min(MAX_PREFIX, digits.length); len >= 4; len -= 1) {
    const hit = PREFIXES[digits.slice(0, len)]
    if (hit) return [...hit]
  }
  return []
}

export function isValidZone(zone: string | null | undefined): boolean {
  if (!zone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export type ZoneHints = {
  /** IANA zone staff set on the lead ("they told us they're in X"). */
  leadZone?: string | null
  /** Raw state hints (leadAttribution.state, address state). Normalized here. */
  states?: (string | null | undefined)[]
  /** The callee's number, E.164. */
  e164?: string | null
  /** Dakota's flag: the lead said they are outside Nevada. */
  outOfArea?: boolean
}

export type CalleeZones = { zones: string[]; states: string[] }

/**
 * Union of every hint. `outOfArea` adds no zone by itself — it only means no
 * code path may assume the lead is in Nevada, which this function never does.
 */
export function calleeZones(hints: ZoneHints): CalleeZones {
  const zones = new Set<string>()
  if (hints.leadZone && isValidZone(hints.leadZone)) zones.add(hints.leadZone)
  const states = new Set<string>()
  for (const raw of hints.states ?? []) {
    const st = normalizeState(raw)
    if (!st) continue
    states.add(st)
    for (const z of STATE_ZONES[st] ?? []) zones.add(z)
  }
  for (const z of zonesForNumber(hints.e164)) zones.add(z)
  return { zones: [...zones].sort(), states: [...states].sort() }
}

// ── Local time ───────────────────────────────────────────────────────────────

export type LocalTime = {
  zone: string
  date: string
  hour: number
  minute: number
  weekday: Weekday
  /** "2:14 pm" */
  label: string
}

const WEEKDAYS: Record<string, Weekday> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function localTimeIn(zone: string, now: Date): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return {
    zone,
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute,
    weekday: WEEKDAYS[get('weekday')] ?? 0,
    label: `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`,
  }
}

/** "8:00 am" for an hour of the day. */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:00 ${h < 12 ? 'am' : 'pm'}`
}

// ── Windows ──────────────────────────────────────────────────────────────────

/** Any window stored in settings, forced inside the legal ceiling. */
export function clampWindow(w: Partial<CallWindow> | null | undefined): CallWindow {
  const start = Number.isInteger(w?.start) ? Math.min(Math.max(w!.start!, LEGAL_WINDOW.start), LEGAL_WINDOW.end - 1) : DEFAULT_WINDOW.start
  const end = Number.isInteger(w?.end) ? Math.min(Math.max(w!.end!, LEGAL_WINDOW.start + 1), LEGAL_WINDOW.end) : DEFAULT_WINDOW.end
  return start < end ? { start, end } : DEFAULT_WINDOW
}

function intersect(a: CallWindow, b: CallWindow | null): CallWindow | null {
  if (!b) return null
  const start = Math.max(a.start, b.start)
  const end = Math.min(a.end, b.end)
  return start < end ? { start, end } : null
}

export type WindowFailure = {
  zone: string
  local: LocalTime
  /** hours: outside the clock window; sunday / holiday: a marketing day rule; state_day: a state rule closed the day. */
  reason: 'hours' | 'sunday' | 'holiday' | 'state_day'
  holiday?: string
  /** The window that applied in that zone that day, when there was one. */
  window: CallWindow | null
}

export type WindowResult = { ok: true; locals: LocalTime[] } | { ok: false; locals: LocalTime[]; failures: WindowFailure[] }

/**
 * Is `now` inside the window in every zone? `window` is the account's (or, to
 * test an override, the legal ceiling). State rules and the marketing day rules
 * always apply on top and can only narrow it.
 */
export function windowOk(
  zones: readonly string[],
  now: Date,
  window: CallWindow,
  purpose: OutboundPurpose,
  states: readonly string[] = [],
): WindowResult {
  const locals = zones.map((z) => localTimeIn(z, now))
  const failures: WindowFailure[] = []
  for (const local of locals) {
    if (purpose === 'marketing' && local.weekday === 0) {
      failures.push({ zone: local.zone, local, reason: 'sunday', window: null })
      continue
    }
    const holiday = holidayOn(local.date)
    const stateRules = states.map((s) => STATE_WINDOWS[s]).filter((r): r is StateWindowRule => Boolean(r))
    if (holiday && (purpose === 'marketing' || stateRules.some((r) => r.holidays === 'federal'))) {
      failures.push({ zone: local.zone, local, reason: 'holiday', holiday: holiday.name, window: null })
      continue
    }
    let applied: CallWindow | null = intersect(LEGAL_WINDOW, window)
    let closedByState = false
    for (const rule of stateRules) {
      const day = rule.days?.[local.weekday]
      if (day === undefined) continue
      if (day === null) closedByState = true
      applied = applied ? intersect(applied, day) : null
    }
    if (closedByState || !applied) {
      failures.push({ zone: local.zone, local, reason: closedByState ? 'state_day' : 'hours', window: applied })
      continue
    }
    const minutes = local.hour * 60 + local.minute
    if (minutes < applied.start * 60 || minutes >= applied.end * 60) {
      failures.push({ zone: local.zone, local, reason: 'hours', window: applied })
    }
  }
  return failures.length ? { ok: false, locals, failures } : { ok: true, locals }
}

/**
 * The next moment the window is open in every zone, searched in 15-minute
 * steps for up to eight days. Used to DEFER an automation send rather than fail
 * it. Null when nothing opens (unknown zones, or a closed rule set).
 */
export function deferUntil(
  now: Date,
  zones: readonly string[],
  window: CallWindow,
  purpose: OutboundPurpose,
  states: readonly string[] = [],
): Date | null {
  if (zones.length === 0) return null
  const step = 15 * 60_000
  const start = Math.ceil(now.getTime() / step) * step
  for (let t = start; t <= now.getTime() + 8 * 86_400_000; t += step) {
    const at = new Date(t)
    if (windowOk(zones, at, window, purpose, states).ok) return at
  }
  return null
}
