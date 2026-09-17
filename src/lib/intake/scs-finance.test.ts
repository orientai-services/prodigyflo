import { describe, expect, it } from 'vitest'
import { quotedFinanceFromPacket } from './scs-finance'

describe('quotedFinanceFromPacket', () => {
  it('copies extract-backed finance keys and ignores guesses', () => {
    const out = quotedFinanceFromPacket({
      data: {
        finance: {
          amount_financed: 24800,
          term_months: 300,
          rate: 5.99,
          dealer_fee: 1240,
          first_payment_date: '2026-10-01',
          remaining: 18000,
        },
        money: { monthly_solar_payment: 154.8 },
        stage1_answers: { monthly_guess: 344, lender_guess: 'GoodLeap' },
      },
    })
    expect(out).toEqual({
      amount_financed: '24800',
      term_months: '300',
      interest_rate: '5.99',
      dealer_fee: '1240',
      first_payment_date: '2026-10-01',
      monthly_payment: '154.8',
    })
    expect(out.monthly_guess).toBeUndefined()
    expect(out.lender_guess).toBeUndefined()
  })

  it('returns empty when the finance block has no quoted dollars', () => {
    expect(quotedFinanceFromPacket({
      data: { finance: { amount_financed: null, rate: null }, stage1_answers: { monthly_guess: 344 } },
    })).toEqual({})
  })
})
