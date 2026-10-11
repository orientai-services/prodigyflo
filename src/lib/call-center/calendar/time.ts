import { CALENDAR_ZONE } from './config'

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Wall-clock parts of a UTC instant in the calendar zone. */
export function zonedParts(at: Date, zone = CALENDAR_ZONE): Parts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  const map: Record<string, string> = {}
  for (const p of fmt.formatToParts(at)) map[p.type] = p.value
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    weekday: WEEKDAYS[map.weekday] ?? 0,
  }
}

/** UTC instant for a local wall-clock time in the zone (DST-safe). */
export function zonedToUtc(year: number, month: number, day: number, minuteOfDay: number, zone = CALENDAR_ZONE): Date {
  const guess = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60)
  let t = guess
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(t), zone)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    const diff = asUtc - guess
    if (diff === 0) break
    t -= diff
  }
  return new Date(t)
}

export function minuteOfDay(at: Date, zone = CALENDAR_ZONE): number {
  const p = zonedParts(at, zone)
  return p.hour * 60 + p.minute
}
