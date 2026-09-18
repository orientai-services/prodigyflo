/**
 * Desk finance cells keyed by agreement type.
 *
 * Loan: financed / APR / remaining / dealer from a loan extract, then amortize.
 * PPA or lease: monthly / term / first-pay / servicer / escalator / buyout only.
 * Never invent $0. Never put an escalator in the APR box. Never amortize a PPA.
 */

import {
  amortize,
  parseFirstPayDate,
  parseNumber,
  sourceMoney,
  sourcePercent,
  sourceText,
  type ComputedCell,
} from '@/lib/daily-desk-finance'
import type { CaseCell } from '@/lib/daily-desk-case-types'

export type AgreementKind = 'loan' | 'ppa' | 'lease' | 'cash' | 'unsure'

export type FinanceFacts = {
  amountFinanced?: string | null
  remainingQuoted?: string | null
  apr?: string | null
  termMonths?: string | null
  monthly?: string | null
  dealerFee?: string | null
  lender?: string | null
  firstPay?: string | null
  escalator?: string | null
  buyout?: string | null
}

const MISSING: ComputedCell = { kind: 'missing' }

export function agreementKind(raw: string | null | undefined): AgreementKind {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s || s === 'unsure' || s === 'unknown' || s === 'not sure') return 'unsure'
  if (s === 'ppa' || s.includes('power purchase') || /\bppa\b/.test(s)) return 'ppa'
  if (s === 'lease' || s.includes('lease')) return 'lease'
  if (s === 'cash' || s === 'cpa' || s.includes('cash')) return 'cash'
  if (s === 'loan' || s.includes('loan') || s.includes('til')) return 'loan'
  return 'unsure'
}

export function isPpaOrLease(kind: AgreementKind): boolean {
  return kind === 'ppa' || kind === 'lease'
}

export const LOAN_ONLY_FIELDS = ['amount_financed', 'apr', 'interest_rate', 'dealer_fee', 'remaining_balance'] as const

export const PPA_FIELDS = [
  'monthly_payment',
  'term_months',
  'first_payment_date',
  'lender_name',
  'escalator_rate',
  'buyout_terms',
] as const

type Pull = (typeKey: string, fieldKey: string) => string

function firstFilled(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const text = (value ?? '').trim()
    if (text && text.toUpperCase() !== 'MISSING') return text
  }
  return ''
}

function answer(answers: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const raw = answers[key]
    if (raw == null) continue
    const text = String(raw).trim()
    if (text && text.toUpperCase() !== 'MISSING') return text
  }
  return ''
}

/**
 * Pull printed facts for the desk finance block.
 * Monthly / term / first-pay / servicer may come from any contract type.
 * Financed / APR / dealer / remaining only come from a loan file (or stored loan answers).
 */
export function collectFinanceFacts(
  kind: AgreementKind,
  pull: Pull,
  answers: Record<string, unknown> = {},
): FinanceFacts {
  const loan = (field: string) => pull('finance_agreement', field)
  const solar = (field: string) => pull('solar_contract', field)

  return {
    amountFinanced: isPpaOrLease(kind) ? '' : firstFilled(loan('amount_financed'), answer(answers, 'amount_financed')),
    remainingQuoted: isPpaOrLease(kind) ? '' : firstFilled(loan('remaining_balance'), answer(answers, 'remaining_balance')),
    apr: isPpaOrLease(kind) ? '' : firstFilled(loan('apr'), loan('interest_rate'), answer(answers, 'interest_rate', 'apr')),
    dealerFee: isPpaOrLease(kind) ? '' : firstFilled(loan('dealer_fee'), answer(answers, 'dealer_fee')),
    monthly: firstFilled(
      loan('monthly_payment'),
      solar('monthly_payment'),
      answer(answers, 'monthly_payment', 'monthly_solar_payment'),
    ),
    termMonths: firstFilled(
      loan('term_months'),
      solar('term_months'),
      answer(answers, 'term_months', 'payment_term_months'),
    ),
    firstPay: firstFilled(
      loan('first_payment_date'),
      solar('first_payment_date'),
      answer(answers, 'first_payment_date'),
    ),
    lender: firstFilled(
      loan('lender_name'),
      solar('lender_name'),
      answer(answers, 'lender_confirmed', 'lender_servicer'),
    ),
    escalator: isPpaOrLease(kind)
      ? firstFilled(solar('escalator_rate'), loan('escalator_rate'), answer(answers, 'escalator_rate'))
      : '',
    buyout: isPpaOrLease(kind)
      ? firstFilled(solar('buyout_terms'), loan('buyout_terms'), answer(answers, 'buyout_terms'))
      : '',
  }
}

function termYearsCell(termMonths: string | null | undefined): ComputedCell {
  const n = parseNumber(termMonths)
  if (n == null || n <= 0) return MISSING
  const years = n / 12
  return { kind: 'value', display: years.toFixed(n % 12 === 0 ? 0 : 1), amount: years }
}

function calendarLeft(termMonths: string | null | undefined, firstPay: string | null | undefined, now: Date): {
  years: ComputedCell
  months: ComputedCell
} {
  const term = parseNumber(termMonths)
  const start = parseFirstPayDate(firstPay ?? null)
  if (term == null || term <= 0 || !start) {
    return { years: MISSING, months: MISSING }
  }
  const elapsed = Math.max(0, (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()))
  const left = Math.max(0, Math.trunc(term) - elapsed)
  if (left === 0) return { years: MISSING, months: MISSING }
  return {
    years: { kind: 'value', display: (left / 12).toFixed(left % 12 === 0 ? 0 : 1), amount: left / 12 },
    months: { kind: 'value', display: String(left), amount: left },
  }
}

export function buildFinanceCells(kind: AgreementKind, facts: FinanceFacts, now: Date = new Date()): CaseCell[] {
  if (isPpaOrLease(kind)) return ppaCells(kind, facts, now)
  return loanCells(facts, now)
}

function ppaCells(kind: AgreementKind, facts: FinanceFacts, now: Date): CaseCell[] {
  const label = kind === 'lease' ? 'lease' : 'PPA'
  const left = calendarLeft(facts.termMonths, facts.firstPay, now)
  return [
    { label: 'Total / amount financed', cell: MISSING, hint: `A ${label} has no amount financed` },
    { label: 'Remaining balance', cell: MISSING, hint: `A ${label} has no loan balance` },
    { label: 'Interest rate', cell: MISSING, hint: 'Not an APR. Yearly increase is a separate cell.' },
    { label: 'Interest paid to date', cell: MISSING, hint: `A ${label} does not accrue loan interest` },
    { label: 'Term years', cell: termYearsCell(facts.termMonths) },
    { label: 'Term months', cell: sourceText(facts.termMonths) },
    { label: 'Years remaining', cell: left.years, hint: left.years.kind === 'missing' ? 'Needs term and first-pay date' : 'Calendar time left, not a loan payoff' },
    { label: 'Months remaining', cell: left.months, hint: left.months.kind === 'missing' ? 'Needs term and first-pay date' : 'Calendar time left, not a loan payoff' },
    { label: 'Monthly payment', cell: sourceMoney(facts.monthly) },
    { label: 'Dealer fee', cell: MISSING, hint: `A ${label} has no dealer fee` },
    { label: 'Lender', cell: sourceText(facts.lender) },
    { label: 'First payment date', cell: sourceText(facts.firstPay) },
    { label: 'Yearly payment increase', cell: sourcePercent(facts.escalator) },
    { label: 'Buyout terms', cell: sourceText(facts.buyout) },
  ]
}

function loanCells(facts: FinanceFacts, now: Date): CaseCell[] {
  const amort = amortize({
    firstPayDate: facts.firstPay,
    termMonths: facts.termMonths,
    aprPercent: facts.apr,
    monthlyPayment: facts.monthly,
    now,
  })
  return [
    { label: 'Total / amount financed', cell: sourceMoney(facts.amountFinanced) },
    {
      label: 'Remaining balance',
      cell: amort.remaining,
      hint: amort.remaining.kind === 'cannot_compute' ? `Needs ${amort.missing.join(', ')}` : 'Amortization from first-pay date',
    },
    { label: 'Interest rate', cell: sourcePercent(facts.apr) },
    {
      label: 'Interest paid to date',
      cell: amort.interestPaid,
      hint: amort.interestPaid.kind === 'cannot_compute' ? `Needs ${amort.missing.join(', ')}` : undefined,
    },
    { label: 'Term years', cell: termYearsCell(facts.termMonths) },
    { label: 'Term months', cell: sourceText(facts.termMonths) },
    {
      label: 'Years remaining',
      cell: amort.yearsRemaining,
      hint: amort.yearsRemaining.kind === 'cannot_compute' ? `Needs ${amort.missing.join(', ')}` : undefined,
    },
    {
      label: 'Months remaining',
      cell: amort.monthsRemaining,
      hint: amort.monthsRemaining.kind === 'cannot_compute' ? `Needs ${amort.missing.join(', ')}` : undefined,
    },
    { label: 'Monthly payment', cell: sourceMoney(facts.monthly) },
    { label: 'Dealer fee', cell: sourceMoney(facts.dealerFee), hint: facts.dealerFee ? 'Embedded in principal' : undefined },
    { label: 'Lender', cell: sourceText(facts.lender) },
    { label: 'First payment date', cell: sourceText(facts.firstPay) },
  ]
}
