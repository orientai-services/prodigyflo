import { describe, expect, it } from 'vitest'
import {
  civilDate,
  isoDate,
  missingDocsLabel,
  monthGrid,
  monthTitle,
  parseMonth,
  shiftMonth,
  timeLabel,
  zonedDate,
} from '@/lib/daily-desk'

describe('parseMonth', () => {
  it('accepts YYYY-MM', () => {
    expect(parseMonth('2026-09')).toEqual({ year: 2026, monthIndex: 8, key: '2026-09' })
  })

  it('rejects junk and uses today', () => {
    const now = new Date(2026, 0, 15)
    expect(parseMonth('nope', now).key).toBe('2026-01')
    expect(parseMonth('2026-13', now).key).toBe('2026-01')
  })
})

describe('monthGrid', () => {
  it('September 2026 is Sunday-first and five weeks, starting 30 Aug', () => {
    const cells = monthGrid(2026, 8)
    expect(cells).toHaveLength(35)
    expect(cells[0]).toMatchObject({ iso: '2026-08-30', day: 30, inMonth: false })
    expect(cells[2]).toMatchObject({ iso: '2026-09-01', day: 1, inMonth: true })
    expect(cells.find((c) => c.iso === '2026-09-16')).toMatchObject({ day: 16, inMonth: true })
    expect(cells.at(-1)).toMatchObject({ iso: '2026-10-03', inMonth: false })
  })

  it('titles the month the way the prototype head does', () => {
    expect(monthTitle(2026, 8)).toBe('September 2026')
  })
})

describe('shiftMonth', () => {
  it('walks across year boundaries', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  })
})

describe('zonedDate', () => {
  it('treats 10:00 America/Los_Angeles as 17:00 UTC in September PDT', () => {
    const at = zonedDate('2026-09-16', '10:00', 'America/Los_Angeles')
    expect(at.toISOString()).toBe('2026-09-16T17:00:00.000Z')
    expect(civilDate(at, 'America/Los_Angeles')).toBe('2026-09-16')
    expect(timeLabel(at, 'America/Los_Angeles')).toBe('10:00')
  })
})

describe('missingDocsLabel', () => {
  it('is a chip subtitle, not a money figure', () => {
    expect(missingDocsLabel(0)).toBe('docs in')
    expect(missingDocsLabel(3)).toBe('3 missing')
  })
})

describe('isoDate', () => {
  it('pads civil dates', () => {
    expect(isoDate(new Date(2026, 8, 1))).toBe('2026-09-01')
  })
})
