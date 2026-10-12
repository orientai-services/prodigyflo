import { describe, expect, it } from 'vitest'
import {
  afterCursor,
  baseFields,
  dayLabel,
  decodeCursor,
  durationLabel,
  encodeCursor,
  historyHref,
  maskPhones,
  maskedNumber,
  nameMatches,
  pageOf,
  parseHistoryParams,
  parseSearch,
  timeLabel,
} from './history-format'

const BASE = '/call-center?s=history'

describe('history URL state', () => {
  it('parses the prefixed params and falls back to defaults', () => {
    expect(parseHistoryParams({})).toEqual({ tab: 'calls', filter: 'all', q: '' })
    expect(parseHistoryParams({ ht: 'activity', hf: 'missed', hq: '  nate   f ' })).toEqual({ tab: 'activity', filter: 'missed', q: 'nate f' })
    expect(parseHistoryParams({ hf: 'bogus', hq: ['1234', 'x'] })).toEqual({ tab: 'calls', filter: 'all', q: '1234' })
  })

  it('builds links on the base and leaves defaults out', () => {
    expect(historyHref(BASE, {})).toBe(BASE)
    expect(historyHref(BASE, { filter: 'sms', q: 'ana' })).toBe('/call-center?s=history&hf=sms&hq=ana')
    expect(historyHref(`${BASE}&hf=sms&hq=x`, { tab: 'activity', filter: 'sms', q: 'x' })).toBe('/call-center?s=history&ht=activity')
    expect(baseFields(`${BASE}&hq=old`)).toEqual({ path: '/call-center', fields: [['s', 'history']] })
  })
})

describe('history cursor', () => {
  it('round-trips and rejects junk', () => {
    const c = encodeCursor({ at: '2026-10-12T17:00:00.000Z', key: 'vc:abc123' })
    expect(decodeCursor(c)).toEqual({ at: Date.parse('2026-10-12T17:00:00.000Z'), key: 'vc:abc123' })
    expect(decodeCursor('nope')).toBeNull()
    expect(decodeCursor('123_vc:a b')).toBeNull()
    expect(decodeCursor(42)).toBeNull()
  })

  it('pages a merged list without gaps or repeats, ties included', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 12, 17, m)).toISOString()
    const rows = [
      ...Array.from({ length: 7 }, (_, i) => ({ key: `vc:${i}`, at: at(i) })),
      { key: 'cm:x', at: at(3) },
      { key: 'ev:y', at: at(3) },
    ]
    const seen: string[] = []
    let cursor = null as ReturnType<typeof decodeCursor>
    for (let i = 0; i < 10; i++) {
      const page = pageOf(rows, cursor, 2)
      seen.push(...page.rows.map((r) => r.key))
      if (!page.nextCursor) break
      cursor = decodeCursor(page.nextCursor)
    }
    expect(seen).toHaveLength(rows.length)
    expect(new Set(seen).size).toBe(rows.length)
    expect(seen[0]).toBe('vc:6')
    expect(seen.slice(3, 6)).toEqual(['vc:3', 'ev:y', 'cm:x'])
    expect(afterCursor({ key: 'vc:3', at: at(3) }, { at: Date.parse(at(3)), key: 'vc:3' })).toBe(false)
  })
})

describe('history labels', () => {
  const now = new Date('2026-10-12T19:00:00Z') // Monday, Oct 12, noon Pacific

  it('names the day this week and the date before that, in Pacific time', () => {
    expect(dayLabel(new Date('2026-10-11T18:00:00Z'), now)).toBe('Sun 11')
    expect(dayLabel(new Date('2026-10-12T06:30:00Z'), now)).toBe('Sun 11') // 11:30 PM Sunday Pacific
    expect(dayLabel(new Date('2026-10-04T18:00:00Z'), now)).toBe('Oct 4')
    expect(dayLabel(new Date('2025-12-30T18:00:00Z'), now)).toBe('Dec 30, 2025')
    expect(timeLabel(new Date('2026-10-12T21:14:00Z'))).toBe('2:14 PM')
  })

  it('masks numbers and keeps only the last 4', () => {
    expect(maskedNumber('1234')).toBe('•••-•••-1234')
    expect(maskedNumber(null)).toBe('Unknown number')
    expect(maskPhones('Call me at (702) 555-0199 or +1 702.555.0123, zip 89117')).toBe('Call me at •••-•••-0199 or •••-•••-0123, zip 89117')
    expect(durationLabel(125)).toBe('2:05')
  })

  it('reads a search as a last 4 or as name words', () => {
    expect(parseSearch('1234')).toEqual({ last4: '1234', words: [] })
    expect(parseSearch('(702) 555-0199')).toEqual({ last4: '0199', words: [] })
    expect(parseSearch('Nate F%')).toEqual({ last4: null, words: ['nate', 'f'] })
    expect(nameMatches('Nate Fuller', ['nate', 'ful'])).toBe(true)
    expect(nameMatches('Nate Fuller', ['mara'])).toBe(false)
  })
})
