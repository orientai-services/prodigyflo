import { str } from '@/lib/packet/schema'

export const TYPE_ALIASES: Record<string, string[]> = {
  finance_agreement: ['finance_agreement', 'loan_or_til', 'loan_agreement', 'til', 'ric'],
  solar_contract: [
    'solar_contract',
    'signed_contract',
    'agreement',
    'ppa',
    'lease',
    'solar_agreement',
    'power_purchase_agreement',
  ],
  lender_statement: ['lender_statement', 'loan_statement', 'statement'],
  completion_cert: ['completion_cert', 'completion_certificate'],
  proposal: ['proposal', 'savings_estimate'],
}

export const FIELD_ALIASES: Record<string, string[]> = {
  full_name: ['full_name', 'customer_name', 'borrower_name'],
  product_type: ['product_type', 'agreement_type'],
  amount_financed: ['amount_financed', 'total_financed'],
  monthly_payment: ['monthly_payment', 'monthly_solar_payment'],
  term_months: ['term_months', 'payment_term_months'],
  apr: ['apr', 'interest_rate'],
  interest_rate: ['interest_rate', 'apr'],
  lender_name: ['lender_name', 'lender_servicer'],
  contract_counterparty: ['contract_counterparty', 'lender_servicer'],
  servicer_name: ['servicer_name', 'servicer'],
  installer_name: ['installer_name', 'installer'],
  system_size_kw: ['system_size_kw', 'system_size'],
  first_payment_date: ['first_payment_date', 'first_pay_date'],
  customer_signed_date: ['customer_signed_date', 'signed_date'],
  intro_payment_count: ['intro_payment_count'],
  first_year_monthly_payment: ['first_year_monthly_payment'],
  escalator_rate: ['escalator_rate', 'annual_escalator', 'escalator_pct'],
  escalator_pct: ['escalator_pct', 'escalator_rate', 'annual_escalator'],
  buyout_terms: ['buyout_terms', 'buyout'],
  remaining_balance: ['remaining_balance', 'remaining'],
  interest_paid_to_date: ['interest_paid_to_date', 'interest_paid'],
  months_remaining: ['months_remaining', 'payments_remaining'],
  years_remaining: ['years_remaining'],
}

export type ExtractableDoc = {
  extractions: {
    detectedTypeKey: string | null
    status?: string
    sourceActive?: boolean
    fields: { key: string; value: string | null; correctedValue: string | null; verification?: string; sourcePage?: number | null }[]
  }[]
}

export function keysForType(typeKey: string): string[] {
  return TYPE_ALIASES[typeKey] ?? [typeKey]
}

export function keysForField(fieldKey: string): string[] {
  return FIELD_ALIASES[fieldKey] ?? [fieldKey]
}

/** Read a quoted extract field. Accepts SCS type/field names as aliases. */
export function extracted(
  docs: ExtractableDoc[],
  typeKey: string,
  fieldKey: string,
): string {
  return extractedFact(docs, typeKey, fieldKey)?.value ?? ''
}

export type ExtractedFact = { value: string; verified: boolean; note: string }

/** Extractions are newest first. A newer blank clears an old suggestion, while
 * reviewed readings remain available across reruns for correction protection. */
export function currentExtractionFields<E extends {
  detectedTypeKey: string | null
  status?: string
  sourceActive?: boolean
  fields: { key: string; verification?: string; value?: string | null; correctedValue?: string | null }[]
}>(extractions: E[]): { extraction: E; field: E['fields'][number] }[] {
  const rows: { extraction: E; field: E['fields'][number] }[] = []
  const selected = new Map<string, { reviewed: boolean; extraction: E; index: number }>()
  for (const extraction of extractions) {
    if (extraction.status && extraction.status !== 'COMPLETED') continue
    for (const field of extraction.fields) {
      const type = Object.entries(TYPE_ALIASES).find(([, aliases]) => aliases.includes(extraction.detectedTypeKey ?? ''))?.[0] ?? extraction.detectedTypeKey
      const key = Object.entries(FIELD_ALIASES).find(([, aliases]) => aliases.includes(field.key))?.[0] ?? field.key
      const identity = `${type}:${key}`
      const reviewed = ['VERIFIED', 'CORRECTED', 'REJECTED'].includes(field.verification ?? '')
      if(extraction.sourceActive===false&&!reviewed) continue
      const prior = selected.get(identity)
      if (!prior) {
        selected.set(identity, {reviewed, extraction, index:rows.length})
        rows.push({extraction, field})
      } else if (reviewed && !prior.reviewed) {
        // A rejection and an intentional blank are decisions, too. They must
        // suppress every later automatic reading, not only a nonempty value.
        rows[prior.index] = {extraction, field}
        selected.set(identity, {reviewed, extraction, index:prior.index})
      } else if (reviewed && prior.reviewed && prior.extraction === extraction) {
        rows.push({extraction, field}) // malformed/conflicting same-run reviews remain visible
      } else if (!reviewed && !prior.reviewed && prior.extraction === extraction) {
        const priorVal = str(rows[prior.index].field.correctedValue ?? rows[prior.index].field.value)
        const nextVal = str(field.correctedValue ?? field.value)
        if (!priorVal && nextVal) {
          rows[prior.index] = {extraction, field}
          selected.set(identity, {reviewed, extraction, index:prior.index})
        }
      }
    }
  }
  return rows
}

/** Rejected readings never populate a profile; reviewed values survive later re-extraction. */
export function extractedFact(docs: ExtractableDoc[], typeKey: string, fieldKey: string): ExtractedFact | null {
  const types = new Set(keysForType(typeKey))
  const keys = keysForField(fieldKey)
  const candidates = docs.flatMap(doc => currentExtractionFields(doc.extractions)
    .filter(({ extraction, field }) => types.has(str(extraction.detectedTypeKey)) && keys.includes(field.key))
    .map(({ field }) => field))

  const reviewed = candidates.filter(field => ['VERIFIED', 'CORRECTED','REJECTED'].includes(field.verification ?? ''))
  const field = reviewed[0] ?? candidates[0]
  if (!field) return null
  const value = str(field.correctedValue ?? field.value)
  if(field.verification==='REJECTED') return {value:'',verified:true,note:'Staff rejected this value; follow-up required.'}
  if (!value) return reviewed.length?{value:'',verified:true,note:'Staff explicitly left this value unknown.'}:null
  if (reviewed.some(other => str(other.correctedValue ?? other.value).toLowerCase() !== value.toLowerCase())) {
    return { value, verified: false, note: 'Conflicting reviewed readings; resolve in CYS.' }
  }
  return { value, verified: reviewed.length > 0, note: `${reviewed.length ? 'Reviewed document' : 'Unverified extraction'}${field.sourcePage ? ` · p. ${field.sourcePage}` : ''}` }
}

export function normalizeProduct(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (/\bppa\b|power purchase agreement/.test(value)) return 'ppa'
  if (/\blease\b/.test(value)) return 'lease'
  if (/\bloan\b/.test(value)) return 'loan'
  if (/\bcash\b/.test(value)) return 'cash'
  return value
}

/** A stated year count may be converted; an unknown start date cannot be inferred. */
export function termMonthsFromYears(raw: string): string {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(?:years?|yrs?)?$/i)
  const years = match ? Number(match[1]) : NaN
  return Number.isFinite(years) && years > 0 ? String(years * 12) : ''
}

const CONTRACT_TYPES = new Set([
  ...TYPE_ALIASES.finance_agreement,
  ...TYPE_ALIASES.solar_contract,
])

/**
 * PPA-safe fields from any contract-shaped file.
 * Does not read amount_financed / APR / dealer / remaining — those stay on extracted(docs, 'finance_agreement', …).
 */
export function extractedFromAnyContract(
  docs: ExtractableDoc[],
  fieldKey: string,
): string {
  const contracts = docs.map(doc => ({ extractions: doc.extractions.filter(ex => CONTRACT_TYPES.has(str(ex.detectedTypeKey))) }))
  const facts = ['finance_agreement', 'solar_contract'].map(type => extractedFact(contracts, type, fieldKey)).filter((fact): fact is ExtractedFact => fact !== null)
  return (facts.find(fact => fact.verified) ?? facts[0])?.value ?? ''
}
