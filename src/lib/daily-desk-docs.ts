/**
 * Case-file document kinds shown on the desk. Empty tile if the org has no
 * matching requirement row — no new table.
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
  { key: 'comm_evidence', label: 'Comm evidence', aliases: ['comm_evidence'] },
  { key: 'ucc_lien', label: 'UCC Fixture / Lien', aliases: ['ucc_lien', 'lien_filing', 'lien', 'fixture'] },
  { key: 'home_deed', label: 'Homeownership Deed', aliases: ['home_deed', 'ownership', 'deed', 'property_record', 'homeownership', 'parcel'] },
  { key: 'county_permit', label: 'County Permit Record', aliases: ['county_permit', 'permit', 'permits'] },
  { key: 'production_report', label: 'Solar Production Report', aliases: ['production_report', 'production'] },
]

/** Kept off the case-file grid. Still stored on the client. */
const HIDDEN_DESK_ALIASES = new Set([
  'gov_id',
  'photo_id',
  'government_id',
  'drivers_license',
  'id',
  'proof_of_income',
  'proof_income',
  'attorney_retainer',
  'lpoa',
  'attorney_poa',
])

export type DeskDocState = 'missing' | 'uploaded' | 'extracted' | 'unverified' | 'verified' | 'failed'

const FINANCE_NAME =
  /goodleap|\bmosaic\b|\bsunlight\b|truth\s*-?\s*in\s*-?\s*lending|\btil\b|credit\s+agreement|promissory\s+note|loan\s+agreement/i

const INSTALL_NAME =
  /solar\s+agreement|\binstall(?:ation)?\b|\bppa\b|power\s+purchase|\blease\b|\bsteele\b/i

const DEED_NAME = /homeownership|\bdeed\b|ownership|\bparcel\b/i
const UCC_NAME = /\bucc\b|fixture|\blien\b/i
const PERMIT_NAME = /\bpermit/i

function normalizeKey(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function stem(key: string): string {
  return key.replace(/\.[a-z0-9]+$/, '')
}

export function matchDocKind(raw: string | null | undefined): DeskDocKind | null {
  const key = normalizeKey(raw)
  if (!key) return null
  const base = stem(key)
  const exact = CASE_DOC_KINDS.find((k) => k.key === key || k.key === base || k.aliases.includes(key) || k.aliases.includes(base))
  if (exact) return exact
  return CASE_DOC_KINDS.find((k) => {
    const tokens = [k.key, ...k.aliases].filter((t) => t.length >= 4)
    return tokens.some((t) => base.includes(t))
  }) ?? null
}

function isHiddenDeskKind(input: {
  requirementKey?: string | null
  detectedType?: string | null
  label?: string | null
  fileName?: string | null
}): boolean {
  return [input.requirementKey, input.detectedType, input.label, input.fileName]
    .map(normalizeKey)
    .map(stem)
    .some((key) => key && HIDDEN_DESK_ALIASES.has(key))
}

/**
 * Put inbound files on a known visible tile.
 * Lender names → finance. Install / Steele → signed contract.
 * Deed / UCC / permit names beat the leftover-contract fallback.
 * Hidden kinds stay off the grid instead of stealing the contract slot.
 */
export function classifyDeskKind(input: {
  requirementKey?: string | null
  detectedType?: string | null
  label?: string | null
  fileName?: string | null
}): DeskDocKind | null {
  if (isHiddenDeskKind(input)) return null

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
  if (DEED_NAME.test(hay)) return CASE_DOC_KINDS.find((k) => k.key === 'home_deed') ?? null
  if (UCC_NAME.test(hay)) return CASE_DOC_KINDS.find((k) => k.key === 'ucc_lien') ?? null
  if (PERMIT_NAME.test(hay)) return CASE_DOC_KINDS.find((k) => k.key === 'county_permit') ?? null
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
