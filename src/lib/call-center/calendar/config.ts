/**
 * Call Center Calendar config (Door 2 leads only: Meta form leads and
 * ad-number callers). Fully separate from the Master Calendar.
 */

export const CALENDAR_ZONE = 'America/Los_Angeles'
export const VISIT_MINUTES = 90
export const STEP_MINUTES = 30
/** First allowed start, minutes after local midnight (9:00 AM). */
export const FIRST_START_MINUTE = 9 * 60
/** Last allowed start, minutes after local midnight (5:30 PM). */
export const LAST_START_MINUTE = 17 * 60 + 30
export const MIN_LEAD_MINUTES = 120
export const MAX_DAYS_AHEAD = 5
/** No two visits for one rep may start within this many minutes of each other. */
export const REP_GAP_MINUTES = 90
export const REMINDER_OFFSETS_HOURS = [24, 3] as const
export const NO_SHOW_CALLBACK_MINUTES = 120

export type CalendarRep = { key: string; label: string }

/**
 * Rep list. Overridable with CALL_CENTER_CALENDAR_REPS ("key:Label,key:Label").
 * No per-day cap.
 */
export const DEFAULT_REPS: readonly CalendarRep[] = [
  { key: 'gatsby', label: 'Gatsby' },
  { key: 'hector', label: 'Hector' },
  { key: 'dakota', label: 'Dakota' },
]

export function calendarReps(env: Record<string, string | undefined> = process.env): CalendarRep[] {
  const raw = env.CALL_CENTER_CALENDAR_REPS?.trim()
  if (!raw) return [...DEFAULT_REPS]
  const reps = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [key, label] = part.split(':')
      return { key: key.trim().toLowerCase(), label: (label ?? key).trim() }
    })
    .filter((r) => /^[a-z0-9_-]{1,32}$/.test(r.key))
  return reps.length ? reps : [...DEFAULT_REPS]
}

/** Block colors, in rep-list order. The CSS defines one class per name (`cal-rep-<name>`). */
export const REP_COLORS = ['teal', 'amber', 'violet', 'rose', 'sky', 'lime'] as const
export type RepColor = (typeof REP_COLORS)[number]

/**
 * One fixed color per rep: the rep's place in the config list picks it, so the
 * same rep always gets the same color. A key not in the list (legacy data)
 * still gets a stable color from its letters.
 */
export function repColor(key: string, reps: readonly CalendarRep[] = calendarReps()): RepColor {
  const index = reps.findIndex((r) => r.key === key)
  if (index >= 0) return REP_COLORS[index % REP_COLORS.length]
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return REP_COLORS[hash % REP_COLORS.length]
}

function flagOn(value: string | undefined): boolean {
  return ['1', 'true', 'on', 'yes'].includes((value ?? '').trim().toLowerCase())
}

/** The Calendar tab. Default OFF: hidden. */
export function calendarEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flagOn(env.CALL_CENTER_CALENDAR)
}

/** Place a HOLD for a new lead automatically. Default OFF. Needs the calendar on. */
export function autobookEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return calendarEnabled(env) && flagOn(env.CALL_CENTER_AUTOBOOK)
}

/** Client reminders go by text only once A2P texting is approved. Default OFF (email). */
export function clientTextEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flagOn(env.CALL_CENTER_A2P_APPROVED)
}
