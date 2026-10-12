import { describe, expect, it } from 'vitest'
import { REP_COLORS, repColor } from './config'
import {
  bestRep,
  blockPlacement,
  calendarHref,
  dayKeyOf,
  dayOpen,
  firstOpenDay,
  laneLayout,
  monthCells,
  nowOffset,
  parseCalendarParams,
  rangeFor,
  rangeLabel,
  reasonText,
  schedulerChips,
  schedulerMonth,
  shiftDate,
  shortName,
  timeRange,
  visibleOnGrid,
  weekDays,
} from './planner'
import { openSlots } from './slots'
import { zonedToUtc } from './time'

// Wednesday 2026-10-14 08:00 PT (UTC-7)
const NOW = new Date('2026-10-14T15:00:00Z')
const at = (y: number, m: number, d: number, hh: number, mm = 0) => zonedToUtc(y, m, d, hh * 60 + mm)
const REPS = [
  { key: 'gatsby', label: 'Gatsby' },
  { key: 'hector', label: 'Hector' },
  { key: 'dakota', label: 'Dakota' },
]

describe('rep colors', () => {
  it('follow the rep list order and never change for a rep', () => {
    expect(REPS.map((r) => repColor(r.key, REPS))).toEqual(['teal', 'amber', 'violet'])
    expect(repColor('hector', REPS)).toBe(repColor('hector', [...REPS]))
  })
  it('wrap after six and give unknown keys a stable color', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ key: `r${i}`, label: `R${i}` }))
    expect(repColor('r6', many)).toBe('teal')
    const legacy = repColor('old-rep', REPS)
    expect(REP_COLORS).toContain(legacy)
    expect(repColor('old-rep', REPS)).toBe(legacy)
  })
})

describe('days, ranges and labels', () => {
  it('reads the Pacific day, not the UTC one', () => {
    // 2026-10-15 06:00 UTC is still the 14th in Las Vegas.
    expect(dayKeyOf(new Date('2026-10-15T06:00:00Z'))).toBe('2026-10-14')
  })
  it('weeks run Monday to Sunday', () => {
    expect(weekDays('2026-10-14')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'])
    expect(weekDays('2026-10-18')[0]).toBe('2026-10-12')
    expect(weekDays('2026-10-19')[0]).toBe('2026-10-19')
  })
  it('month cells are 5 or 6 Monday-first rows that cover the month', () => {
    const oct = monthCells('2026-10-20')
    expect(oct.length).toBe(5)
    expect(oct[0][0]).toEqual({ key: '2026-09-28', day: 28, inMonth: false })
    expect(oct.flat().filter((c) => c.inMonth).length).toBe(31)
    const aug = monthCells('2026-08-01') // Aug 1 2026 is a Saturday: 6 rows
    expect(aug.length).toBe(6)
    for (const week of [...oct, ...aug]) expect(week.length).toBe(7)
  })
  it('loads local midnight to local midnight, DST aware', () => {
    const week = rangeFor('week', '2026-10-14')
    expect(week.from.toISOString()).toBe('2026-10-12T07:00:00.000Z')
    expect(week.to.toISOString()).toBe('2026-10-19T07:00:00.000Z')
    const day = rangeFor('day', '2026-11-01') // DST ends that night
    expect(day.from.toISOString()).toBe('2026-11-01T07:00:00.000Z')
    expect(day.to.toISOString()).toBe('2026-11-02T08:00:00.000Z')
  })
  it('steps and labels each view', () => {
    expect(shiftDate('day', '2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftDate('week', '2026-10-14', -1)).toBe('2026-10-07')
    expect(shiftDate('month', '2026-01-31', -1)).toBe('2025-12-01')
    expect(rangeLabel('week', '2026-10-14')).toBe('Oct 12 – 18, 2026')
    expect(rangeLabel('week', '2026-09-30')).toBe('Sep 28 – Oct 4, 2026')
    expect(rangeLabel('week', '2026-12-30')).toBe('Dec 28, 2026 – Jan 3, 2027')
    expect(rangeLabel('day', '2026-10-12')).toBe('Monday, Oct 12, 2026')
    expect(rangeLabel('month', '2026-10-12')).toBe('October 2026')
  })
  it('prints times the same everywhere', () => {
    expect(timeRange(at(2026, 10, 15, 9), at(2026, 10, 15, 10, 30))).toBe('9:00 – 10:30 AM')
    expect(timeRange(at(2026, 10, 15, 11), at(2026, 10, 15, 12, 30))).toBe('11:00 AM – 12:30 PM')
    expect(shortName('Nate Fuller')).toBe('Nate F.')
    expect(shortName('Cher')).toBe('Cher')
  })
})

describe('URL state', () => {
  it('defaults to this week, all reps, and rejects junk', () => {
    expect(parseCalendarParams({}, NOW, ['gatsby'])).toEqual({ view: 'week', date: '2026-10-14', rep: null, viewSet: false })
    expect(parseCalendarParams({ view: 'month', date: '2026-02-30', rep: 'nobody' }, NOW, ['gatsby'])).toEqual({
      view: 'month',
      date: '2026-10-14',
      rep: null,
      viewSet: true,
    })
    expect(parseCalendarParams({ view: 'day', date: '2026-10-20', rep: 'Gatsby' }, NOW, ['gatsby']).rep).toBe('gatsby')
  })
  it('every link keeps the desk base', () => {
    const state = { view: 'week' as const, date: '2026-10-12', rep: 'gatsby' }
    expect(calendarHref(state)).toBe('/call-center?tab=calendar&view=week&date=2026-10-12&rep=gatsby')
    expect(calendarHref(state, { rep: null, view: 'day' })).toBe('/call-center?tab=calendar&view=day&date=2026-10-12')
  })
})

describe('grid placement', () => {
  it('puts a 90-minute visit 1.5 rows tall at its start', () => {
    const p = blockPlacement(at(2026, 10, 15, 9), at(2026, 10, 15, 10, 30))
    expect(p.dayKey).toBe('2026-10-15')
    expect(p.top).toBeCloseTo(60 / 720)
    expect(p.height).toBeCloseTo(90 / 720)
  })
  it('clamps visits that run off the grid', () => {
    const late = blockPlacement(at(2026, 10, 15, 19, 30), at(2026, 10, 15, 21))
    expect(late.top + late.height).toBeCloseTo(1)
    const early = blockPlacement(at(2026, 10, 15, 7), at(2026, 10, 15, 8, 30))
    expect(early.top).toBe(0)
    expect(early.height).toBeCloseTo(30 / 720)
  })
  it('draws the now line only on today, inside the grid', () => {
    expect(nowOffset(NOW, '2026-10-14')).toBe(0)
    expect(nowOffset(new Date('2026-10-14T20:00:00Z'), '2026-10-14')).toBeCloseTo(300 / 720)
    expect(nowOffset(NOW, '2026-10-15')).toBeNull()
    expect(nowOffset(new Date('2026-10-14T13:00:00Z'), '2026-10-14')).toBeNull()
  })
  it('keeps struck visits one day after the change', () => {
    expect(visibleOnGrid('HOLD', null, NOW)).toBe(true)
    expect(visibleOnGrid('CANCELLED', new Date(NOW.getTime() - 3_600_000), NOW)).toBe(true)
    expect(visibleOnGrid('RESCHEDULED', new Date(NOW.getTime() - 25 * 3_600_000), NOW)).toBe(false)
    expect(visibleOnGrid('SAT', new Date(NOW.getTime() - 99 * 3_600_000), NOW)).toBe(true)
  })
})

describe('overlap pairing', () => {
  const slot = (id: string, repKey: string, h: number, m = 0, status = 'HOLD' as const) => ({
    id,
    repKey,
    status,
    startsAt: at(2026, 10, 15, h, m),
    endsAt: at(2026, 10, 15, h + 1, m + 30),
  })
  it('lays overlapping blocks side by side and flags a rep against itself', () => {
    const lanes = laneLayout([slot('a', 'gatsby', 9), slot('b', 'gatsby', 10), slot('c', 'hector', 9, 30), slot('d', 'gatsby', 14)])
    expect(lanes.get('a')).toEqual({ lane: 0, lanes: 3, conflict: true })
    expect(lanes.get('c')).toEqual({ lane: 1, lanes: 3, conflict: false })
    expect(lanes.get('b')).toEqual({ lane: 2, lanes: 3, conflict: true })
    expect(lanes.get('d')).toEqual({ lane: 0, lanes: 1, conflict: false })
  })
  it('reuses a free lane and never flags different reps or struck visits', () => {
    const lanes = laneLayout([
      slot('a', 'gatsby', 9),
      slot('b', 'hector', 10),
      slot('c', 'dakota', 10, 30),
      { ...slot('x', 'hector', 10), status: 'CANCELLED' },
    ])
    expect(lanes.get('c')?.lane).toBe(0) // a ended at 10:30
    expect([...lanes.values()].some((l) => l.conflict)).toBe(false)
  })
})

describe('scheduler', () => {
  const keys = REPS.map((r) => r.key)
  it('offers 9:00 AM to 5:30 PM in 30-minute chips', () => {
    const chips = schedulerChips({ dayKey: '2026-10-15', repKey: 'gatsby', now: NOW, busy: [] })
    expect(chips.length).toBe(18)
    expect(chips[0].label).toBe('9:00 AM')
    expect(chips.at(-1)?.label).toBe('5:30 PM')
    expect(chips.every((c) => c.problem === null)).toBe(true)
  })
  it('greys chips with the reason the server would give', () => {
    const busy = [{ repKey: 'gatsby', startsAt: at(2026, 10, 15, 12).toISOString() }]
    const chips = schedulerChips({ dayKey: '2026-10-15', repKey: 'gatsby', now: NOW, busy })
    const byLabel = new Map(chips.map((c) => [c.label, c.problem]))
    expect(byLabel.get('11:00 AM')).toBe('rep already has a visit then')
    expect(byLabel.get('1:00 PM')).toBe('rep already has a visit then')
    expect(byLabel.get('10:30 AM')).toBeNull()
    expect(byLabel.get('1:30 PM')).toBeNull()
    const today = schedulerChips({ dayKey: '2026-10-14', repKey: 'gatsby', now: NOW, busy: [] })
    expect(today.find((c) => c.label === '9:30 AM')?.problem).toBe('less than 2 hours out')
    const off = schedulerChips({ dayKey: '2026-10-15', repKey: 'gatsby', now: NOW, busy: [], hours: { gatsby: { 4: { startMinute: 540, endMinute: 1050, active: false } } } })
    expect(off.every((c) => c.problem === 'rep is off that day')).toBe(true)
    expect(reasonText('less than 2 hours out')).toMatch(/2 hours/)
  })
  it('matches openSlots exactly', () => {
    const busy = [{ repKey: 'hector', startsAt: at(2026, 10, 16, 10) }]
    const open = openSlots({ reps: keys, now: NOW, busy })
    for (const day of ['2026-10-14', '2026-10-16', '2026-10-19'])
      for (const repKey of keys) {
        const fromChips = schedulerChips({ dayKey: day, repKey, now: NOW, busy }).filter((c) => !c.problem).map((c) => c.startsAt)
        const fromOpen = open.filter((s) => s.repKey === repKey && dayKeyOf(s.startsAt) === day).map((s) => s.startsAt.toISOString())
        expect(fromChips).toEqual(fromOpen)
      }
  })
  it('defaults to the rep with the most openings', () => {
    const busy = [
      { repKey: 'gatsby', startsAt: at(2026, 10, 15, 12).toISOString() },
      { repKey: 'hector', startsAt: at(2026, 10, 15, 10).toISOString() },
      { repKey: 'hector', startsAt: at(2026, 10, 15, 14).toISOString() },
    ]
    expect(bestRep({ dayKey: '2026-10-15', reps: keys, now: NOW, busy })).toBe('dakota')
    expect(bestRep({ dayKey: '2026-10-15', reps: ['gatsby', 'hector'], now: NOW, busy })).toBe('gatsby')
  })
  it('enables only days inside the window', () => {
    expect(dayOpen('2026-10-14', NOW)).toBe(true)
    expect(dayOpen('2026-10-19', NOW)).toBe(true)
    expect(dayOpen('2026-10-20', NOW)).toBe(false)
    expect(dayOpen('2026-10-13', NOW)).toBe(false)
    // 4:00 PM PT: the last 5:30 start is under 2 hours away.
    const late = new Date('2026-10-14T23:00:00Z')
    expect(dayOpen('2026-10-14', late)).toBe(false)
    expect(firstOpenDay(late)).toBe('2026-10-15')
    const grid = schedulerMonth('2026-10-14', NOW).flat()
    expect(grid.filter((d) => d.enabled).map((d) => d.key)).toEqual(['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'])
    expect(grid.find((d) => d.today)?.key).toBe('2026-10-14')
  })
})
