import { str } from '@/lib/packet/schema'

const TYPE_ALIASES: Record<string, string[]> = {
  finance_agreement: ['finance_agreement', 'loan_or_til', 'loan_agreement', 'til'],
  solar_contract: [
    'solar_contract',
    'signed_contract',
    'agreement',
    'ppa',
    'lease',
    'solar_agreement',
    'power_purchase_agreement',
  ],
}

const FIELD_ALIASES: Record<string, string[]> = {
  amount_financed: ['amount_financed', 'total_financed'],
  monthly_payment: ['monthly_payment', 'monthly_solar_payment'],
  term_months: ['term_months', 'payment_term_months'],
  apr: ['apr', 'interest_rate'],
  interest_rate: ['interest_rate', 'apr'],
  lender_name: ['lender_name', 'lender_servicer'],
  installer_name: ['installer_name', 'installer'],
  system_size_kw: ['system_size_kw', 'system_size'],
  first_payment_date: ['first_payment_date', 'first_pay_date'],
  escalator_rate: ['escalator_rate', 'annual_escalator'],
  buyout_terms: ['buyout_terms', 'buyout'],
  remaining_balance: ['remaining_balance', 'remaining'],
}

export type ExtractableDoc = {
  extractions: {
    detectedTypeKey: string | null
    fields: { key: string; value: string | null; correctedValue: string | null }[]
  }[]
}

function keysForType(typeKey: string): string[] {
  return TYPE_ALIASES[typeKey] ?? [typeKey]
}

function keysForField(fieldKey: string): string[] {
  return FIELD_ALIASES[fieldKey] ?? [fieldKey]
}

/** Read a quoted extract field. Accepts SCS type/field names as aliases. */
export function extracted(
  docs: ExtractableDoc[],
  typeKey: string,
  fieldKey: string,
): string {
  const types = new Set(keysForType(typeKey))
  const fields = keysForField(fieldKey)
  for (const d of docs) {
    for (const ex of d.extractions) {
      if (!types.has(str(ex.detectedTypeKey))) continue
      for (const key of fields) {
        const f = ex.fields.find((x) => x.key === key)
        const v = str(f?.correctedValue) || str(f?.value)
        if (v) return v
      }
    }
  }
  return ''
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
  const fields = keysForField(fieldKey)
  for (const d of docs) {
    for (const ex of d.extractions) {
      if (!CONTRACT_TYPES.has(str(ex.detectedTypeKey))) continue
      for (const key of fields) {
        const f = ex.fields.find((x) => x.key === key)
        const v = str(f?.correctedValue) || str(f?.value)
        if (v) return v
      }
    }
  }
  return ''
}
