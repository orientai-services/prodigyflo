/**
 * The planner's pure helpers (docs/CALENDAR.md §2–3): URL state, ranges, grid
 * placement, lanes, month cells, scheduler chips. Client-safe: no database,
 * no `process.env` reads. Every date is a Pacific day key 'YYYY-MM-DD' or a
 * UTC instant; wall times are always shown in Pacific.
 */
import {
  CALENDAR_ZONE,
  FIRST_START_MINUTE,
  LAST_START_MINUTE,
  MAX_DAYS_AHEAD,
  MIN_LEAD_MINUTES,
  REP_GAP_MINUTES,
  STEP_MINUTES,
  type RepColor,
} from './config'
import type { LeadPhoneView } from '../phone-display'
import type { SlotStatus } from './outcomes'
import { slotProblem, type BusySlot, type RepHours } from './slots'
import { minuteOfDay, zonedParts, zonedToUtc } from './time'

export type CalendarView = 'day' | 'week' | 'month'

/** The week and day grids run 8 AM to 8 PM Pacific. */
export const GRID_START_MINUTE = 8 * 60
export const GRID_END_MINUTE = 20 * 60
const GRID_MINUTES = GRID_END_MINUTE - GRID_START_MINUTE
const MIN = 60_000
const DAY = 86_400_000

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// ── View models handed from the server loader to the client planner ─────────

export type RepVM = { key: string; label: string; color: RepColor }

export type VisitVM = {
  sourceBrand?: 'SunOff'
  id: string
  leadId: string
  name: string
  last4: string | null
  language: 'EN' | 'ES'
  repKey: string
  startsAt: string
  endsAt: string
  status: SlotStatus
  /** The lead's last note (desk notes only, never the calendar's own lines). */
  note: string | null
  /** Full number, only for a viewer allowed to see this lead's (lead-phones.ts). */
  phone?: LeadPhoneView | null
}

export type RailLeadVM = { sourceBrand?: 'SunOff'; id: string; name: string; last4: string | null; language: 'EN' | 'ES'; at: string; phone?: LeadPhoneView | null }

/** What the scheduler needs to grey out chips exactly as the server will refuse them. */
export type SchedulerData = {
  now: string
  reps: RepVM[]
  busy: { repKey: string; startsAt: string }[]
  hours: RepHours
}

export type CalendarVM = {
  view: CalendarView
  date: string
  rep: string | null
  /** The URL named a view; without one a phone switches itself to Day. */
  viewSet: boolean
  now: string
  reps: RepVM[]
  visits: VisitVM[]
  nextHours: VisitVM[]
  toSchedule: RailLeadVM[]
  followUps: RailLeadVM[]
  scheduler: SchedulerData
}

// ── Day keys ─────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function keyOf(year: number, month: number, day: number): string {
  // Through Date.UTC so day 0 / day 32 roll over correctly.
  const d = new Date(Date.UTC(year, month - 1, day, 12))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** The Pacific calendar day of a UTC instant. */
export function dayKeyOf(at: Date): string {
  const p = zonedParts(at, CALENDAR_ZONE)
  return keyOf(p.year, p.month, p.day)
}

export function parseDayKey(key: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (keyOf(year, month, day) !== key) return null
  return { year, month, day }
}

function partsOf(key: string): { year: number; month: number; day: number } {
  const p = parseDayKey(key)
  if (!p) throw new Error(`bad day key: ${key}`)
  return p
}

export function addDays(key: string, n: number): string {
  const p = partsOf(key)
  return keyOf(p.year, p.month, p.day + n)
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(key: string): number {
  const p = partsOf(key)
  return new Date(Date.UTC(p.year, p.month - 1, p.day, 12)).getUTCDay()
}

/** Days between two keys (b − a). */
export function daysBetween(a: string, b: string): number {
  const pa = partsOf(a)
  const pb = partsOf(b)
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / DAY)
}

/** Weeks start on Monday. */
export function weekStart(key: string): string {
  return addDays(key, -((weekdayOf(key) + 6) % 7))
}

export function weekDays(key: string): string[] {
  const first = weekStart(key)
  return Array.from({ length: 7 }, (_, i) => addDays(first, i))
}

/** Local midnight of a day key, as a UTC instant. */
export function dayStartUtc(key: string): Date {
  const p = partsOf(key)
  return zonedToUtc(p.year, p.month, p.day, 0)
}

export type MonthCell = { key: string; day: number; inMonth: boolean }

/** The month as Monday-first weeks: 5 or 6 rows of 7, padded with the neighbours' days. */
export function monthCells(key: string): MonthCell[][] {
  const p = partsOf(key)
  const first = keyOf(p.year, p.month, 1)
  const start = weekStart(first)
  const weeks: MonthCell[][] = []
  let cursor = start
  do {
    const week: MonthCell[] = []
    for (let i = 0; i < 7; i++) {
      const c = partsOf(cursor)
      week.push({ key: cursor, day: c.day, inMonth: c.month === p.month })
      cursor = addDays(cursor, 1)
    }
    weeks.push(week)
  } while (partsOf(cursor).month === p.month)
  return weeks
}

/** The days a view shows and the UTC span to load for them. */
export function rangeFor(view: CalendarView, key: string): { days: string[]; from: Date; to: Date } {
  const days = view === 'day' ? [key] : view === 'week' ? weekDays(key) : monthCells(key).flat().map((c) => c.key)
  return { days, from: dayStartUtc(days[0]), to: dayStartUtc(addDays(days[days.length - 1], 1)) }
}

/** ‹ / ›: a day, a week or a month. A month step lands on the 1st. */
export function shiftDate(view: CalendarView, key: string, dir: 1 | -1): string {
  if (view === 'day') return addDays(key, dir)
  if (view === 'week') return addDays(key, 7 * dir)
  const p = partsOf(key)
  return keyOf(p.year, p.month + dir, 1)
}

function short(key: string): { mon: string; day: number; year: number } {
  const p = partsOf(key)
  return { mon: MONTHS[p.month - 1].slice(0, 3), day: p.day, year: p.year }
}

/** "Oct 12 – 18, 2026", "Monday, Oct 12, 2026", "October 2026". */
export function rangeLabel(view: CalendarView, key: string): string {
  if (view === 'month') {
    const p = partsOf(key)
    return `${MONTHS[p.month - 1]} ${p.year}`
  }
  if (view === 'day') {
    const d = short(key)
    return `${WEEKDAYS[weekdayOf(key)]}, ${d.mon} ${d.day}, ${d.year}`
  }
  const days = weekDays(key)
  const a = short(days[0])
  const b = short(days[6])
  if (a.year !== b.year) return `${a.mon} ${a.day}, ${a.year} – ${b.mon} ${b.day}, ${b.year}`
  if (a.mon !== b.mon) return `${a.mon} ${a.day} – ${b.mon} ${b.day}, ${b.year}`
  return `${a.mon} ${a.day} – ${b.day}, ${b.year}`
}

/** "Mon 12" for a column head. */
export function dayHead(key: string): { weekday: string; day: number } {
  return { weekday: WEEKDAYS[weekdayOf(key)].slice(0, 3), day: partsOf(key).day }
}

export function monthTitle(key: string): string {
  const p = partsOf(key)
  return `${MONTHS[p.month - 1]} ${p.year}`
}

// ── URL state ────────────────────────────────────────────────────────────────

export type CalendarState = { view: CalendarView; date: string; rep: string | null }

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** `?view=&date=&rep=` → a safe state. Unknown values fall back to this week, all reps. */
export function parseCalendarParams(
  params: Record<string, string | string[] | undefined>,
  now: Date,
  repKeys: readonly string[],
): CalendarState & { viewSet: boolean } {
  const rawView = one(params.view)
  const view: CalendarView = rawView === 'day' || rawView === 'month' ? rawView : 'week'
  const rawDate = one(params.date) ?? ''
  const date = parseDayKey(rawDate) ? rawDate : dayKeyOf(now)
  const rawRep = (one(params.rep) ?? '').toLowerCase()
  const rep = repKeys.includes(rawRep) ? rawRep : null
  return { view, date, rep, viewSet: rawView === 'day' || rawView === 'week' || rawView === 'month' }
}

/** Every link inside the calendar stays in the dialer's Booked section, `/call-center?s=booked`. */
export function calendarHref(state: CalendarState, patch: Partial<CalendarState> = {}): string {
  const next = { ...state, ...patch }
  const q = new URLSearchParams({ s: 'booked', view: next.view, date: next.date })
  if (next.rep) q.set('rep', next.rep)
  return `/call-center?${q.toString()}`
}

// ── Times ────────────────────────────────────────────────────────────────────

/** "9:00 AM" from minutes after midnight. Built by hand so server and browser print the same bytes. */
export function minuteLabel(minute: number, withPeriod = true): string {
  const h = Math.floor(minute / 60) % 24
  const m = minute % 60
  const period = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return withPeriod ? `${h12}:${pad(m)} ${period}` : `${h12}:${pad(m)}`
}

export function timeLabel(at: Date | string): string {
  return minuteLabel(minuteOfDay(new Date(at)))
}

/** "9:00 – 10:30 AM", or "11:00 AM – 12:30 PM" across noon. */
export function timeRange(start: Date | string, end: Date | string): string {
  const a = minuteOfDay(new Date(start))
  const b = minuteOfDay(new Date(end))
  const samePeriod = a < 720 === b < 720
  return samePeriod ? `${minuteLabel(a, false)} – ${minuteLabel(b)}` : `${minuteLabel(a)} – ${minuteLabel(b)}`
}

/** "Tue, Oct 13 · 10:00 – 11:30 AM". */
export function visitWhen(start: Date | string, end: Date | string): string {
  const key = dayKeyOf(new Date(start))
  const d = short(key)
  return `${WEEKDAYS[weekdayOf(key)].slice(0, 3)}, ${d.mon} ${d.day} · ${timeRange(start, end)}`
}

/** "Nate Fuller" → "Nate F." for the month chips. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return name.trim()
  return `${parts[0]} ${parts[parts.length - 1][0]}.`
}

// ── Grid placement ───────────────────────────────────────────────────────────

/** Where a visit sits in its day column: fractions of the 8 AM–8 PM grid. */
export function blockPlacement(startsAt: Date | string, endsAt: Date | string): { dayKey: string; top: number; height: number } {
  const start = new Date(startsAt)
  const from = minuteOfDay(start)
  const length = Math.max(STEP_MINUTES, Math.round((new Date(endsAt).getTime() - start.getTime()) / MIN))
  const a = Math.min(Math.max(from, GRID_START_MINUTE), GRID_END_MINUTE - STEP_MINUTES)
  const b = Math.min(Math.max(from + length, a + STEP_MINUTES), GRID_END_MINUTE)
  return { dayKey: dayKeyOf(start), top: (a - GRID_START_MINUTE) / GRID_MINUTES, height: (b - a) / GRID_MINUTES }
}

/** The now line's height in today's column, or null when the clock is off the grid. */
export function nowOffset(now: Date, dayKey: string): number | null {
  if (dayKeyOf(now) !== dayKey) return null
  const m = minuteOfDay(now)
  if (m < GRID_START_MINUTE || m > GRID_END_MINUTE) return null
  return (m - GRID_START_MINUTE) / GRID_MINUTES
}

/** Struck-through visits: kept on the grid for a day after the change, then gone. */
export const STRUCK: readonly SlotStatus[] = ['RESCHEDULED', 'CANCELLED']

export function visibleOnGrid(status: SlotStatus, outcomeAt: Date | null, now: Date): boolean {
  if (!STRUCK.includes(status)) return true
  return !outcomeAt || now.getTime() - outcomeAt.getTime() <= DAY
}

export type Lane = { lane: number; lanes: number; conflict: boolean }

type Laid = { id: string; repKey: string; startsAt: Date | string; endsAt: Date | string; status: SlotStatus }

/**
 * Side-by-side lanes for blocks that overlap in one column, and the ⚠ flag for
 * two live visits of the same rep inside the 90-minute gap (legacy data only:
 * a new hold can't break the rule).
 */
export function laneLayout(items: readonly Laid[]): Map<string, Lane> {
  const out = new Map<string, Lane>()
  const sorted = [...items].sort((x, y) => new Date(x.startsAt).getTime() - new Date(y.startsAt).getTime() || x.id.localeCompare(y.id))
  let cluster: { id: string; lane: number }[] = []
  let laneEnds: number[] = []
  let clusterEnd = -Infinity
  const flush = () => {
    for (const c of cluster) out.set(c.id, { lane: c.lane, lanes: laneEnds.length, conflict: false })
    cluster = []
    laneEnds = []
  }
  for (const item of sorted) {
    const start = new Date(item.startsAt).getTime()
    const end = new Date(item.endsAt).getTime()
    if (start >= clusterEnd) flush()
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start)
    if (lane === -1) lane = laneEnds.push(end) - 1
    else laneEnds[lane] = end
    cluster.push({ id: item.id, lane })
    clusterEnd = Math.max(clusterEnd, end)
  }
  flush()
  const live = sorted.filter((item) => !STRUCK.includes(item.status))
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]
      const b = live[j]
      if (a.repKey !== b.repKey) continue
      if (Math.abs(new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()) >= REP_GAP_MINUTES * MIN) continue
      out.get(a.id)!.conflict = true
      out.get(b.id)!.conflict = true
    }
  return out
}

// ── Scheduler ────────────────────────────────────────────────────────────────

/** Can anything still be booked on this day: inside the 5-day window, and its last start ≥ 2 h out. */
export function dayOpen(dayKey: string, now: Date): boolean {
  const ahead = daysBetween(dayKeyOf(now), dayKey)
  if (ahead < 0 || ahead > MAX_DAYS_AHEAD) return false
  const p = partsOf(dayKey)
  return zonedToUtc(p.year, p.month, p.day, LAST_START_MINUTE).getTime() - now.getTime() >= MIN_LEAD_MINUTES * MIN
}

/** The first day that still takes a visit (today when it can). */
export function firstOpenDay(now: Date): string {
  const today = dayKeyOf(now)
  for (let d = 0; d <= MAX_DAYS_AHEAD; d++) if (dayOpen(addDays(today, d), now)) return addDays(today, d)
  return today
}

export type SchedulerDay = MonthCell & { enabled: boolean; today: boolean }

export function schedulerMonth(monthKey: string, now: Date): SchedulerDay[][] {
  const today = dayKeyOf(now)
  return monthCells(monthKey).map((week) => week.map((c) => ({ ...c, enabled: dayOpen(c.key, now), today: c.key === today })))
}

export type Chip = { startsAt: string; label: string; problem: string | null }

function toBusy(busy: readonly { repKey: string; startsAt: string | Date }[]): BusySlot[] {
  return busy.map((b) => ({ repKey: b.repKey, startsAt: new Date(b.startsAt) }))
}

/**
 * 30-minute chips, 9:00 AM → 5:30 PM, for one rep on one day. A chip carries
 * the same reason `holdSlot` would refuse it with (busy, too soon, day off…).
 */
export function schedulerChips(input: {
  dayKey: string
  repKey: string
  now: Date
  busy: readonly { repKey: string; startsAt: string | Date }[]
  hours?: RepHours
}): Chip[] {
  const p = partsOf(input.dayKey)
  const busy = toBusy(input.busy)
  const chips: Chip[] = []
  for (let m = FIRST_START_MINUTE; m <= LAST_START_MINUTE; m += STEP_MINUTES) {
    const startsAt = zonedToUtc(p.year, p.month, p.day, m)
    chips.push({
      startsAt: startsAt.toISOString(),
      label: minuteLabel(m),
      problem: slotProblem({ repKey: input.repKey, startsAt, now: input.now, busy, hours: input.hours }),
    })
  }
  return chips
}

/** Open chips per rep that day. */
export function openingsByRep(input: {
  dayKey: string
  reps: readonly string[]
  now: Date
  busy: readonly { repKey: string; startsAt: string | Date }[]
  hours?: RepHours
}): Map<string, number> {
  return new Map(input.reps.map((repKey) => [repKey, schedulerChips({ ...input, repKey }).filter((c) => !c.problem).length]))
}

/** The default rep: the most openings that day; ties go to the earlier rep in the list. */
export function bestRep(input: Parameters<typeof openingsByRep>[0]): string | null {
  let best: string | null = null
  let most = -1
  for (const [repKey, count] of openingsByRep(input)) {
    if (count > most) {
      best = repKey
      most = count
    }
  }
  return best
}

/** The server's short refusal codes in plain words. */
export function reasonText(reason: string): string {
  switch (reason) {
    case 'out_of_state': return 'This lead is outside Nevada, so it can’t be booked.'
    case 'dnc': return 'This lead is on do-not-call, so it can’t be booked.'
    case 'opted_out': return 'This lead opted out, so it can’t be booked.'
    case 'not_found':
    case 'not found': return 'That lead or visit no longer exists. Reload the page.'
    case 'unknown rep': return 'Pick a rep from the list.'
    case 'not a hold': return 'Only a hold can be confirmed.'
    case 'rep is off that day': return 'The rep is off that day.'
    case 'less than 2 hours out': return 'Too soon: visits start at least 2 hours from now.'
    case 'more than 5 days ahead': return 'Too far out: visits can be booked up to 5 days ahead.'
    case 'rep already has a visit then': return 'The rep already has a visit within 90 minutes of that time.'
    case 'outside 9:00 AM to 5:30 PM PT': return 'Outside the rep’s hours (visits start 9:00 AM to 5:30 PM Pacific).'
    case 'not on a 30-minute step': return 'Pick a time on the half hour.'
    case 'visit was never confirmed': return 'Sat and No-show need a confirmed visit.'
    case 'visit already closed': return 'This visit already has a result.'
    case 'visit changed': return 'Someone changed this visit. Reload the page.'
    default: return reason
  }
}

// ── Block looks and lists ────────────────────────────────────────────────────

/** HOLD and CONFIRMED still take the rep's time; the rest are closed. */
export function isLive(status: SlotStatus): boolean {
  return status === 'HOLD' || status === 'CONFIRMED'
}

/** The status chip on a block: its words and the CSS look (`cal-st-<look>`). */
export function statusLook(status: SlotStatus): { label: string; look: string; struck: boolean } {
  switch (status) {
    case 'HOLD': return { label: 'Hold', look: 'hold', struck: false }
    case 'CONFIRMED': return { label: 'Confirmed', look: 'confirmed', struck: false }
    case 'SAT': return { label: '✓ Sat', look: 'sat', struck: false }
    case 'NO_SHOW': return { label: 'No-show', look: 'noshow', struck: false }
    case 'RESCHEDULED': return { label: 'Rescheduled', look: 'struck', struck: true }
    case 'CANCELLED': return { label: 'Cancelled', look: 'struck', struck: true }
  }
}

/** Visits by Pacific day, each day oldest first. */
export function groupByDay<T extends { startsAt: string }>(visits: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const visit of [...visits].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))) {
    const key = dayKeyOf(new Date(visit.startsAt))
    const list = out.get(key)
    if (list) list.push(visit)
    else out.set(key, [visit])
  }
  return out
}

/** A month cell shows up to `max` chips and "+N more". */
export function monthChips<T>(visits: readonly T[], max = 3): { shown: T[]; more: number } {
  return { shown: visits.slice(0, max), more: Math.max(0, visits.length - max) }
}

/** "Today 2:30 PM", "Tomorrow 9:00 AM", "Fri 9:00 AM": a rail time, Pacific. */
export function railWhen(at: Date | string, now: Date): string {
  const key = dayKeyOf(new Date(at))
  const ahead = daysBetween(dayKeyOf(now), key)
  const day = ahead === 0 ? 'Today' : ahead === 1 ? 'Tomorrow' : ahead === -1 ? 'Yesterday' : `${WEEKDAYS[weekdayOf(key)].slice(0, 3)} ${short(key).mon} ${short(key).day}`
  return `${day} ${timeLabel(at)}`
}
