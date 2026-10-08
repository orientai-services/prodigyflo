import { describe, expect, it } from 'vitest'
import { clampCycleDays, closedCycleSpend, cycleSpend, cycleState, dayInZone, excludedFromHours, finalAfter, zonedMidnight } from './cycle'

const TZ = 'America/Los_Angeles'

describe('spend cycle', () => {
  it('day 1 is the start day in the account timezone', () => {
    // 2026-10-01 23:30 in Los Angeles is already Oct 2 in UTC.
    const start = new Date('2026-10-02T06:30:00Z')
    expect(dayInZone(start, TZ)).toBe('2026-10-01')
    const s = cycleState(start, 15, new Date('2026-10-02T07:30:00Z'), TZ)
    expect(s.day).toBe(2)
    expect(s.startDay).toBe('2026-10-01')
  })
  it('ends at local midnight across a DST change', () => {
    // US DST ends 2026-11-01. A cycle from Oct 25 for 15 days ends at Nov 9 00:00 PST (08:00 UTC).
    const s = cycleState(new Date('2026-10-25T17:00:00Z'), 15, new Date('2026-11-03T17:00:00Z'), TZ)
    expect(s.endsAt.toISOString()).toBe('2026-11-09T08:00:00.000Z')
    expect(s.day).toBe(10)
    // Before the change the offset is -7.
    expect(zonedMidnight('2026-10-25', TZ).toISOString()).toBe('2026-10-25T07:00:00.000Z')
  })
  it('overdue when the day passes the length', () => {
    const start = new Date('2026-10-01T17:00:00Z')
    expect(cycleState(start, 15, new Date('2026-10-15T17:00:00Z'), TZ).overdue).toBe(false)
    expect(cycleState(start, 15, new Date('2026-10-16T17:00:00Z'), TZ).overdue).toBe(true)
  })
  it('spend sums the account days from the start day, minus the excluded part, floored at 0', () => {
    const rows = [
      { date: '2026-09-30', spend: 99 },
      { date: '2026-10-01', spend: 40 },
      { date: '2026-10-02', spend: 50 },
      { date: '2026-10-03', spend: 60 },
    ]
    expect(cycleSpend(rows, '2026-10-01', '2026-10-02', 10)).toBe(80)
    expect(cycleSpend(rows, '2026-10-01', '2026-10-03', 0)).toBe(150)
    expect(cycleSpend(rows, '2026-10-03', '2026-10-03', 100)).toBe(0)
  })
  it('excluded spend = start-day hours before the cycle began', () => {
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, spend: 1 }))
    // 15:20 local → hours 0..14 are excluded.
    expect(excludedFromHours(hours, new Date('2026-10-01T22:20:00Z'), TZ)).toBe(15)
  })
  it('restatement window and length bounds', () => {
    const end = new Date('2026-10-10T12:00:00Z')
    expect(finalAfter(end).toISOString()).toBe('2026-10-13T12:00:00.000Z')
    expect(clampCycleDays(15)).toBe(15)
    expect(clampCycleDays(0)).toBeNull()
    expect(clampCycleDays(91)).toBeNull()
    expect(clampCycleDays(2.5)).toBeNull()
  })
})

describe('closed cycle spend (shared end day)', () => {
  const daily = [
    { date: '2026-10-01', spend: 100 },
    { date: '2026-10-02', spend: 100 },
    { date: '2026-10-03', spend: 240 }, // switch day: $100 before 14:00, $140 after
    { date: '2026-10-04', spend: 50 },
  ]
  it('the end day counts only the spend before the switch; the next cycle owns the rest', () => {
    const closed = closedCycleSpend(daily, '2026-10-01', '2026-10-03', 0, { startDay: '2026-10-03', startDayExcludedSpend: 100 })
    const next = cycleSpend(daily, '2026-10-03', '2026-10-04', 100)
    expect(closed).toBe(300)
    expect(next).toBe(190)
    // Nothing counted twice: the two cycles add up to the whole period.
    expect(closed + next).toBe(490)
  })
  it('a switch exactly at midnight shares no day', () => {
    expect(closedCycleSpend(daily, '2026-10-01', '2026-10-02', 0, { startDay: '2026-10-03', startDayExcludedSpend: 0 })).toBe(200)
  })
  it('an approximate next cycle (no hourly split) takes the whole end day', () => {
    expect(closedCycleSpend(daily, '2026-10-01', '2026-10-03', 0, { startDay: '2026-10-03', startDayExcludedSpend: 0 })).toBe(200)
  })
  it('a cycle that starts and ends on the same day keeps only its own hours', () => {
    expect(closedCycleSpend(daily, '2026-10-03', '2026-10-03', 40, { startDay: '2026-10-03', startDayExcludedSpend: 100 })).toBe(60)
  })
  it('with no next cycle it is the plain cycle sum', () => {
    expect(closedCycleSpend(daily, '2026-10-01', '2026-10-03', 0, null)).toBe(440)
  })
})
