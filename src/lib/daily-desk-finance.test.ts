import { describe, expect, it } from 'vitest'
import { amortize, cellDisplay, sourceMoney } from '@/lib/daily-desk-finance'

describe('sourceMoney', () => {
  it('treats blank and $0 as missing, never as a balance', () => {
    expect(sourceMoney('')).toEqual({ kind: 'missing' })
    expect(sourceMoney('0')).toEqual({ kind: 'missing' })
    expect(sourceMoney('$0.00')).toEqual({ kind: 'missing' })
    expect(sourceMoney('$31,860')).toMatchObject({ kind: 'value', amount: 31860 })
  })
})

describe('amortize', () => {
  it('returns Cannot compute when first-pay date is missing — not $0', () => {
    const out = amortize({
      firstPayDate: null,
      termMonths: 240,
      aprPercent: 5.99,
      monthlyPayment: 205.18,
    })
    expect(out.missing).toContain('first payment date')
    expect(out.remaining.kind).toBe('cannot_compute')
    expect(cellDisplay(out.remaining)).toBe('Cannot compute')
    expect(out.remaining.kind === 'value' ? out.remaining.amount : null).toBeNull()
  })

  it('returns Cannot compute when rate is missing', () => {
    const out = amortize({
      firstPayDate: '2024-01-01',
      termMonths: 240,
      aprPercent: null,
      monthlyPayment: 205.18,
    })
    expect(out.interestPaid.kind).toBe('cannot_compute')
    expect(cellDisplay(out.interestPaid)).not.toBe('$0.00')
  })

  it('computes remaining and interest when every input is present', () => {
    const out = amortize({
      firstPayDate: '2024-01-15',
      termMonths: 240,
      aprPercent: 5.99,
      monthlyPayment: 205.18,
      now: new Date('2026-09-16'),
    })
    expect(out.missing).toEqual([])
    expect(out.remaining.kind).toBe('value')
    if (out.remaining.kind !== 'value') throw new Error('expected value')
    expect(out.remaining.amount).toBeGreaterThan(0)
    expect(out.remaining.display).not.toBe('$0.00')
    expect(out.monthsRemaining).toMatchObject({ kind: 'value', display: '208' })
  })
})
