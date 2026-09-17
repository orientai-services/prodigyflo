/**
 * The 12 case-file document kinds. Empty tile if the org has no matching
 * requirement row — no new table.
 */

export type DeskDocKind = {
  key: string
  label: string
  aliases: string[]
}

export const CASE_DOC_KINDS: DeskDocKind[] = [
  { key: 'finance_agreement', label: 'Finance agreement', aliases: ['finance_agreement', 'loan_or_til', 'til', 'loan_agreement'] },
  { key: 'signed_contract', label: 'Signed contract', aliases: ['signed_contract', 'solar_contract', 'contract', 'agreement', 'ppa', 'lease_agreement'] },
  { key: 'utility_bill', label: 'Utility bill', aliases: ['utility_bill', 'utility-bill', 'power_bill'] },
  { key: 'gov_id', label: 'Government ID', aliases: ['gov_id', 'photo_id', 'government_id', 'drivers_license', 'id'] },
  { key: 'proof_of_income', label: 'Proof of income', aliases: ['proof_of_income', 'proof_income'] },
  { key: 'attorney_retainer', label: 'Attorney retainer', aliases: ['attorney_retainer'] },
  { key: 'lpoa', label: 'LPOA', aliases: ['lpoa', 'attorney_poa'] },
  { key: 'comm_evidence', label: 'Comm evidence', aliases: ['comm_evidence'] },
  { key: 'ucc_lien', label: 'UCC Fixture / Lien', aliases: ['ucc_lien', 'lien_filing', 'lien'] },
  { key: 'home_deed', label: 'Homeownership Deed', aliases: ['home_deed', 'ownership', 'deed', 'property_record'] },
  { key: 'county_permit', label: 'County Permit Record', aliases: ['county_permit', 'permit', 'permits'] },
  { key: 'production_report', label: 'Solar Production Report', aliases: ['production_report', 'production'] },
]

export type DeskDocState = 'missing' | 'uploaded' | 'extracted' | 'unverified' | 'verified' | 'failed'

const FINANCE_NAME =
  /goodleap|\bmosaic\b|\bsunlight\b|truth\s*-?\s*in\s*-?\s*lending|\btil\b|credit\s+agreement|promissory\s+note|loan\s+agreement/i

const INSTALL_NAME =
  /solar\s+agreement|\binstall(?:ation)?\b|\bppa\b|power\s+purchase|\blease\b|\bsteele\b/i

export function matchDocKind(raw: string | null | undefined): DeskDocKind | null {
  const key = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!key) return null
  return CASE_DOC_KINDS.find((k) => k.key === key || k.aliases.includes(key)) ?? null
}

/**
 * Put every inbound file on a known tile.
 * Lender names → finance. Install / Steele / unknown parent → signed contract.
 * Never leave an extra leftover card.
 */
export function classifyDeskKind(input: {
  requirementKey?: string | null
  detectedType?: string | null
  label?: string | null
  fileName?: string | null
}): DeskDocKind | null {
  const direct =
    matchDocKind(input.requirementKey) ||
    matchDocKind(input.detectedType) ||
    matchDocKind(input.label) ||
    matchDocKind(input.fileName)
  if (direct) return direct

  const hay = [input.fileName, input.label, input.detectedType, input.requirementKey]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join('\n')
  if (!hay) return null
  if (FINANCE_NAME.test(hay)) return CASE_DOC_KINDS.find((k) => k.key === 'finance_agreement') ?? null
  if (INSTALL_NAME.test(hay)) return CASE_DOC_KINDS.find((k) => k.key === 'signed_contract') ?? null
  return CASE_DOC_KINDS.find((k) => k.key === 'signed_contract') ?? null
}

export function tileState(input: {
  hasFile: boolean
  extractionStatus: string | null
  fieldCount: number
  verifiedCount: number
}): DeskDocState {
  if (!input.hasFile) return 'missing'
  if (input.extractionStatus === 'FAILED') return 'failed'
  if (input.extractionStatus === 'COMPLETED' && input.fieldCount > 0) {
    if (input.verifiedCount > 0 && input.verifiedCount >= input.fieldCount) return 'verified'
    if (input.verifiedCount > 0) return 'extracted'
    return 'unverified'
  }
  if (input.extractionStatus === 'COMPLETED') return 'extracted'
  return 'uploaded'
}
