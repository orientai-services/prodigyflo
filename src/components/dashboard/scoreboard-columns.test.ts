import { describe, expect, it } from 'vitest'
import {
  CORE_SCOREBOARD_COLUMNS,
  SCOREBOARD_COLUMN_ORDER,
  hiddenColumnCount,
  scoreboardColumnMode,
  scoreboardColumns,
} from './scoreboard-columns'

describe('scoreboardColumnMode', () => {
  it("returns 'all' only for the literal param", () => {
    expect(scoreboardColumnMode('all')).toBe('all')
    expect(scoreboardColumnMode('ALL')).toBe('core')
    expect(scoreboardColumnMode('everything')).toBe('core')
    expect(scoreboardColumnMode(undefined)).toBe('core')
    expect(scoreboardColumnMode('')).toBe('core')
  })
})

describe('scoreboardColumns', () => {
  it('trims to exactly 8 core columns', () => {
    expect(scoreboardColumns('core')).toHaveLength(8)
    expect(scoreboardColumns('core')).toEqual([...CORE_SCOREBOARD_COLUMNS])
  })

  it('shows every column in all mode', () => {
    expect(scoreboardColumns('all')).toEqual([...SCOREBOARD_COLUMN_ORDER])
  })

  it('keeps core columns in display order', () => {
    const all = scoreboardColumns('all')
    const core = scoreboardColumns('core')
    const positions = core.map((key) => all.indexOf(key))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(positions.every((p) => p >= 0)).toBe(true)
  })

  it('always keeps identity + outcome columns visible', () => {
    for (const key of ['rank', 'closer', 'points', 'leaks'] as const) {
      expect(scoreboardColumns('core')).toContain(key)
    }
  })

  it('has no duplicate keys in either mode', () => {
    for (const mode of ['core', 'all'] as const) {
      const cols = scoreboardColumns(mode)
      expect(new Set(cols).size).toBe(cols.length)
    }
  })
})

describe('hiddenColumnCount', () => {
  it('reports how many columns the More toggle reveals', () => {
    expect(hiddenColumnCount('core')).toBe(SCOREBOARD_COLUMN_ORDER.length - 8)
    expect(hiddenColumnCount('all')).toBe(0)
  })
})
