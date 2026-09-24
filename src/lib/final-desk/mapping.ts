import { extractedFact } from '@/lib/desk-extract'
import { dealerFeeFromAmount, ppaPaymentSchedule } from '@/lib/daily-desk-finance'
import { emptyAnswers, QUESTIONS, type QuestionnaireAnswers } from './questions'
import type { CaseCell, CaseFileData } from '@/lib/daily-desk-case-types'

export const DOCUMENT_MODULES = [
  ['finance_agreement', 'Lender Finance Agreement'],
  ['signed_contract', 'Solar Contract Install Agreement'],
  ['utility_bill', 'Utility bill'],
  ['comm_evidence', 'Texts / Email / Ring doorbell evidence'],
  ['ucc_lien', 'UCC Fixture / Lien'],
  ['home_deed', 'Homeownership Deed'],
  ['county_permit', 'County Permit Record'],
  ['production_report', 'Solar Production Report'],
] as const

const missing = (label: string, hint?: string): CaseCell => ({ label, cell: { kind: 'missing' }, hint })
/** The fixed HTML destinations stay fixed even for PPA/lease cases. */
export function profileCells(data: Pick<CaseFileData, 'finance' | 'solar'>): { finance: CaseCell[]; solar: CaseCell[] } {
  const find = (label: string, ...sources: string[]) => {
    const cell = [...data.finance, ...data.solar].find(c => [label, ...sources].includes(c.label))
    return cell ? { ...cell, label } : missing(label)
  }
  const type = find('Agreement type').cell
  const escHint = find('Annual Escalator Rate %', 'Annual payment escalation')
  const isPpa = (type.kind === 'value' && /ppa|lease/i.test(type.display))
    || (escHint.cell.kind === 'value' && Number(String(escHint.cell.display).replace(/[^\d.]/g, '')) > 0 && !(type.kind === 'value' && /loan/i.test(type.display)))
  const amt = find('Total / amount financed')
  const amount = amt.cell.kind === 'value' ? (amt.cell.amount ?? Number(amt.cell.display.replace(/[^\d.-]/g, ''))) : NaN
  const fee = dealerFeeFromAmount(Number.isFinite(amount) ? amount : null)
  const benchmark: CaseCell = {
    label: '30% Dealer Fee',
    cell: fee,
    hint: fee.kind === 'value'
      ? 'Computed 30% of amount · unverified · staff CYS-verify required'
      : 'Needs total / amount financed',
    unverified: fee.kind === 'value',
  }
  const payment = find('Monthly payment', 'Contract-stated monthly payment')
  // Historical starting price is useful only with its explicit period qualifier.
  const shownPayment = payment.cell.kind === 'missing'
    ? find('Monthly payment', 'First-year monthly payment') : payment
  const finance = [amt, find('Remaining balance', 'Estimated remaining balance'), find('Interest rate'),
    find('Interest paid to date', 'Estimated interest paid'), find('Annual Escalator Rate %', 'Annual payment escalation'),
    find('Term years'), find('Term months'), find('Years remaining', 'Time remaining'), find('Months remaining', 'Time remaining'), shownPayment, benchmark,
    find('Lender', 'Contract counterparty'),
    find('First payment date', 'Actual in-service date', 'Customer signature date')]
  const credit = find('Credit score', 'Credit range')
  credit.label = 'Credit score'
  return completeDeskCells({
    finance,
    solar: [find('Agreement type'), find('Installer', 'Actual installer'), credit, find('System size')],
    isPpa,
  })
}

function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function fill(cell: CaseCell, display: string, hint: string, amount?: number): CaseCell {
  if (cell.cell.kind === 'value') return cell
  return {
    ...cell,
    cell: amount == null ? { kind: 'value', display } : { kind: 'value', display, amount },
    hint: [cell.hint, hint].filter(Boolean).join(' · ') || hint,
  }
}

/** After Review, finance/solar tiles stay filled. Signing date is first-pay when no cert. */
export function completeDeskCells(input: { finance: CaseCell[]; solar: CaseCell[]; isPpa: boolean }): { finance: CaseCell[]; solar: CaseCell[] } {
  const amountCell = input.finance.find(c => c.label === 'Total / amount financed')
  const amount = amountCell?.cell.kind === 'value'
    ? (amountCell.cell.amount ?? Number(String(amountCell.cell.display).replace(/[^\d.-]/g, '')))
    : NaN
  const termCell = input.finance.find(c => c.label === 'Term months')
  const termNum = termCell?.cell.kind === 'value' ? Number(String(termCell.cell.display).replace(/[^\d.]/g, '')) : NaN
  const yearOne = input.finance.find(c => c.label === 'Monthly payment' || c.label === 'First-year monthly payment' || c.label === 'Contract-stated monthly payment')
  const yearOneAmt = yearOne?.cell.kind === 'value' ? (yearOne.cell.amount ?? Number(String(yearOne.cell.display).replace(/[^\d.]/g, ''))) : NaN
  const escCell = input.finance.find(c => c.label === 'Annual Escalator Rate %')
  const escPct = escCell?.cell.kind === 'value' ? Number(String(escCell.cell.display).replace(/[^\d.]/g, '')) : 0
  const firstPay = input.finance.find(c => c.label === 'First payment date' || c.label === 'Customer signature date')
  const firstPayDate = firstPay?.cell.kind === 'value' ? new Date(String(firstPay.cell.display)) : null
  const elapsed = firstPayDate && !Number.isNaN(firstPayDate.getTime())
    ? Math.max(0, (new Date().getUTCFullYear() - firstPayDate.getUTCFullYear()) * 12 + (new Date().getUTCMonth() - firstPayDate.getUTCMonth()))
    : 0
  const ppaSched = input.isPpa && yearOneAmt > 0 && termNum > 0
    ? ppaPaymentSchedule({ yearOneMonthly: yearOneAmt, escalatorPct: Number.isFinite(escPct) ? escPct : 0, termMonths: termNum, monthsElapsed: elapsed })
    : null
  const finance = input.finance.map(cell => {
    if (cell.cell.kind === 'value') return cell
    if (input.isPpa && cell.label === 'Interest rate') {
      return fill(cell, 'No APR', 'This is a PPA/lease. The yearly increase is Annual Escalator Rate %, not interest.')
    }
    if (input.isPpa && cell.label === 'Total / amount financed' && ppaSched) {
      return fill(cell, money(ppaSched.total), 'Sum of scheduled PPA payments; not a loan principal', ppaSched.total)
    }
    if (input.isPpa && cell.label === 'Remaining balance' && ppaSched) {
      return fill(cell, money(ppaSched.remaining), 'Remaining scheduled PPA payments with the yearly increase', ppaSched.remaining)
    }
    if (input.isPpa && cell.label === 'Interest paid to date') {
      return fill(cell, '$0.00', 'PPA/lease has no loan interest', 0)
    }
    if (cell.label === 'First payment date') {
      return fill(cell, 'Not started', 'No signing date or completion certificate on file.')
    }
    if (cell.label === 'Remaining balance' && Number.isFinite(amount) && amount > 0 && elapsed === 0) {
      return fill(cell, money(amount), 'Payments not started · original amount financed', amount)
    }
    if (cell.label === 'Interest paid to date' && elapsed === 0) {
      return fill(cell, '$0.00', 'Payments not started', 0)
    }
    if (cell.label === 'Months remaining' && Number.isFinite(termNum) && termNum > 0) {
      const left = Math.max(0, Math.round(termNum) - elapsed)
      return fill(cell, String(left), elapsed ? 'Term months minus payments due since first payment' : 'Full term until first payment starts')
    }
    if (cell.label === 'Years remaining' && Number.isFinite(termNum) && termNum > 0) {
      const left = Math.max(0, Math.round(termNum) - elapsed)
      return fill(cell, (left / 12).toFixed(left % 12 === 0 ? 0 : 1), 'From first payment date and term')
    }
    if (cell.label === 'Annual Escalator Rate %' && !input.isPpa) return fill(cell, '0%', 'Loan has no yearly payment increase')
    if (cell.label === '30% Dealer Fee') return cell
    return fill(cell, 'Not in paperwork', 'Confirm or enter this on SCS Review')
  })
  const amountAfter = finance.find(c => c.label === 'Total / amount financed')
  const amountN = amountAfter?.cell.kind === 'value'
    ? (amountAfter.cell.amount ?? Number(String(amountAfter.cell.display).replace(/[^\d.-]/g, '')))
    : NaN
  const dealer = dealerFeeFromAmount(Number.isFinite(amountN) ? amountN : null)
  const financeWithFee = finance.map(cell => {
    if (cell.label !== '30% Dealer Fee') return cell
    if (dealer.kind === 'value') {
      return { label: '30% Dealer Fee', cell: dealer, hint: 'Computed 30% of amount · unverified · staff CYS-verify required', unverified: true }
    }
    return { label: '30% Dealer Fee', cell: { kind: 'missing' as const }, hint: 'Needs total / amount financed' }
  })
  const solar = input.solar.map(cell => {
    if (cell.cell.kind === 'value') return cell
    if (cell.label === 'System size') return fill(cell, 'Not in paperwork', 'Needs a proposal/kW or a value typed on Review')
    if (cell.label === 'Credit score') return fill(cell, 'Not collected', 'Intake form only · never from the PDF')
    return fill(cell, 'Not in paperwork', 'Confirm or enter this on SCS Review')
  })
  return { finance: financeWithFee, solar }
}

const text = (v: unknown): string => typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''
/** Only equivalent answers are mapped. No sales conduct, credit pull or ownership inference. */
export function prefillQuestionnaire(input: {
  name: string; address: string; phone: string; email: string; intake: Record<string, unknown>
}): QuestionnaireAnswers {
  const a = emptyAnswers(), s = input.intake
  Object.assign(a, { legal_name: input.name, prop_addr: input.address, phone: input.phone, email: input.email })
  const aliases: Record<string, string[]> = {
    sales_co: ['sales_co', 'sales_company'], install_co: ['install_co', 'installer_guess'],
    lender: ['lender', 'lender_guess'], mo_pay: ['mo_pay', 'monthly_payment_guess', 'monthly_guess'],
    term_yrs: ['term_yrs', 'term_years'], year_signed: ['year_signed'], on_contract: ['on_contract'],
  }
  for (const q of QUESTIONS) {
    const raw = s[q.id] ?? (aliases[q.id] ?? []).map(k => s[k]).find(v => text(v))
    if (q.ty === 'text' || q.ty === 'long') { if (text(raw)) a[q.id] = text(raw) }
    else if (q.ty === 'one' && q.o?.includes(text(raw))) a[q.id] = text(raw)
    else if (q.ty === 'multi' && Array.isArray(raw) && raw.length && raw.every(v => typeof v === 'string' && q.o?.includes(v))) a[q.id] = raw
  }
  const typeMap: Record<string, string> = { loan: 'Loan', lease: 'Lease', ppa: 'PPA (Power Purchase Agreement)', cash: 'Cash purchase' }
  const product = typeMap[text(s.product_confirmed ?? s.product_type_guess).toLowerCase()]
  const agreement = QUESTIONS.find(q => q.id === 'agree_type')!
  if (product && agreement.o?.includes(product) && !(a.agree_type as string[]).length) a.agree_type = [product]
  return a
}

export function mergeQuestionnaire(prefill: QuestionnaireAnswers, stored: Record<string, unknown>): QuestionnaireAnswers {
  const a = { ...prefill }, manual = (stored._manual ?? {}) as Record<string, unknown>
  for (const q of QUESTIONS) if (manual[q.id] && (typeof stored[q.id] === 'string' || Array.isArray(stored[q.id]))) a[q.id] = stored[q.id] as string | string[]
  return a
}

/** Document suggestions are explicitly qualified and never imply customer testimony. */
export function prefillFromDocuments(answers: QuestionnaireAnswers, docs: import('@/lib/desk-extract').ExtractableDoc[]): QuestionnaireAnswers {
  const out = { ...answers }
  const fact = (key: string) => extractedFact(docs, 'solar_contract', key) ?? extractedFact(docs, 'finance_agreement', key)
  const put = (key: string, value?: string) => { if (value && !out[key]?.length) out[key] = value }
  const product = fact('product_type')?.value.toLowerCase()
  const products: Record<string, string> = { loan:'Loan', lease:'Lease', ppa:'PPA (Power Purchase Agreement)', cash:'Cash purchase' }
  if (product && products[product] && !out.agree_type?.length) out.agree_type = [products[product]]
  put('on_contract', fact('full_name')?.value)
  put('sales_co', fact('sales_company')?.value)
  put('install_co', fact('installer_name')?.value)
  // A PPA counterparty is not a loan lender.
  if (!['ppa','lease'].includes(product ?? '')) put('lender', extractedFact(docs, 'finance_agreement', 'lender_name')?.value)
  const signed = fact('customer_signed_date')?.value
  if (signed && /^\d{4}-\d{2}-\d{2}$/.test(signed)) put('year_signed', signed.slice(0,4))
  const years = fact('term_years')?.value, months = fact('term_months')?.value
  put('term_yrs', years ? `${years} years` : months && /^\d+$/.test(months) ? `${Number(months) / 12} years (${months} months)` : undefined)
  const monthly = fact('monthly_payment')?.value
  const firstYear = fact('first_year_monthly_payment')?.value
  put('mo_pay', monthly ? `${monthly} (contract-stated; current bill requires confirmation)` : firstYear ? `${firstYear} (first-year contract payment; not current bill)` : undefined)
  const escalation = fact('escalator_pct')?.value
  if (escalation && /^\d+(\.\d+)?%?$/.test(escalation.trim())) put('escalator', Number(escalation.replace('%','')) > 0 ? 'Yes' : 'No')
  return out
}


/** An explicit Unknown/N/A is not permission to refill the answer from an old guess. */
export function applyQuestionnaireDispositions(answers:QuestionnaireAnswers, dispositions:Record<string,unknown>):QuestionnaireAnswers {
  const result={...answers}
  for(const q of QUESTIONS) if(['unknown','not_applicable'].includes(String(dispositions[q.id]))) result[q.id]=q.ty==='multi'?[]:''
  return result
}
