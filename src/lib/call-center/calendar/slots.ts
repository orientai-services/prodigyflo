import {
  FIRST_START_MINUTE,
  LAST_START_MINUTE,
  MAX_DAYS_AHEAD,
  MIN_LEAD_MINUTES,
  REP_GAP_MINUTES,
  STEP_MINUTES,
  VISIT_MINUTES,
} from './config'
import { minuteOfDay, zonedParts, zonedToUtc } from './time'

const MIN = 60_000

export type BusySlot = { repKey: string; startsAt: Date }
export type RepWindow = { startMinute: number; endMinute: number; active: boolean }
/** Per-rep, per-weekday override (CallCenterRepHours rows). */
export type RepHours = Record<string, Partial<Record<number, RepWindow>>>

export type OpenSlot = { repKey: string; startsAt: Date; endsAt: Date }

function windowFor(hours: RepHours | undefined, repKey: string, weekday: number): RepWindow {
  const w = hours?.[repKey]?.[weekday]
  if (!w) return { startMinute: FIRST_START_MINUTE, endMinute: LAST_START_MINUTE, active: true }
  return {
    startMinute: Math.max(FIRST_START_MINUTE, w.startMinute),
    endMinute: Math.min(LAST_START_MINUTE, w.endMinute),
    active: w.active,
  }
}

/** Pacific calendar-day number, so "5 days ahead" means through the 5th local day. */
function localDayIndex(at: Date): number {
  const p = zonedParts(at)
  return Math.round(Date.UTC(p.year, p.month - 1, p.day) / 86_400_000)
}

/** Why a proposed start is not allowed, or null when it is. */
export function slotProblem(
  input: { repKey: string; startsAt: Date; now: Date; busy: BusySlot[]; hours?: RepHours; ignoreStart?: Date },
): string | null {
  const { repKey, startsAt, now } = input
  if (Number.isNaN(startsAt.getTime())) return 'invalid time'
  if (startsAt.getUTCSeconds() !== 0 || startsAt.getUTCMilliseconds() !== 0) return 'not on a 30-minute step'
  const mod = minuteOfDay(startsAt)
  if (mod % STEP_MINUTES !== 0) return 'not on a 30-minute step'
  const w = windowFor(input.hours, repKey, zonedParts(startsAt).weekday)
  if (!w.active) return 'rep is off that day'
  if (mod < w.startMinute || mod > w.endMinute) return 'outside 9:00 AM to 5:30 PM PT'
  if (startsAt.getTime() - now.getTime() < MIN_LEAD_MINUTES * MIN) return 'less than 2 hours out'
  if (localDayIndex(startsAt) - localDayIndex(now) > MAX_DAYS_AHEAD) return 'more than 5 days ahead'
  for (const b of input.busy) {
    if (b.repKey !== repKey) continue
    if (input.ignoreStart && b.startsAt.getTime() === input.ignoreStart.getTime()) continue
    if (Math.abs(b.startsAt.getTime() - startsAt.getTime()) < REP_GAP_MINUTES * MIN) return 'rep already has a visit then'
  }
  return null
}

/** Every open start for the given reps, oldest first, UTC. */
export function openSlots(input: { reps: string[]; now: Date; busy: BusySlot[]; hours?: RepHours }): OpenSlot[] {
  const out: OpenSlot[] = []
  const today = zonedParts(input.now)
  for (let d = 0; d <= MAX_DAYS_AHEAD; d++) {
    // Noon UTC-ish anchor avoids DST edges when stepping days.
    const anchor = new Date(Date.UTC(today.year, today.month - 1, today.day + d, 12))
    const { year, month, day } = { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() + 1, day: anchor.getUTCDate() }
    for (let m = FIRST_START_MINUTE; m <= LAST_START_MINUTE; m += STEP_MINUTES) {
      const startsAt = zonedToUtc(year, month, day, m)
      for (const repKey of input.reps) {
        if (slotProblem({ repKey, startsAt, now: input.now, busy: input.busy, hours: input.hours })) continue
        out.push({ repKey, startsAt, endsAt: new Date(startsAt.getTime() + VISIT_MINUTES * MIN) })
      }
    }
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}
