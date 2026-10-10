import { describe, expect, it } from 'vitest'
import { parsePending, paymentLabel, stepChargeDetector, type Pending, type Reading } from './billing'

const T0 = Date.parse('2026-10-01T12:00:00Z')
let n = 0
const r = (balance: number, spent: number, minutes: number, fundingType: number | null = 1): Reading => ({
  snapshotId: `s${++n}`, balanceCents: balance, amountSpentCents: spent, fundingType, at: new Date(T0 + minutes * 60_000),
})

/** Feed readings in order; return every step. */
function run(readings: Reading[]) {
  let prev: Reading | null = null
  let pending: Pending | null = null
  const steps = []
  for (const x of readings) {
    const s = stepChargeDetector(prev, pending, x)
    steps.push(s)
    pending = s.pending
    if (s.event !== 'stale') prev = x
  }
  return steps
}

describe('payment detector', () => {
  it('a clean payment: candidate, then two confirming readings', () => {
    const steps = run([r(50_000, 100_000, 0), r(300, 100_300, 10), r(500, 100_500, 20), r(700, 100_700, 30)])
    expect(steps.map((s) => s.event)).toEqual(['none', 'candidate', 'confirming', 'confirmed'])
    expect(steps[3].emit).toEqual({ fromSnapshotId: steps[1].pending!.fromSnapshotId, amountCents: 49_700, occurredAt: new Date(T0 + 10 * 60_000).toISOString() })
  })
  it('the stale replica flap (8.96 → 0.03 → 8.96) records nothing', () => {
    const steps = run([r(896, 100_000, 0), r(3, 50_000, 10), r(900, 100_010, 20), r(905, 100_020, 30)])
    expect(steps[1].event).toBe('stale')
    expect(steps.every((s) => s.emit === null)).toBe(true)
  })
  it('a high-spend account climbing back while amount_spent moves is confirmed, not a bounce', () => {
    const steps = run([r(100_000, 1_000_000, 0), r(500, 1_000_000, 10), r(2_100, 1_001_600, 20), r(3_800, 1_003_300, 30)])
    expect(steps.map((s) => s.event)).toEqual(['none', 'candidate', 'confirming', 'confirmed'])
    expect(steps[3].emit!.amountCents).toBe(99_500)
  })
  it('a true bounce with flat spend is discarded', () => {
    const steps = run([r(50_000, 100_000, 0), r(1_000, 100_000, 10), r(49_900, 100_050, 20)])
    expect(steps.map((s) => s.event)).toEqual(['none', 'candidate', 'bounce'])
    expect(steps[2].pending).toBeNull()
  })
  it('a drop of $0.50 is ignored', () => {
    expect(run([r(1_000, 100, 0), r(950, 150, 10)])[1].event).toBe('none')
  })
  it('a drop to 70% is ignored', () => {
    expect(run([r(10_000, 100, 0), r(7_000, 150, 10)])[1].event).toBe('none')
  })
  it('a deeper drop lowers the amount it settles on', () => {
    const steps = run([r(50_000, 100_000, 0), r(20_000, 100_000, 10), r(5_000, 100_100, 20), r(5_100, 100_200, 30), r(5_150, 100_250, 40)])
    expect(steps.map((s) => s.event)).toEqual(['none', 'candidate', 'deeper', 'confirming', 'confirmed'])
    expect(steps[4].emit!.amountCents).toBe(45_000)
  })
  it('expires after 12 readings without confirmation (wall clock never expires it)', () => {
    const readings = [r(10_000, 100, 0), r(5_000, 100, 10)]
    // Hovering at 70% of the old balance with no spend: never low enough, never back.
    for (let i = 0; i < 12; i++) readings.push(r(7_000, 100, 20 + i * 10))
    const steps = run(readings)
    expect(steps.slice(2, 13).every((s) => s.event === 'none')).toBe(true)
    expect(steps[13].event).toBe('expired')
    expect(steps.every((s) => s.emit === null)).toBe(true)
  })
  it('a gap of 90 minutes still low counts double and confirms at once', () => {
    const steps = run([r(50_000, 100_000, 0), r(300, 100_300, 10), r(500, 100_500, 100)])
    expect(steps.map((s) => s.event)).toEqual(['none', 'candidate', 'confirmed'])
  })
  it('funding type 2 (Meta balance) turns the detector off', () => {
    const steps = run([r(50_000, 100_000, 0, 2), r(300, 100_300, 10, 2)])
    expect(steps.map((s) => s.event)).toEqual(['off', 'off'])
  })
  it('direct debit (17) is tracked', () => {
    expect(run([r(50_000, 100_000, 0, 17), r(300, 100_300, 10, 17)])[1].event).toBe('candidate')
  })
  it('two back-to-back genuine payments are both emitted', () => {
    const steps = run([
      r(50_000, 100_000, 0), r(300, 100_300, 10), r(400, 100_400, 20), r(500, 100_500, 30), // payment 1
      r(40_000, 140_000, 40), r(200, 140_200, 50), r(300, 140_300, 60), r(400, 140_400, 70), // payment 2
    ])
    const emits = steps.filter((s) => s.emit).map((s) => s.emit!)
    expect(emits).toHaveLength(2)
    expect(emits[0].fromSnapshotId).not.toBe(emits[1].fromSnapshotId)
  })
  it('re-running the same reading is idempotent', () => {
    const a = r(50_000, 100_000, 0)
    const b = r(300, 100_300, 10)
    const first = stepChargeDetector(a, null, b)
    expect(first.event).toBe('candidate')
    const again = stepChargeDetector(a, first.pending, b)
    expect(again).toEqual({ pending: first.pending, emit: null, event: 'none' })
    expect(stepChargeDetector(b, first.pending, b).event).toBe('none')
  })
  it('pending state round-trips through JSON', () => {
    const s = run([r(50_000, 100_000, 0), r(300, 100_300, 10)])[1]
    expect(parsePending(JSON.parse(JSON.stringify(s.pending)))).toEqual(s.pending)
    expect(parsePending({ fromSnapshotId: 'x' })).toBeNull()
    expect(parsePending(null)).toBeNull()
  })
  it('labels the row as a payment or charge', () => {
    expect(paymentLabel(49_700)).toBe('Payment or charge, about $497.00')
  })
})
