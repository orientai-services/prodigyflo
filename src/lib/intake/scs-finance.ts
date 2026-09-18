import { asRecord, str } from '@/lib/packet/schema'

function quoted(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return String(value)
  const text = str(value)
  if (!text || text === '0' || text.toUpperCase() === 'MISSING') return ''
  return text
}

/**
 * SCS extract-backed finance facts from a schema-42 packet.
 * Never copies monthly_guess or lender_guess.
 */
export function quotedFinanceFromPacket(raw: unknown): Record<string, string> {
  const top = asRecord(raw)
  const data = asRecord(top.data)
  const finance = asRecord(data.finance)
  const money = asRecord(data.money)
  const out: Record<string, string> = {}
  const amount = quoted(finance.amount_financed)
  const term = quoted(finance.term_months)
  const rate = quoted(finance.rate)
  const dealer = quoted(finance.dealer_fee)
  const firstPay = quoted(finance.first_payment_date)
  const monthly = quoted(money.monthly_solar_payment)
  const remaining = quoted(finance.remaining) || quoted(money.remaining_balance)
  if (amount) out.amount_financed = amount
  if (term) out.term_months = term
  if (rate) out.interest_rate = rate
  if (dealer) out.dealer_fee = dealer
  if (firstPay) out.first_payment_date = firstPay
  if (monthly) out.monthly_payment = monthly
  if (remaining) out.remaining_balance = remaining
  return out
}
