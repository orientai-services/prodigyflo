import { describe, expect, it } from 'vitest'
import {
  HYGIENE_CHECKS,
  checkPenalty,
  hygieneScore,
  scoreGrade,
  type HygieneCheckKey,
} from '@/lib/hygiene'

describe('HYGIENE_CHECKS catalogue', () => {
  it('weights sum to 1 so a fully-failing book bottoms out at 0', () => {
    const total = HYGIENE_CHECKS.reduce((s, c) => s + c.weight, 0)
    expect(total).toBeCloseTo(1, 6)
  })

  it('has a unique key per check', () => {
    const keys = HYGIENE_CHECKS.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('checkPenalty', () => {
  it('is zero when count or weight is zero', () => {
    expect(checkPenalty(0.2, 0, 100)).toBe(0)
    expect(checkPenalty(0, 50, 100)).toBe(0)
  })

  it('scales the weight by the fraction of the book affected', () => {
    expect(checkPenalty(0.2, 25, 100)).toBeCloseTo(0.05, 6)
  })

  it('caps at the full weight — one check can never over-count the book', () => {
    expect(checkPenalty(0.2, 500, 100)).toBeCloseTo(0.2, 6)
  })

  it('treats a zero book as one to avoid divide-by-zero', () => {
    expect(checkPenalty(0.2, 3, 0)).toBeCloseTo(0.2, 6)
  })
})

describe('hygieneScore', () => {
  it('is a perfect 100 when every count is zero', () => {
    const counts = HYGIENE_CHECKS.map((c) => ({ weight: c.weight, count: 0 }))
    expect(hygieneScore(counts, 200)).toBe(100)
  })

  it('subtracts a single check proportionally', () => {
    // One check, weight 0.15, touching 10% of a 100-client book → 1.5 points.
    expect(hygieneScore([{ weight: 0.15, count: 10 }], 100)).toBe(99)
  })

  it('bottoms out at 0 when every check maxes out its weight', () => {
    const counts = HYGIENE_CHECKS.map((c) => ({ weight: c.weight, count: 1000 }))
    expect(hygieneScore(counts, 50)).toBe(0)
  })

  it('never returns below 0 even with pathological counts', () => {
    expect(hygieneScore([{ weight: 1, count: 10_000 }], 1)).toBe(0)
  })

  it('stays at 100 for an empty book with no issues', () => {
    expect(hygieneScore([], 0)).toBe(100)
  })

  it('rounds to the nearest whole point', () => {
    // 0.2 × (3/100) = 0.006 → 0.6 points → 100 - 0.6 = 99.4 → 99
    expect(hygieneScore([{ weight: 0.2, count: 3 }], 100)).toBe(99)
  })
})

describe('scoreGrade', () => {
  it('bands the score into clean / good / fair / poor', () => {
    expect(scoreGrade(100)).toBe('clean')
    expect(scoreGrade(95)).toBe('clean')
    expect(scoreGrade(94)).toBe('good')
    expect(scoreGrade(80)).toBe('good')
    expect(scoreGrade(79)).toBe('fair')
    expect(scoreGrade(60)).toBe('fair')
    expect(scoreGrade(59)).toBe('poor')
    expect(scoreGrade(0)).toBe('poor')
  })

  it('covers every declared grade', () => {
    const grades = new Set([scoreGrade(100), scoreGrade(85), scoreGrade(70), scoreGrade(10)])
    const keys: HygieneCheckKey[] = HYGIENE_CHECKS.map((c) => c.key)
    expect(keys.length).toBe(7)
    expect(grades).toEqual(new Set(['clean', 'good', 'fair', 'poor']))
  })
})
