import { describe, expect, it } from 'vitest'
import { amortize, cellDisplay, dealerFeeFromAmount, listedMoney, ppaPaymentSchedule, sourceMoney } from '@/lib/daily-desk-finance'

describe('listedMoney', () => {
  it('does not invent $0 on lists or chips', () => {
    expect(listedMoney(null)).toBe('Cannot compute')
    expect(listedMoney(0)).toBe('Cannot compute')
    expect(listedMoney('0')).toBe('Cannot compute')
    expect(listedMoney(31860)).toBe('$31,860.00')
  })
})

describe('sourceMoney', () => {
  it('treats blank and $0 as missing, never as a balance', () => {
    expect(sourceMoney('')).toEqual({ kind: 'missing' })
    expect(sourceMoney('0')).toEqual({ kind: 'missing' })
    expect(sourceMoney('$0.00')).toEqual({ kind: 'missing' })
    expect(sourceMoney('$31,860')).toMatchObject({ kind: 'value', amount: 31860 })
  })
})

describe('dealerFeeFromAmount', () => {
  it('is 30% of the amount tile, rounded to cents', () => {
    expect(dealerFeeFromAmount(16734.94)).toMatchObject({ kind: 'value', amount: 5020.48, display: '$5,020.48' })
    expect(dealerFeeFromAmount(59823)).toMatchObject({ kind: 'value', amount: 17946.9, display: '$17,946.90' })
  })
  it('is missing when the amount tile is empty', () => {
    expect(dealerFeeFromAmount(null)).toEqual({ kind: 'missing' })
    expect(dealerFeeFromAmount('')).toEqual({ kind: 'missing' })
    expect(dealerFeeFromAmount(0)).toEqual({ kind: 'missing' })
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

  it('schedules PPA remaining with a yearly escalator and never treats it as APR', () => {
    const out = ppaPaymentSchedule({ yearOneMonthly: 100, escalatorPct: 2.5, termMonths: 24, monthsElapsed: 12 })
    expect(out.paid).toBe(1200)
    expect(out.remaining).toBe(Math.round(100 * 1.025 * 12 * 100) / 100)
    expect(out.total).toBe(Math.round((1200 + 100 * 1.025 * 12) * 100) / 100)
  })

  it('uses intro then ongoing payments when a stepped schedule is supplied', () => {
    const out = amortize({
      firstPayDate: '2023-04-21',
      termMonths: 300,
      aprPercent: 6,
      monthlyPayment: 374.94,
      principal: 58927.5,
      introPayment: 263.22,
      introCount: 17,
      now: new Date('2026-09-21T12:00:00Z'),
    })
    expect(out.remaining).toMatchObject({ kind: 'value', amount: 57511.96 })
    expect(out.monthsRemaining).toMatchObject({ kind: 'value', display: '259' })
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
