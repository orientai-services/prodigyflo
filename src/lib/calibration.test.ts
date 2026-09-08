import { describe, expect, it } from 'vitest'
import {
  bucketize,
  brierScore,
  calibrationSummary,
  thresholdAdvice,
  verdictNarrative,
  type CalRow,
} from '@/lib/calibration'

/** Build n rows in a bin: `won` of them winners, the rest losers, all at `p`. */
const rows = (p: number, n: number, won: number): CalRow[] =>
  Array.from({ length: n }, (_, i) => ({ probability: p, won: i < won }))

describe('bucketize', () => {
  it('returns all ten deciles even when empty, with a stable axis', () => {
    const b = bucketize([])
    expect(b).toHaveLength(10)
    expect(b.map((x) => x.label)).toEqual([
      '0–9',
      '10–19',
      '20–29',
      '30–39',
      '40–49',
      '50–59',
      '60–69',
      '70–79',
      '80–89',
      '90–100',
    ])
    expect(b.every((x) => x.n === 0 && x.predicted === null && x.actual === null && x.gap === null)).toBe(
      true,
    )
  })

  it('puts 100 in the top bin and computes predicted/actual/gap', () => {
    // Bin 90–100: four deals at 90, two won → actual 50%, predicted 90 → gap −40.
    const b = bucketize(rows(90, 4, 2))
    const top = b[9]
    expect(top.n).toBe(4)
    expect(top.predicted).toBe(90)
    expect(top.actual).toBe(50)
    expect(top.gap).toBe(-40)
    // A lone 100 lands in the same top bin, not off the end.
    expect(bucketize([{ probability: 100, won: true }])[9].n).toBe(1)
  })

  it('bins by the 10-point decile of the score', () => {
    const b = bucketize([
      { probability: 5, won: false },
      { probability: 15, won: true },
      { probability: 72, won: true },
    ])
    expect(b[0].n).toBe(1)
    expect(b[1].n).toBe(1)
    expect(b[7].n).toBe(1)
  })
})

describe('brierScore', () => {
  it('is null with no data', () => {
    expect(brierScore([])).toBeNull()
  })

  it('is 0 for perfectly confident correct predictions', () => {
    expect(brierScore([{ probability: 100, won: true }, { probability: 0, won: false }])).toBe(0)
  })

  it('is 1 for confidently wrong predictions', () => {
    expect(brierScore([{ probability: 100, won: false }, { probability: 0, won: true }])).toBe(1)
  })

  it('is 0.25 for a coin-flip 50% score either way', () => {
    expect(brierScore([{ probability: 50, won: true }])).toBe(0.25)
    expect(brierScore([{ probability: 50, won: false }])).toBe(0.25)
  })

  it('averages the squared error across rows', () => {
    // (0.8−1)^2 = 0.04, (0.3−0)^2 = 0.09 → mean 0.065
    expect(
      brierScore([{ probability: 80, won: true }, { probability: 30, won: false }]),
    ).toBe(0.065)
  })
})

describe('calibrationSummary', () => {
  it('flags insufficient with no rows', () => {
    expect(calibrationSummary([]).verdict).toBe('insufficient')
  })

  it('reads well-calibrated when actual tracks predicted within the band', () => {
    // Predicted 80, 8/10 win → actual 80, gap 0.
    const s = calibrationSummary(rows(80, 10, 8))
    expect(s.meanPredicted).toBe(80)
    expect(s.meanActual).toBe(80)
    expect(s.averageGap).toBe(0)
    expect(s.verdict).toBe('well-calibrated')
  })

  it('reads over-confident when deals close less often than claimed', () => {
    // Predicted 90, only 5/10 win → actual 50, gap −40.
    const s = calibrationSummary(rows(90, 10, 5))
    expect(s.averageGap).toBe(-40)
    expect(s.verdict).toBe('over-confident')
  })

  it('reads under-confident when deals close more often than claimed', () => {
    // Predicted 40, 9/10 win → actual 90, gap +50.
    const s = calibrationSummary(rows(40, 10, 9))
    expect(s.averageGap).toBe(50)
    expect(s.verdict).toBe('under-confident')
  })

  it('treats a small gap inside the band as well-calibrated', () => {
    // Predicted 70, 74/100 win → gap +4, inside ±5.
    expect(calibrationSummary(rows(70, 100, 74)).verdict).toBe('well-calibrated')
  })
})

describe('thresholdAdvice', () => {
  it('confirms an honest cut when leads above it close at least that often', () => {
    // 6 deals at 80, 5 won → 83% actual close above the 80 cut.
    const advice = thresholdAdvice(rows(80, 6, 5), 80)
    expect(advice.currentCohortN).toBe(6)
    expect(advice.currentActualPct).toBe(83.3)
    expect(advice.currentIsHonest).toBe(true)
    expect(advice.suggestedThreshold).toBe(80)
    expect(advice.rationale).toContain('trustworthy')
  })

  it('recommends tightening when the current cut runs hot', () => {
    // At 70: 6 deals, 2 won → 33% actual, far below the 70 claim (dishonest).
    // At 90: 6 deals, all won → 100% actual ≥ 90 (honest).
    const data = [...rows(70, 6, 2), ...rows(90, 6, 6)]
    const advice = thresholdAdvice(data, 70)
    expect(advice.currentIsHonest).toBe(false)
    expect(advice.suggestedThreshold).toBe(90)
    expect(advice.suggestedActualPct).toBe(100)
    expect(advice.rationale).toContain('tighten')
  })

  it('recommends widening to the lowest self-consistent cut', () => {
    // At 60: 6 deals, 5 won → 83% ≥ 60 (honest and lowest candidate that qualifies).
    const advice = thresholdAdvice(rows(60, 6, 5), 80)
    expect(advice.suggestedThreshold).toBe(60)
    expect(advice.rationale).toContain('drop')
  })

  it('returns no suggestion when the model reads hot everywhere', () => {
    // Every cut's cohort closes below the cut.
    const advice = thresholdAdvice(rows(90, 10, 3), 90)
    expect(advice.suggestedThreshold).toBeNull()
    expect(advice.rationale).toContain('relative rank')
  })

  it('ignores cuts without the minimum cohort', () => {
    // Only 3 deals at 90 — below MIN_COHORT of 5 — so no cut qualifies.
    const advice = thresholdAdvice(rows(90, 3, 3), 90)
    expect(advice.suggestedThreshold).toBeNull()
  })
})

describe('verdictNarrative', () => {
  it('explains each verdict in plain English', () => {
    expect(verdictNarrative('insufficient', null)).toContain('Not enough')
    expect(verdictNarrative('well-calibrated', 3)).toContain('face value')
    expect(verdictNarrative('over-confident', -12)).toContain('LESS often')
    expect(verdictNarrative('under-confident', 12)).toContain('MORE often')
  })
})
