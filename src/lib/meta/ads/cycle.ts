/**
 * Spend cycle math (docs/META_ADS_SCS.md §3.5). Pure; dates are calendar days
 * in the ad account's timezone, so a cycle never shifts across DST.
 */

/** 'YYYY-MM-DD' for an instant in a timezone. Bad zones fall back to UTC. */
export function dayInZone(at: Date, tz: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

export function addDays(iso: string, days: number): string {
  return new Date((dayNumber(iso) + days) * 86_400_000).toISOString().slice(0, 10)
}

/** Whole calendar days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round(dayNumber(b) - dayNumber(a))
}

/** The UTC instant of local midnight at the start of `iso` in `tz`. */
export function zonedMidnight(iso: string, tz: string | null | undefined): Date {
  const zone = tz || 'UTC'
  const [y, m, d] = iso.split('-').map(Number)
  let guess = Date.UTC(y, m - 1, d)
  // Two passes settle the offset, including on DST change days.
  for (let i = 0; i < 3; i++) {
    let parts: Record<string, number>
    try {
      parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
          hour: 'numeric', minute: 'numeric', second: 'numeric',
        }).formatToParts(new Date(guess))
          .filter((p) => p.type !== 'literal')
          .map((p) => [p.type, Number(p.value)]),
      )
    } catch {
      return new Date(Date.UTC(y, m - 1, d))
    }
    const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const offset = asIfUtc - guess
    const next = Date.UTC(y, m - 1, d) - offset
    if (next === guess) break
    guess = next
  }
  return new Date(guess)
}

export type CycleState = { day: number; startDay: string; endsAt: Date; overdue: boolean }

/** Day 1 is the start day in the account timezone; overdue when day > lengthDays. */
export function cycleState(startedAt: Date, lengthDays: number, now: Date, tz: string | null | undefined): CycleState {
  const startDay = dayInZone(startedAt, tz)
  const today = dayInZone(now, tz)
  const day = daysBetween(startDay, today) + 1
  return { day, startDay, endsAt: zonedMidnight(addDays(startDay, lengthDays), tz), overdue: day > lengthDays }
}

/** ACCOUNT daily spend from the start day through `today`, minus the excluded part of the start day, floored at 0. */
export function cycleSpend(
  dailyRows: { date: string; spend: number }[],
  startDay: string,
  today: string,
  startDayExcludedSpend: number,
): number {
  let sum = 0
  for (const r of dailyRows) if (r.date >= startDay && r.date <= today) sum += r.spend
  return Math.max(0, Math.round((sum - startDayExcludedSpend) * 100) / 100)
}

/**
 * A closed cycle's spend. Its end day is shared with the next cycle when the
 * next one started that same day: the next cycle owns the end day's spend from
 * the switch hour on (end-day spend minus the next cycle's start-day
 * exclusion), so that part is taken off here and never counted twice.
 */
export function closedCycleSpend(
  dailyRows: { date: string; spend: number }[],
  startDay: string,
  endDay: string,
  startDayExcludedSpend: number,
  next: { startDay: string; startDayExcludedSpend: number } | null,
): number {
  const base = cycleSpend(dailyRows, startDay, endDay, startDayExcludedSpend)
  if (!next || next.startDay !== endDay) return base
  const endDaySpend = dailyRows.reduce((a, r) => (r.date === endDay ? a + r.spend : a), 0)
  const handedOver = Math.max(0, endDaySpend - next.startDayExcludedSpend)
  return Math.max(0, Math.round((base - handedOver) * 100) / 100)
}

/** Spend on the start day before the cycle began, from the hourly breakdown. */
export function excludedFromHours(hours: { hour: number; spend: number }[], startedAt: Date, tz: string | null | undefined): number {
  const hourNow = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', hour: 'numeric' }).format(startedAt),
  )
  const sum = hours.filter((h) => h.hour < hourNow).reduce((a, h) => a + h.spend, 0)
  return Math.round(sum * 100) / 100
}

export const FINAL_AFTER_DAYS = 3
export const KEEP_CLOSED_CYCLES = 24

export function finalAfter(endedAt: Date): Date {
  return new Date(endedAt.getTime() + FINAL_AFTER_DAYS * 86_400_000)
}

export function clampCycleDays(n: unknown): number | null {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isInteger(v) || v < 1 || v > 90) return null
  return v
}
