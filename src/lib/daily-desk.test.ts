import { describe, expect, it } from 'vitest'
import {
  civilDate,
  countsAsDeskBooking,
  deskBookingToShow,
  deskChipCloserName,
  deskChipsToDraw,
  deskMonthRange,
  isoDate,
  missingDocsLabel,
  boardForMonth,
  todayAction,
  monthGrid,
  monthTitle,
  parseMonth,
  shiftIso,
  shiftMonth,
  timeLabel,
  weekCovered,
  weekDayIsos,
  weekTitle,
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

describe('boardForMonth', () => {
  const chip = (iso: string) => ({
    appointmentId: iso, startsAt: `${iso}T17:00:00.000Z`, status: 'SCHEDULED', clientId: 'c',
    firstName: 'Roy', lastName: 'Labrador', timeLabel: '10:00', ownerName: null, missingDocs: 0, email: '', phone: '',
  })
  const october = {
    timezone: 'America/Los_Angeles', month: '2026-10', title: 'October 2026', today: '2026-10-09',
    days: monthGrid(2026, 9).map((cell) => ({ ...cell, isToday: cell.iso === '2026-10-09', chips: cell.iso === '2026-09-27' || cell.iso === '2026-10-09' ? [chip(cell.iso)] : [] })),
    unscheduled: [], unscheduledTotal: 0, closers: [], unassignedCount: 0, canAssign: false, canBook: true,
  }

  it('changes the title immediately and keeps appointments already on screen', () => {
    const september = boardForMonth(october, shiftMonth(october.month, -1))
    expect(september.month).toBe('2026-09')
    expect(september.title).toBe('September 2026')
    expect(september.days.find((day) => day.iso === '2026-09-27')?.chips).toHaveLength(1)
    expect(september.days.some((day) => day.iso === '2026-10-09')).toBe(false)
    expect(boardForMonth(september, '2026-09')).toBe(september)
  })

  it('walks a second arrow from the month it just landed on', () => {
    const september = boardForMonth(october, '2026-09')
    expect(boardForMonth(september, shiftMonth(september.month, -1)).title).toBe('August 2026')
  })
})

describe('todayAction', () => {
  const october = monthGrid(2026, 9).map((cell) => cell.iso)

  it('opens the day when this month is already on screen', () => {
    expect(todayAction('month', '2026-10', '2026-10-10', '2026-10-10', october)).toBe('day')
  })

  it('comes back to this month when another month is on screen', () => {
    expect(todayAction('month', '2026-11', '2026-11-10', '2026-10-10', october)).toBe('move-month')
  })

  it('opens the day when this week is already on screen', () => {
    expect(todayAction('week', '2026-10', '2026-10-09', '2026-10-10', october)).toBe('day')
  })

  it('comes back to this week when the cursor is on another week', () => {
    expect(todayAction('week', '2026-10', '2026-10-20', '2026-10-10', october)).toBe('move-week')
  })
})

describe('week navigation', () => {
  it('moves a civil date across a month and a year', () => {
    expect(shiftIso('2026-10-09', -7)).toBe('2026-10-02')
    expect(shiftIso('2026-10-09', 7)).toBe('2026-10-16')
    expect(shiftIso('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('uses Sunday through Saturday and titles the current week', () => {
    expect(weekDayIsos('2026-10-09')).toEqual([
      '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10',
    ])
    expect(weekTitle('2026-10-09')).toBe('Oct 4 – Oct 10, 2026')
    expect(weekTitle('2026-01-01')).toBe('Dec 28, 2025 – Jan 3, 2026')
  })

  it('treats a week as loaded when the month grid already contains it', () => {
    const october = monthGrid(2026, 9).map((cell) => cell.iso)
    const september = monthGrid(2026, 8).map((cell) => cell.iso)
    expect(weekCovered('2026-10-09', october)).toBe(true)
    expect(weekCovered('2026-09-27', october)).toBe(true)
    expect(weekCovered('2026-09-20', october)).toBe(false)
    expect(weekCovered('2026-11-01', october)).toBe(false)
    expect(weekCovered('2026-09-20', september)).toBe(true)
    expect(weekCovered('2026-11-01', monthGrid(2026, 10).map((cell) => cell.iso))).toBe(true)
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

describe('deskChipCloserName', () => {
  it('uses the assigned closer even when the call itself has no owner', () => {
    expect(deskChipCloserName('Gatsby')).toBe('Gatsby')
    expect(deskChipCloserName(null)).toBeNull()
  })
})

describe('countsAsDeskBooking', () => {
  const range = deskMonthRange('2026-09', 'America/Los_Angeles')
  const now = new Date('2026-09-25T04:50:00.000Z')

  it('keeps a finished booking on this month off the unscheduled list', () => {
    expect(
      countsAsDeskBooking(
        {
          status: 'SCHEDULED',
          startsAt: new Date('2026-09-24T20:30:00.000Z'),
          endsAt: new Date('2026-09-24T21:30:00.000Z'),
        },
        now,
        range.rangeStart,
        range.rangeEnd,
      ),
    ).toBe(true)
  })

  it('does not treat a finished booking as on a later month', () => {
    const october = deskMonthRange('2026-10', 'America/Los_Angeles')
    expect(
      countsAsDeskBooking(
        {
          status: 'SCHEDULED',
          startsAt: new Date('2026-09-24T20:30:00.000Z'),
          endsAt: new Date('2026-09-24T21:30:00.000Z'),
        },
        now,
        october.rangeStart,
        october.rangeEnd,
      ),
    ).toBe(false)
  })

  it('shows the upcoming call when a finished booking is also on this month', () => {
    const finished = {
      status: 'SCHEDULED',
      startsAt: new Date('2026-09-24T20:30:00.000Z'),
      endsAt: new Date('2026-09-24T21:30:00.000Z'),
    }
    const upcoming = {
      status: 'CONFIRMED',
      startsAt: new Date('2026-10-02T17:00:00.000Z'),
      endsAt: new Date('2026-10-02T18:00:00.000Z'),
    }
    expect(deskBookingToShow([upcoming, finished], now, range.rangeStart, range.rangeEnd)).toBe(upcoming)
  })

  it('keeps the newer scheduled chip when two are already on this month', () => {
    const first = {
      clientId: 'william',
      status: 'SCHEDULED',
      startsAt: new Date('2026-09-24T20:30:00.000Z'),
    }
    const second = {
      clientId: 'william',
      status: 'SCHEDULED',
      startsAt: new Date('2026-09-27T17:00:00.000Z'),
    }
    expect(deskChipsToDraw([first, second])).toEqual([second])
  })

  it('releases a no-show even when the start is on this month', () => {
    expect(
      countsAsDeskBooking(
        {
          status: 'NO_SHOW',
          startsAt: new Date('2026-09-24T20:30:00.000Z'),
          endsAt: new Date('2026-09-24T21:30:00.000Z'),
        },
        now,
        range.rangeStart,
        range.rangeEnd,
      ),
    ).toBe(false)
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
