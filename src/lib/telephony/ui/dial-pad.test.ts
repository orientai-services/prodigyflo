import { describe, expect, it } from 'vitest'
import {
  PAD_MAX,
  cleanTyped,
  dialableE164,
  formatAsTyped,
  formatDialed,
  isDialable,
  isUsE164,
  maskDialed,
  normalizeTyped,
  pushRecent,
  readRecent,
} from './dial-pad'

/** The dial pad's number rules (docs/DIAL_PAD.md §1, §3). */

describe('cleanTyped: what the pad keeps', () => {
  it('keeps digits, * and #; pastes in any common shape', () => {
    expect(cleanTyped('+1 725-555-1234')).toBe('17255551234')
    expect(cleanTyped('1 (725) 555-1234')).toBe('17255551234')
    expect(cleanTyped('(725) 555.1234 ')).toBe('7255551234')
    expect(cleanTyped('*72#')).toBe('*72#')
    expect(cleanTyped('call me')).toBe('')
  })

  it('caps the length', () => {
    expect(cleanTyped('1'.repeat(40))).toHaveLength(PAD_MAX)
  })
})

describe('normalizeTyped', () => {
  it('digits only, without the leading country 1', () => {
    expect(normalizeTyped('17255551234')).toBe('7255551234')
    expect(normalizeTyped('7255551234')).toBe('7255551234')
    expect(normalizeTyped('*72#5')).toBe('725')
  })
})

describe('formatAsTyped', () => {
  it('formats a US number as it grows', () => {
    expect(formatAsTyped('')).toBe('')
    expect(formatAsTyped('7')).toBe('7')
    expect(formatAsTyped('725')).toBe('725')
    expect(formatAsTyped('7255')).toBe('(725) 5')
    expect(formatAsTyped('725555')).toBe('(725) 555')
    expect(formatAsTyped('7255551')).toBe('(725) 555-1')
    expect(formatAsTyped('7255551234')).toBe('(725) 555-1234')
  })

  it('shows the country 1 in front', () => {
    expect(formatAsTyped('1')).toBe('1')
    expect(formatAsTyped('1725')).toBe('1 725')
    expect(formatAsTyped('17255551234')).toBe('1 (725) 555-1234')
  })

  it('leaves codes and over-long input as typed', () => {
    expect(formatAsTyped('*72')).toBe('*72')
    expect(formatAsTyped('725#')).toBe('725#')
    expect(formatAsTyped('725555123456')).toBe('725555123456')
  })

  it('round-trips through cleanTyped, so editing the field keeps the digits', () => {
    for (const typed of ['7', '7255', '7255551', '7255551234', '17255551234']) {
      expect(cleanTyped(formatAsTyped(typed))).toBe(typed)
    }
  })
})

describe('isDialable / dialableE164', () => {
  it('10 digits, or 11 starting with 1', () => {
    expect(dialableE164('7255551234')).toBe('+17255551234')
    expect(dialableE164('17255551234')).toBe('+17255551234')
    expect(isDialable('725555123')).toBe(false)
    expect(isDialable('27255551234')).toBe(false)
    expect(isDialable('725555123456')).toBe(false)
  })

  it('never with * or #', () => {
    expect(isDialable('7255551234#')).toBe(false)
    expect(isDialable('*7255551234')).toBe(false)
  })

  it('not an area code or exchange starting 0 or 1', () => {
    expect(isDialable('1255551234')).toBe(false)
    expect(isDialable('0255551234')).toBe(false)
    expect(isDialable('7251551234')).toBe(false)
  })

  it('isUsE164 is the same rule the server uses', () => {
    expect(isUsE164('+17255551234')).toBe(true)
    expect(isUsE164('+447911123456')).toBe(false)
    expect(isUsE164('7255551234')).toBe(false)
  })
})

describe('display helpers', () => {
  it('formats and masks a dialed number', () => {
    expect(formatDialed('+17255551234')).toBe('(725) 555-1234')
    expect(maskDialed('+17255551234')).toBe('(725) •••-1234')
    expect(maskDialed('nonsense')).toBe('•••')
  })
})

describe('recent numbers', () => {
  it('newest first, no repeats, five at most', () => {
    let list: string[] = []
    for (const n of ['+17255550001', '+17255550002', '+17255550003', '+17255550004', '+17255550005', '+17255550006']) list = pushRecent(list, n)
    expect(list).toEqual(['+17255550006', '+17255550005', '+17255550004', '+17255550003', '+17255550002'])
    expect(pushRecent(list, '+17255550004')[0]).toBe('+17255550004')
    expect(pushRecent(list, '+17255550004')).toHaveLength(5)
  })

  it('reads storage defensively', () => {
    expect(readRecent(null)).toEqual([])
    expect(readRecent('not json')).toEqual([])
    expect(readRecent('{"a":1}')).toEqual([])
    expect(readRecent(JSON.stringify(['+17255550001', 42, 'x', '+447911123456']))).toEqual(['+17255550001'])
  })
})
