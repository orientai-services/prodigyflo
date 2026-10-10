/**
 * The no-answer cadence and the desk's scheduling window.
 *
 * Pure (no DB, no clock of its own) so every edge is unit-tested: DST days,
 * the 9:00–20:00 clamp, exhaustion. All wall times are in the LEAD's zone
 * (`CallLead.timeZone`), never the rep's.
 *
 * The zone math is a small Intl helper here rather than
 * `src/lib/telephony/timezones.ts`: that module pulls ~90 KB of area-code data
 * at import, and this one ships to the browser with the desk. The server's
 * compliance window (timezones.ts) stays the authority for real dials; this
 * window only decides when the desk *suggests* the next try.
 */

/** An answered call shorter than this counts as unanswered (cadence and auto-contact). */
export const CONNECTED_SECONDS = 20

/** Desk scheduling window, lead-local: 9:00 inclusive to 20:00 exclusive. */
export const DESK_WINDOW = { start: 9, end: 20 } as const

/** Where a clamped time lands: 10:00 the same day (too early) or the next day (too late). */
const CLAMP_HOUR = 10

export const DEFAULT_ZONE = 'America/Los_Angeles'

const MINUTE = 60_000

type Step =
  | { kind: 'after'; minutes: number; label: string }
  | { kind: 'day'; days: number; hour: number; label: string }
  | { kind: 'plusDays'; days: number; label: string }

/** Step n is scheduled after the n-th unanswered attempt. */
export const CADENCE_STEPS: readonly Step[] = [
  { kind: 'after', minutes: 5, label: 'In 5 minutes' },
  { kind: 'day', days: 1, hour: 10, label: 'Tomorrow 10:00' },
  { kind: 'day', days: 2, hour: 17, label: 'Day after tomorrow 17:00' },
  { kind: 'plusDays', days: 2, label: 'In 2 days' },
  { kind: 'plusDays', days: 3, label: 'In 3 days' },
  { kind: 'plusDays', days: 3, label: 'In 3 days' },
]

/**
 * Attempts a lead gets: the first call plus one per cadence step. The
 * unanswered attempt after step 6 exhausts the lead.
 */
export const TRY_LIMIT = CADENCE_STEPS.length + 1

export function cadenceExhausted(tries: number): boolean {
  return tries >= TRY_LIMIT
}

// ── Zone math ────────────────────────────────────────────────────────────────

export type WallTime = { year: number; month: number; day: number; hour: number; minute: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

/** A zone Intl accepts, else the desk default. A bad stored zone must not break the desk. */
export function safeZone(zone: string | null | undefined): string {
  if (!zone) return DEFAULT_ZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    return DEFAULT_ZONE
  }
}

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
    formatters.set(zone, f)
  }
  return f
}

/** Wall-clock parts of an instant in a zone. */
export function wallTime(at: Date, zone: string): WallTime {
  const parts = formatter(safeZone(zone)).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') }
}

/** The calendar date `days` after y-m-d, zone-free. */
export function addDays(date: Pick<WallTime, 'year' | 'month' | 'day'>, days: number): Pick<WallTime, 'year' | 'month' | 'day'> {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/**
 * The instant a wall time happens in a zone. Converges in two passes across a
 * DST change; a wall time inside a spring-forward gap lands just after it
 * (never reached here: the window is 9–20 and US clocks change at 2:00).
 */
export function instantOf(wall: WallTime, zone: string): Date {
  const z = safeZone(zone)
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  let guess = target
  for (let i = 0; i < 3; i += 1) {
    const seen = wallTime(new Date(guess), z)
    const diff = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - target
    if (diff === 0) break
    guess -= diff
  }
  return new Date(guess)
}

/** Same-day key ("2026-10-09") of an instant in a zone. */
export function dayKey(at: Date, zone: string): string {
  const w = wallTime(at, zone)
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`
}

/**
 * Into the desk window: before 9:00 moves to 10:00 the same day, 20:00 or
 * later to 10:00 the next day.
 */
export function clampToDeskWindow(at: Date, zone: string): Date {
  const w = wallTime(at, zone)
  if (w.hour < DESK_WINDOW.start) return instantOf({ ...w, hour: CLAMP_HOUR, minute: 0 }, zone)
  if (w.hour >= DESK_WINDOW.end) return instantOf({ ...addDays(w, 1), hour: CLAMP_HOUR, minute: 0 }, zone)
  return at
}

// ── The cadence ──────────────────────────────────────────────────────────────

/**
 * When to try again after the `tries`-th unanswered attempt (1-based), or null
 * when the lead is exhausted. `at` is when that attempt ended.
 */
export function nextCadenceAt(tries: number, at: string | Date, zone: string | null | undefined): string | null {
  if (!Number.isInteger(tries) || tries < 1 || cadenceExhausted(tries)) return null
  const step = CADENCE_STEPS[tries - 1]
  const z = safeZone(zone)
  const from = typeof at === 'string' ? new Date(at) : at
  if (Number.isNaN(from.getTime())) return null
  let next: Date
  if (step.kind === 'after') {
    next = new Date(from.getTime() + step.minutes * MINUTE)
  } else if (step.kind === 'day') {
    next = instantOf({ ...addDays(wallTime(from, z), step.days), hour: step.hour, minute: 0 }, z)
  } else {
    // Same wall time N days on, so a DST change doesn't shift it by an hour.
    const w = wallTime(from, z)
    next = instantOf({ ...addDays(w, step.days), hour: w.hour, minute: w.minute }, z)
  }
  return clampToDeskWindow(next, z).toISOString()
}

/** "Step 2 of 6 · Tomorrow 10:00" for the desk. */
export function cadenceStepLabel(tries: number): string | null {
  if (tries < 1 || cadenceExhausted(tries)) return null
  return `Step ${tries} of ${CADENCE_STEPS.length} · ${CADENCE_STEPS[tries - 1].label}`
}

// ── Carrier results ──────────────────────────────────────────────────────────

/** What a finished carrier call means for the lead. */
export type CarrierVerdict = 'unknown' | 'reached' | 'unanswered'

export function carrierVerdict(call: {
  outcome: string | null | undefined
  status: string | null | undefined
  talkSeconds: number | null | undefined
}): CarrierVerdict {
  // The sweep's give-up (status 'unknown', no real outcome) is never guessed at.
  if (!call.outcome || (call.status === 'unknown' && call.outcome !== 'CONNECTED')) return 'unknown'
  if (call.outcome === 'CONNECTED' && (call.talkSeconds ?? 0) >= CONNECTED_SECONDS) return 'reached'
  return 'unanswered'
}

// ── Callbacks ────────────────────────────────────────────────────────────────

export const CALLBACK_MAX_DAYS = 60

/** Server-side check for a callback time: a real instant, in the future, at most 60 days out. */
export function validateCallbackAt(raw: unknown, now: Date): { ok: true; at: Date } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.length > 40) return { ok: false, error: 'Pick a time for the call back.' }
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return { ok: false, error: 'Pick a time for the call back.' }
  if (at.getTime() <= now.getTime()) return { ok: false, error: 'The call back time has already passed.' }
  if (at.getTime() > now.getTime() + CALLBACK_MAX_DAYS * 24 * 60 * MINUTE) {
    return { ok: false, error: `Pick a time within ${CALLBACK_MAX_DAYS} days.` }
  }
  return { ok: true, at }
}

export type CallbackChip = { id: string; label: string; at: string }

/** The scheduler's quick picks, each clamped into the desk window. */
export function callbackChips(now: Date, zone: string | null | undefined): CallbackChip[] {
  const z = safeZone(zone)
  const w = wallTime(now, z)
  const tomorrow = addDays(w, 1)
  const raw: [string, string, Date][] = [
    ['hour', 'In 1 hour', new Date(now.getTime() + 60 * MINUTE)],
    ['t10', 'Tomorrow 10:00', instantOf({ ...tomorrow, hour: 10, minute: 0 }, z)],
    ['t17', 'Tomorrow 17:00', instantOf({ ...tomorrow, hour: 17, minute: 0 }, z)],
    ['d3', 'In 3 days', instantOf({ ...addDays(w, 3), hour: w.hour, minute: w.minute < 30 ? 0 : 30 }, z)],
  ]
  return raw.map(([id, label, at]) => ({ id, label, at: clampToDeskWindow(at, z).toISOString() }))
}

export type SlotDay = { key: string; year: number; month: number; day: number }

/** The next `count` lead-local days, today first. */
export function slotDays(now: Date, zone: string | null | undefined, count = 14): SlotDay[] {
  const z = safeZone(zone)
  const w = wallTime(now, z)
  return Array.from({ length: count }, (_, i) => {
    const d = addDays(w, i)
    return { ...d, key: `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` }
  })
}

/** 30-minute slots 9:00–19:30 lead-local on one day, only the ones still ahead. */
export function daySlots(day: Pick<WallTime, 'year' | 'month' | 'day'>, zone: string | null | undefined, now: Date): string[] {
  const z = safeZone(zone)
  const out: string[] = []
  for (let hour = DESK_WINDOW.start; hour < DESK_WINDOW.end; hour += 1) {
    for (const minute of [0, 30]) {
      const at = instantOf({ ...day, hour, minute }, z)
      if (at.getTime() > now.getTime()) out.push(at.toISOString())
    }
  }
  return out
}

/** "Tue, Oct 13, 2:30 pm" in a zone. */
export function zonedLabel(iso: string, zone: string | null | undefined, withDay = true): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: safeZone(zone),
    ...(withDay ? { weekday: 'short', month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(new Date(iso))
    .replace(' AM', ' am')
    .replace(' PM', ' pm')
}
