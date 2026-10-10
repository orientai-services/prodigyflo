import { localTimeIn } from './timezones'

/**
 * The speed-to-lead clock (docs/DIALER_POWER.md Lane C, item 4). Pure, so the
 * windows can be tested without a database.
 *
 * A new form lead that nobody has touched starts a clock. The clock only runs
 * 9:00–20:00 America/Los_Angeles: a lead that lands at 23:00 has its clock
 * start at 9:00 the next morning, and one that lands at 19:58 has two minutes
 * on it by 20:00 and picks up again at 9:00. Alerts only go out while the
 * clock is running, so nobody is paged at night.
 */

export const SPEED_ZONE = 'America/Los_Angeles'
export const SPEED_OPEN_HOUR = 9
export const SPEED_CLOSE_HOUR = 20
/** Minutes on the clock before the reps and telephony managers hear about it. */
export const SPEED_ALERT_MINUTES = 5
/** Minutes on the clock before super admins hear about it. */
export const SPEED_ESCALATE_MINUTES = 15
/** Leads older than this are no longer "new". */
export const SPEED_LOOKBACK_MS = 24 * 60 * 60_000

const OPEN = SPEED_OPEN_HOUR * 60
const CLOSE = SPEED_CLOSE_HOUR * 60
const MINUTE = 60_000

function minuteOfDay(t: number): number {
  const local = localTimeIn(SPEED_ZONE, new Date(t))
  return local.hour * 60 + local.minute
}

/** Milliseconds into the current wall-clock minute (the zone's offset is whole minutes). */
function intoMinute(t: number): number {
  return ((t % MINUTE) + MINUTE) % MINUTE
}

/** Is the clock running at `now`? */
export function speedClockOpen(now: Date): boolean {
  const m = minuteOfDay(now.getTime())
  return m >= OPEN && m < CLOSE
}

/**
 * Milliseconds of open clock between `from` and `to`. Walks open/closed
 * segments, so it takes a handful of steps per day crossed, not one per
 * minute. On the two DST nights a jump to "9:00 tomorrow" can land an hour
 * off; the landing is corrected back to 9:00 (or forward from 8:00).
 */
export function speedClockMs(from: Date, to: Date): number {
  let t = from.getTime()
  const end = to.getTime()
  let total = 0
  for (let guard = 0; t < end && guard < 64; guard++) {
    const m = minuteOfDay(t)
    if (m < OPEN || m >= CLOSE) {
      const wait = m < OPEN ? OPEN - m : 24 * 60 - m + OPEN
      t += wait * MINUTE - intoMinute(t)
      const landed = minuteOfDay(t)
      if (landed > OPEN && landed < CLOSE) t -= (landed - OPEN) * MINUTE
      continue
    }
    const segmentEnd = Math.min(end, t + (CLOSE - m) * MINUTE - intoMinute(t))
    total += segmentEnd - t
    t = segmentEnd
  }
  return total
}

export function speedClockMinutes(from: Date, to: Date): number {
  return Math.floor(speedClockMs(from, to) / MINUTE)
}

export type SpeedState = { createdAt: Date; speedAlertedAt: Date | null; speedEscalatedAt: Date | null }

/**
 * Which alerts are due for an untouched lead right now. Each fires once (the
 * columns say whether it already went out), and only while the clock runs.
 */
export function speedAlertsDue(lead: SpeedState, now: Date): { alert: boolean; escalate: boolean; minutes: number } {
  if (now.getTime() - lead.createdAt.getTime() > SPEED_LOOKBACK_MS || !speedClockOpen(now)) {
    return { alert: false, escalate: false, minutes: 0 }
  }
  const minutes = speedClockMinutes(lead.createdAt, now)
  return {
    alert: !lead.speedAlertedAt && minutes >= SPEED_ALERT_MINUTES,
    escalate: !lead.speedEscalatedAt && minutes >= SPEED_ESCALATE_MINUTES,
    minutes,
  }
}
