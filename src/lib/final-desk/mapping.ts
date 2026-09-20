import { extractedFact } from '@/lib/desk-extract'
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
  const isPpa = type.kind === 'value' && /ppa|lease/i.test(type.display)
  const amt = find('Total / amount financed')
  const amount = amt.cell.kind === 'value' ? Number(amt.cell.display.replace(/[^\d.-]/g, '')) : NaN
  const benchmark: CaseCell = {
    label: '30% Dealer Fee',
    cell: !isPpa && Number.isFinite(amount) && amount > 0
      ? { kind: 'value', display: (Math.round(amount * 30) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) }
      : { kind: 'cannot_compute', missing: ['supported amount financed'] },
    hint: 'Internal 30% benchmark · not the documented dealer fee',
    unverified: amt.unverified,
  }
  const payment = find('Monthly payment', 'Contract-stated monthly payment')
  // Historical starting price is useful only with its explicit period qualifier.
  const shownPayment = payment.cell.kind === 'missing'
    ? find('Monthly payment', 'First-year monthly payment') : payment
  const finance = [amt, find('Remaining balance', 'Estimated remaining balance'), find('Interest rate'),
    find('Interest paid to date', 'Estimated interest paid'), find('Annual Escalator Rate %', 'Annual payment escalation'),
    find('Term years'), find('Term months'), find('Years remaining'), find('Months remaining'), shownPayment, benchmark,
    isPpa ? missing('Lender', 'PPA/lease counterparty is recorded in the contract evidence; no loan lender inferred') : find('Lender'),
    isPpa ? missing('First payment date', 'No first payment date inferred from signing or service commencement') : find('First payment date')]
  if (isPpa) for (const index of [0, 1, 2, 3]) finance[index] = missing(finance[index].label, 'Not applicable to a PPA/lease loan calculation')
  const credit = find('Credit score')
  // A range is not a numeric credit score. Preserve the range in intake evidence.
  if (credit.cell.kind === 'value' && !/^\d{3}$/.test(credit.cell.display)) credit.cell = { kind: 'missing' }
  return { finance, solar: [find('Agreement type'), find('Installer', 'Actual installer'), credit, find('System size')] }
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
  put('on_contract', fact('customer_name')?.value ?? fact('borrower_name')?.value)
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
