/**
 * Daily Desk calendar helpers. Pure — the board page and tests share these.
 * Visual SoT: prodigyflo-full-prototype.html (cream paper, month grid, chips).
 */

export const DESK_TIMEZONE = 'America/Los_Angeles'

export type DeskChip = {
  appointmentId: string
  updatedAt?: string
  startsAt: string
  status: string
  clientId: string
  firstName: string
  lastName: string
  timeLabel: string
  ownerName: string | null
  missingDocs: number
  email: string
  phone: string
}

export type DeskDay = {
  iso: string
  day: number
  inMonth: boolean
  isToday: boolean
  chips: DeskChip[]
}

export type DeskLead = {
  clientId: string
  firstName: string
  lastName: string
  ownerName: string | null
  missingDocs: number
  email: string
  phone: string
}

export type DeskCloser = { id: string; name: string }

export type DeskBoard = {
  timezone: string
  month: string
  title: string
  today: string
  days: DeskDay[]
  unscheduled: DeskLead[]
  unscheduledTotal: number
  closers: DeskCloser[]
  unassignedCount: number
  canAssign: boolean
  canBook: boolean
}

export function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** `YYYY-MM` or today's calendar month. Invalid values fall back to today. */
export function parseMonth(raw: string | undefined, now = new Date()): { year: number; monthIndex: number; key: string } {
  const match = raw?.match(/^(\d{4})-(\d{2})$/)
  if (match) {
    const year = Number(match[1])
    const monthIndex = Number(match[2]) - 1
    if (year >= 2000 && year <= 2100 && monthIndex >= 0 && monthIndex <= 11) {
      return { year, monthIndex, key: `${year}-${String(monthIndex + 1).padStart(2, '0')}` }
    }
  }
  const year = now.getFullYear()
  const monthIndex = now.getMonth()
  return { year, monthIndex, key: `${year}-${String(monthIndex + 1).padStart(2, '0')}` }
}

export function shiftMonth(key: string, delta: number): string {
  const { year, monthIndex } = parseMonth(key)
  const d = new Date(year, monthIndex + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function monthTitle(year: number, monthIndex: number): string {
  return new Date(year, monthIndex, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

/**
 * Sunday-first month grid. 5 rows when the month fits, otherwise 6.
 * Matches the prototype's `off = first.getDay()` walk.
 */
export function monthGrid(year: number, monthIndex: number): { iso: string; day: number; inMonth: boolean }[] {
  const first = new Date(year, monthIndex, 1)
  const startOffset = first.getDay()
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate()
  const prevMonthDays = new Date(year, monthIndex, 0).getDate()
  const cells: { iso: string; day: number; inMonth: boolean }[] = []

  for (let i = 0; i < 42; i++) {
    const dayNum = i - startOffset + 1
    if (dayNum < 1) {
      const day = prevMonthDays + dayNum
      cells.push({ iso: isoDate(new Date(year, monthIndex - 1, day)), day, inMonth: false })
    } else if (dayNum > daysInMonth) {
      const day = dayNum - daysInMonth
      cells.push({ iso: isoDate(new Date(year, monthIndex + 1, day)), day, inMonth: false })
    } else {
      cells.push({ iso: isoDate(new Date(year, monthIndex, dayNum)), day: dayNum, inMonth: true })
    }
  }

  if (cells.slice(35).every((c) => !c.inMonth)) return cells.slice(0, 35)
  return cells
}

/** Civil date `YYYY-MM-DD` + `HH:MM` in `timeZone` → UTC Date. Independent of the host zone. */
export function zonedDate(ymd: string, hm: string, timeZone: string): Date {
  const [year, month, day] = ymd.split('-').map(Number)
  const [hour, minute] = hm.split(':').map(Number)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const partsOf = (ms: number) => {
    const p = Object.fromEntries(formatter.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
    return {
      year: Number(p.year),
      month: Number(p.month),
      day: Number(p.day),
      hour: Number(p.hour),
      minute: Number(p.minute),
    }
  }
  let ms = Date.UTC(year, month - 1, day, hour, minute)
  for (let i = 0; i < 4; i++) {
    const p = partsOf(ms)
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    const want = Date.UTC(year, month - 1, day, hour, minute)
    ms += want - got
  }
  return new Date(ms)
}

export function timeLabel(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00'
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00'
  return `${hour}:${minute}`
}

export function civilDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const y = parts.find((p) => p.type === 'year')?.value
  const m = parts.find((p) => p.type === 'month')?.value
  const d = parts.find((p) => p.type === 'day')?.value
  return `${y}-${m}-${d}`
}

export function missingDocsLabel(count: number): string {
  if (count <= 0) return 'docs in'
  return `${count} missing`
}

/** Inclusive start, exclusive end of the month grid the desk is showing. */
export function deskMonthRange(monthKey: string, timeZone: string): { rangeStart: Date; rangeEnd: Date } {
  const { year, monthIndex } = parseMonth(monthKey)
  const cells = monthGrid(year, monthIndex)
  const rangeStart = zonedDate(cells[0]!.iso, '00:00', timeZone)
  const lastDay = new Date(`${cells.at(-1)!.iso}T12:00:00Z`)
  lastDay.setUTCDate(lastDay.getUTCDate() + 1)
  const rangeEnd = zonedDate(lastDay.toISOString().slice(0, 10), '00:00', timeZone)
  return { rangeStart, rangeEnd }
}

/**
 * A call occupies the board when it has not ended, or when its start falls on
 * the month currently shown. A finished booking must not sit in Unscheduled
 * and on that month's calendar at the same time.
 */
export function countsAsDeskBooking(
  appt: { status: string; startsAt: Date; endsAt: Date },
  now: Date,
  rangeStart: Date,
  rangeEnd: Date,
): boolean {
  return (
    (appt.status === 'SCHEDULED' || appt.status === 'CONFIRMED') &&
    (appt.endsAt > now || (appt.startsAt >= rangeStart && appt.startsAt < rangeEnd))
  )
}

/**
 * The board colors a chip from the client's assigned closer.
 * A call that already started keeps its own appointment owner for history,
 * and assignment does not rewrite that row.
 */
export function deskChipCloserName(clientOwnerName: string | null): string | null {
  return clientOwnerName
}

/** Soonest call that has not ended. A finished booking on this month is only the fallback. */
export function deskBookingToShow<T extends { status: string; startsAt: Date; endsAt: Date }>(
  appointments: readonly T[],
  now: Date,
  rangeStart: Date,
  rangeEnd: Date,
): T | undefined {
  const qualifying = appointments.filter((appt) => countsAsDeskBooking(appt, now, rangeStart, rangeEnd))
  const upcoming = qualifying
    .filter((appt) => appt.endsAt > now)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  if (upcoming.length) return upcoming[0]
  return [...qualifying].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0]
}
