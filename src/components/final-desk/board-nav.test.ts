import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('master calendar board navigation', () => {
  const src = readFileSync(path.join(__dirname, 'final-desk.tsx'), 'utf8')

  it('moves by month and by week, and keeps Today on the view you are in', () => {
    expect(src).toContain("useState<'month' | 'week' | 'day'>")
    expect(src).toContain('shiftMonth(monthRef.current || board.month, -1)')
    expect(src).toContain('shiftMonth(monthRef.current || board.month, 1)')
    expect(src).toContain('shiftIso(cursorRef.current || focus, -7)')
    expect(src).toContain('shiftIso(cursorRef.current || focus, 7)')
    expect(src).toContain('boardForMonth')
    expect(src).toContain('next.board.month !== monthRef.current')
    expect(src).toContain('jumpToday(kind)')
    expect(src).toContain('todayAction')
    expect(src).toContain("action === 'day'")
    expect(src).toContain('board?.month === nextKey')
    expect(src).toContain('weekCovered')
    expect(src).toContain('weekTitle(focus, dateLocale)')
  })

  it('still opens a day into the hour schedule', () => {
    expect(src).toContain('void selectDay(d.iso)')
    expect(src).toContain('void selectDay(iso)')
    expect(src).toContain("periodNav('day')")
  })
})
