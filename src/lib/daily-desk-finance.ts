/**
 * Finance cells for the Daily Desk case file.
 * Missing inputs → "Cannot compute" / "Missing". Never invent $0.
 */

export type ComputedCell =
  | { kind: 'value'; display: string; amount?: number }
  | { kind: 'missing'; hint?: string }
  | { kind: 'cannot_compute'; missing: string[] }

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})

export function parseNumber(raw: string | number | null | undefined): number | null {
  if (raw == null) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const cleaned = raw.replace(/[^0-9.-]/g, '')
  if (!cleaned || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/** Source money: blank or literal 0 is missing, not a balance. */
export function sourceMoney(raw: string | number | null | undefined): ComputedCell {
  const n = parseNumber(raw)
  if (n == null || n === 0) return { kind: 'missing' }
  return { kind: 'value', display: MONEY.format(n), amount: n }
}

export function sourceText(raw: string | null | undefined): ComputedCell {
  const s = (raw ?? '').trim()
  if (!s || s.toUpperCase() === 'MISSING' || s.toLowerCase() === 'unknown') return { kind: 'missing' }
  return { kind: 'value', display: s }
}

export function sourcePercent(raw: string | number | null | undefined, suffix = ''): ComputedCell {
  const n = parseNumber(raw)
  if (n == null) return { kind: 'missing' }
  const pct = n > 0 && n < 1 ? n * 100 : n
  return { kind: 'value', display: `${trimNum(pct)}%${suffix}`, amount: pct }
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

export function parseFirstPayDate(raw: string | null | undefined): Date | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export type AmortizationInput = {
  firstPayDate: string | null | undefined
  termMonths: string | number | null | undefined
  aprPercent: string | number | null | undefined
  monthlyPayment: string | number | null | undefined
  now?: Date
}

export type Amortization = {
  remaining: ComputedCell
  interestPaid: ComputedCell
  yearsRemaining: ComputedCell
  monthsRemaining: ComputedCell
  missing: string[]
}

/**
 * Remaining balance / interest paid / time left.
 * Requires first-pay date + term + rate + payment. Anything missing → cannot_compute.
 */
export function amortize(input: AmortizationInput): Amortization {
  const missing: string[] = []
  const first = parseFirstPayDate(input.firstPayDate ?? null)
  if (!first) missing.push('first payment date')
  const term = parseNumber(input.termMonths)
  if (term == null || term <= 0) missing.push('term')
  const apr = parseNumber(input.aprPercent)
  if (apr == null) missing.push('interest rate')
  const pmt = parseNumber(input.monthlyPayment)
  if (pmt == null || pmt === 0) missing.push('monthly payment')

  if (missing.length > 0) {
    const cell: ComputedCell = { kind: 'cannot_compute', missing }
    return { remaining: cell, interestPaid: cell, yearsRemaining: cell, monthsRemaining: cell, missing }
  }

  const n = term as number
  const payment = pmt as number
  const aprPct = (apr as number) > 0 && (apr as number) < 1 ? (apr as number) * 100 : (apr as number)
  const r = aprPct / 100 / 12
  const now = input.now ?? new Date()
  const elapsed = Math.max(0, monthDiff(first as Date, now))
  const paid = Math.min(elapsed, n)
  const left = Math.max(0, n - paid)

  const original = presentValue(payment, r, n)
  const remainingAmt = presentValue(payment, r, left)
  const principalPaid = Math.max(0, original - remainingAmt)
  const interestPaidAmt = Math.max(0, paid * payment - principalPaid)

  return {
    remaining: { kind: 'value', display: MONEY.format(remainingAmt), amount: remainingAmt },
    interestPaid: { kind: 'value', display: MONEY.format(interestPaidAmt), amount: interestPaidAmt },
    yearsRemaining: { kind: 'value', display: trimNum(left / 12), amount: left / 12 },
    monthsRemaining: { kind: 'value', display: String(left), amount: left },
    missing: [],
  }
}

function presentValue(pmt: number, r: number, periods: number): number {
  if (periods <= 0) return 0
  if (r === 0) return pmt * periods
  return pmt * (1 - Math.pow(1 + r, -periods)) / r
}

function monthDiff(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth())
}

export function cellDisplay(cell: ComputedCell): string {
  if (cell.kind === 'value') return cell.display
  if (cell.kind === 'missing') return 'Missing'
  return 'Cannot compute'
}
