import { describe, expect, it } from 'vitest'
import { evaluateReady } from './ready'

const base = {
  first_name: 'Ada',
  last_name: 'West',
  phone: '5551112222',
  email: 'ada@example.com',
  property_street: '1 Main',
  city: 'Las Vegas',
  state: 'NV',
  zip: '89101',
  product_confirmed: 'loan',
  lender_confirmed: 'GoodLeap',
  monthly: '189',
  has_contract: true,
  has_finance: false,
}

describe('evaluateReady', () => {
  it('is A when identity, product, lender, monthly, and a signed doc exist', () => {
    expect(evaluateReady(base)).toEqual({ ready: true, closeability: 'A', missing: [] })
  })

  it('stays A without a payoff field (not in this gate)', () => {
    expect(evaluateReady(base).ready).toBe(true)
  })

  it('is C with no signed instrument', () => {
    const r = evaluateReady({ ...base, has_contract: false, has_finance: false })
    expect(r.closeability).toBe('C')
    expect(r.ready).toBe(false)
  })

  it('is B when identity is present but monthly is missing', () => {
    const r = evaluateReady({ ...base, monthly: '' })
    expect(r.closeability).toBe('B')
  })
})
