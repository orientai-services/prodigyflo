import { describe, expect, it } from 'vitest'
import {
  agreementKind,
  buildFinanceCells,
  collectFinanceFacts,
  isPpaOrLease,
} from './desk-finance-module'

describe('agreementKind', () => {
  it('recognizes PPA, lease, loan, and cash', () => {
    expect(agreementKind('ppa')).toBe('ppa')
    expect(agreementKind('PPA — Power Purchase Agreement')).toBe('ppa')
    expect(agreementKind('lease')).toBe('lease')
    expect(agreementKind('loan')).toBe('loan')
    expect(agreementKind('cash')).toBe('cash')
    expect(agreementKind('unsure')).toBe('unsure')
    expect(agreementKind('')).toBe('unsure')
  })
})

describe('buildFinanceCells · PPA', () => {
  const now = new Date('2026-09-18T12:00:00Z')
  const cells = buildFinanceCells('ppa', {
    monthly: '189.40',
    termMonths: '300',
    firstPay: '2024-03-01',
    lender: 'Sunnova',
    escalator: '2.9',
    buyout: 'FMV after year 5',
    amountFinanced: '48000',
    apr: '6.49',
    remainingQuoted: '32000',
    dealerFee: '2400',
  }, now)

  function cell(label: string) {
    return cells.find((c) => c.label === label)!.cell
  }

  it('fills PPA-real fields and refuses loan-only dollars', () => {
    expect(isPpaOrLease('ppa')).toBe(true)
    expect(cell('Monthly payment')).toEqual({ kind: 'value', display: '$189.40', amount: 189.4 })
    expect(cell('Term months')).toEqual({ kind: 'value', display: '300' })
    expect(cell('Lender')).toEqual({ kind: 'value', display: 'Sunnova' })
    expect(cell('First payment date')).toEqual({ kind: 'value', display: '2024-03-01' })
    expect(cell('Yearly payment increase').kind).toBe('value')
    expect(cell('Buyout terms')).toEqual({ kind: 'value', display: 'FMV after year 5' })
    expect(cell('Total / amount financed')).toEqual({ kind: 'missing' })
    expect(cell('Interest rate')).toEqual({ kind: 'missing' })
    expect(cell('Remaining balance')).toEqual({ kind: 'missing' })
    expect(cell('Dealer fee')).toEqual({ kind: 'missing' })
    expect(cell('Interest paid to date')).toEqual({ kind: 'missing' })
  })

  it('does not treat leftover calendar months as a $0 loan balance', () => {
    expect(cell('Remaining balance').kind).toBe('missing')
    expect(cell('Months remaining').kind).toBe('value')
  })
})

describe('buildFinanceCells · loan', () => {
  it('still fills financed and APR from a loan extract', () => {
    const cells = buildFinanceCells('loan', {
      amountFinanced: '24800',
      apr: '5.99',
      monthly: '154.80',
      termMonths: '300',
      firstPay: '2026-10-01',
      dealerFee: '1240',
      lender: 'GoodLeap',
    }, new Date('2026-10-01T12:00:00Z'))
    expect(cells.find((c) => c.label === 'Total / amount financed')!.cell.kind).toBe('value')
    expect(cells.find((c) => c.label === 'Interest rate')!.cell.kind).toBe('value')
    expect(cells.find((c) => c.label === 'Monthly payment')!.cell.kind).toBe('value')
    expect(cells.find((c) => c.label === 'Yearly payment increase')).toBeUndefined()
  })
})

describe('collectFinanceFacts', () => {
  it('reads PPA monthly and servicer from the solar contract when there is no loan file', () => {
    const facts = collectFinanceFacts('ppa', (type, field) => {
      if (type === 'finance_agreement') return ''
      if (type === 'solar_contract' && field === 'monthly_payment') return '189.40'
      if (type === 'solar_contract' && field === 'lender_name') return 'Sunnova'
      if (type === 'solar_contract' && field === 'term_months') return '300'
      if (type === 'solar_contract' && field === 'escalator_rate') return '2.9'
      return ''
    }, { monthly_payment: '', lender_guess: 'ignored' })
    expect(facts.monthly).toBe('189.40')
    expect(facts.lender).toBe('Sunnova')
    expect(facts.termMonths).toBe('300')
    expect(facts.escalator).toBe('2.9')
    expect(facts.amountFinanced).toBe('')
    expect(facts.apr).toBe('')
  })

  it('reads loan amount, APR, and a typed monthly from the install agreement', () => {
    const facts = collectFinanceFacts('loan', (type, field) => {
      if (type === 'solar_contract' && field === 'amount_financed') return '36819.55'
      if (type === 'solar_contract' && field === 'apr') return '2.99'
      if (type === 'solar_contract' && field === 'first_payment_date') return '2022-12-12'
      if (type === 'solar_contract' && field === 'lender_name') return ''
      return ''
    }, { monthly_guess: '350' })
    expect(facts.amountFinanced).toBe('36819.55')
    expect(facts.apr).toBe('2.99')
    expect(facts.firstPay).toBe('2022-12-12')
    expect(facts.monthly).toBe('350')
    expect(facts.lender).toBe('')
  })

  it('does not take financed or APR off a solar contract even if present', () => {
    const facts = collectFinanceFacts('ppa', (type, field) => {
      if (type === 'solar_contract' && field === 'amount_financed') return '48000'
      if (type === 'solar_contract' && field === 'apr') return '6.49'
      if (type === 'solar_contract' && field === 'monthly_payment') return '189.40'
      return ''
    }, {})
    expect(facts.monthly).toBe('189.40')
    expect(facts.amountFinanced).toBe('')
    expect(facts.apr).toBe('')
  })
})
