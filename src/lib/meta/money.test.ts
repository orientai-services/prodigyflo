import { describe, expect, it } from 'vitest'
import { SPEND_CAP_MIN_USD, centsToUsd, parseUsd, spendCapToCents, usdToCents } from './money'

describe('usdToCents', () => {
  it('converts whole dollars', () => {
    expect(usdToCents(50)).toBe(5000)
    expect(usdToCents(0)).toBe(0)
  })

  it('rounds fractional cents instead of truncating', () => {
    expect(usdToCents(19.99)).toBe(1999)
    // 0.1 + 0.2 style float dust must not shave a cent off
    expect(usdToCents(0.29)).toBe(29)
    expect(usdToCents(0.07)).toBe(7)
    expect(usdToCents(1250.5)).toBe(125050)
  })

  it('rejects negatives and non-finite values', () => {
    expect(() => usdToCents(-1)).toThrow(RangeError)
    expect(() => usdToCents(Number.NaN)).toThrow(RangeError)
    expect(() => usdToCents(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('centsToUsd', () => {
  it('converts numeric and string cents (Meta returns strings)', () => {
    expect(centsToUsd(1999)).toBe(19.99)
    expect(centsToUsd('5000')).toBe(50)
  })

  it('degrades to 0 on garbage rather than NaN-ing the UI', () => {
    expect(centsToUsd('not-a-number')).toBe(0)
  })

  it('round-trips with usdToCents', () => {
    for (const usd of [1, 19.99, 100, 12345.67]) {
      expect(centsToUsd(usdToCents(usd))).toBe(usd)
    }
  })
})

describe('spendCapToCents', () => {
  it('enforces the $100 lifetime minimum', () => {
    expect(() => spendCapToCents(99.99)).toThrow(/at least \$100/)
    expect(spendCapToCents(SPEND_CAP_MIN_USD)).toBe(10_000)
    expect(spendCapToCents(2500)).toBe(250_000)
  })
})

describe('parseUsd', () => {
  it('accepts plain, $-prefixed, and comma-grouped amounts', () => {
    expect(parseUsd('50')).toBe(50)
    expect(parseUsd('$25')).toBe(25)
    expect(parseUsd('$1,250.50')).toBe(1250.5)
    expect(parseUsd(' 19.99 ')).toBe(19.99)
  })

  it('rejects zero, negatives, and non-amounts', () => {
    expect(parseUsd('0')).toBeNull()
    expect(parseUsd('-5')).toBeNull()
    expect(parseUsd('abc')).toBeNull()
    expect(parseUsd('12.345')).toBeNull() // sub-cent precision is a typo, not a budget
    expect(parseUsd('')).toBeNull()
  })
})
