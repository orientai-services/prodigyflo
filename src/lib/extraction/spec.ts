/**
 * Per-document-type field specifications and the pure decision rules built on
 * them: which fields are required, when a document is missing information,
 * when an extracted value conflicts with the client record, and — critically —
 * when a document may be approved. All pure; unit-tested without a database.
 */

export type FieldKind = 'text' | 'date' | 'money' | 'number' | 'percent'

export type DocFieldSpec = {
  key: string
  label: string
  required: boolean
  kind: FieldKind
}

export type DocTypeSpec = {
  key: string
  label: string
  /** DocumentRequirement.key values that map straight to this type. */
  requirementKeys: string[]
  /** Case-insensitive phrases that identify this type in extracted text. */
  keywords: string[]
  fields: DocFieldSpec[]
}

/** Below this confidence an extracted value does not count as present. */
export const CONFIDENCE_FLOOR = 60

/** At or above this confidence a field qualifies for bulk verification. */
export const BULK_VERIFY_THRESHOLD = 90

export const DOC_TYPE_SPECS: DocTypeSpec[] = [
  {
    key: 'utility_bill',
    label: 'Utility bill',
    requirementKeys: ['utility_bill', 'utility-bill', 'power_bill'],
    keywords: ['utility bill', 'amount due', 'billing period', 'kwh', 'service address', 'meter', 'electric service'],
    fields: [
      { key: 'utility_name', label: 'Utility name', required: true, kind: 'text' },
      { key: 'account_number', label: 'Account number', required: true, kind: 'text' },
      { key: 'service_address', label: 'Service address', required: true, kind: 'text' },
      { key: 'billing_period', label: 'Billing period', required: false, kind: 'text' },
      { key: 'amount_due', label: 'Amount due', required: true, kind: 'money' },
    ],
  },
  {
    key: 'government_id',
    label: 'Government ID',
    requirementKeys: ['government_id', 'photo_id', 'drivers_license', 'id'],
    keywords: ["driver's license", 'driver license', 'identification card', 'date of birth', 'passport', 'dmv'],
    fields: [
      { key: 'full_name', label: 'Full name', required: true, kind: 'text' },
      { key: 'date_of_birth', label: 'Date of birth', required: true, kind: 'date' },
      { key: 'id_number', label: 'ID number', required: true, kind: 'text' },
      { key: 'expiration_date', label: 'Expiration date', required: true, kind: 'date' },
    ],
  },
  {
    key: 'solar_contract',
    label: 'Solar contract',
    requirementKeys: ['solar_contract', 'contract', 'ppa', 'lease_agreement'],
    keywords: ['solar', 'photovoltaic', 'power purchase agreement', 'installer', 'system size', 'escalator', 'lease agreement'],
    fields: [
      { key: 'installer_name', label: 'Installer', required: true, kind: 'text' },
      { key: 'contract_date', label: 'Contract date', required: true, kind: 'date' },
      { key: 'system_size_kw', label: 'System size (kW)', required: false, kind: 'number' },
      { key: 'monthly_payment', label: 'Monthly payment', required: true, kind: 'money' },
      { key: 'term_months', label: 'Term (months)', required: true, kind: 'number' },
      { key: 'escalator_pct', label: 'Annual escalator (%)', required: false, kind: 'percent' },
    ],
  },
  {
    key: 'finance_agreement',
    label: 'Financing agreement',
    requirementKeys: ['finance_agreement', 'loan_or_til', 'til', 'loan_agreement'],
    keywords: ['truth in lending', 'amount financed', 'apr', 'dealer fee', 'promissory', 'loan agreement'],
    fields: [
      { key: 'lender_name', label: 'Lender', required: true, kind: 'text' },
      { key: 'account_number', label: 'Account / loan #', required: false, kind: 'text' },
      { key: 'amount_financed', label: 'Amount financed', required: true, kind: 'money' },
      { key: 'dealer_fee', label: 'Dealer fee', required: false, kind: 'money' },
      { key: 'apr', label: 'APR', required: false, kind: 'percent' },
      { key: 'term_months', label: 'Term (months)', required: true, kind: 'number' },
      { key: 'monthly_payment', label: 'Monthly payment', required: true, kind: 'money' },
      { key: 'first_payment_date', label: 'First payment date', required: false, kind: 'date' },
    ],
  },
  {
    key: 'proposal',
    label: 'Proposal / savings estimate',
    requirementKeys: ['proposal', 'savings_estimate'],
    keywords: ['proposal', 'savings estimate', 'estimated savings', 'production estimate'],
    fields: [
      { key: 'promised_monthly', label: 'Promised monthly', required: false, kind: 'money' },
      { key: 'promised_savings', label: 'Promised savings', required: false, kind: 'money' },
      { key: 'quoted_utility', label: 'Quoted utility bill', required: false, kind: 'money' },
    ],
  },
  {
    key: 'lender_statement',
    label: 'Lender statement',
    requirementKeys: ['lender_statement', 'loan_statement'],
    keywords: ['account statement', 'loan statement', 'current balance', 'amount due'],
    fields: [
      { key: 'lender_name', label: 'Lender', required: false, kind: 'text' },
      { key: 'account_number', label: 'Account #', required: false, kind: 'text' },
      { key: 'monthly_payment', label: 'Monthly payment', required: true, kind: 'money' },
      { key: 'current_payoff', label: 'Current payoff', required: false, kind: 'money' },
    ],
  },
  {
    key: 'payoff_letter',
    label: 'Payoff quote',
    requirementKeys: ['payoff', 'payoff_letter'],
    keywords: ['payoff', 'good through', 'payoff amount'],
    fields: [
      { key: 'payoff_amount', label: 'Payoff amount', required: true, kind: 'money' },
      { key: 'good_through', label: 'Good-through date', required: false, kind: 'date' },
      { key: 'account_number', label: 'Account #', required: false, kind: 'text' },
    ],
  },
]

/** Fallback when nothing matches — no fields, so nothing can be "missing". */
export const GENERIC_TYPE: DocTypeSpec = {
  key: 'other',
  label: 'Other document',
  requirementKeys: [],
  keywords: [],
  fields: [],
}

export function specForType(key: string | null | undefined): DocTypeSpec {
  return DOC_TYPE_SPECS.find((s) => s.key === key) ?? GENERIC_TYPE
}

export type TypeDetection = { spec: DocTypeSpec; confidence: number; signals: string[] }

/**
 * Decide what kind of document this is. The requirement it was uploaded
 * against is the strongest signal; text keywords confirm or, on their own,
 * suggest; the filename is a weak hint.
 */
export function detectDocumentType(input: {
  text: string
  fileName?: string | null
  requirementKey?: string | null
}): TypeDetection {
  const text = input.text.toLowerCase()
  const fileName = (input.fileName ?? '').toLowerCase()
  const reqKey = (input.requirementKey ?? '').toLowerCase()

  let best: TypeDetection = { spec: GENERIC_TYPE, confidence: 0, signals: [] }
  for (const spec of DOC_TYPE_SPECS) {
    let score = 0
    const signals: string[] = []
    if (reqKey && spec.requirementKeys.includes(reqKey)) {
      score += 55
      signals.push(`requested as "${reqKey}"`)
    }
    const hits = spec.keywords.filter((k) => text.includes(k))
    if (hits.length) {
      score += Math.min(40, hits.length * 12)
      signals.push(`matched "${hits.slice(0, 3).join('", "')}"`)
    }
    if (fileName && spec.requirementKeys.some((k) => fileName.includes(k.replace(/_/g, '')) || fileName.includes(k))) {
      score += 10
      signals.push('filename hint')
    }
    if (score > best.confidence) best = { spec, confidence: Math.min(100, score), signals }
  }
  return best.confidence >= 30 ? best : { spec: GENERIC_TYPE, confidence: best.confidence, signals: [] }
}

// ── Missing / conflicting ────────────────────────────────────────

export type FieldLike = {
  key: string
  value: string | null
  confidence: number
}

/**
 * Required fields that came back empty or below the confidence floor.
 * A low-confidence guess is treated exactly like an absent value — it must
 * never quietly count as data.
 */
export function computeMissingFieldKeys(spec: DocTypeSpec, fields: FieldLike[]): string[] {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  return spec.fields
    .filter((f) => f.required)
    .filter((f) => {
      const got = byKey.get(f.key)
      return !got || !got.value?.trim() || got.confidence < CONFIDENCE_FLOOR
    })
    .map((f) => f.key)
}

export function documentStatusAfterExtraction(missingFieldKeys: string[]): 'MISSING_INFORMATION' | 'UNDER_REVIEW' {
  return missingFieldKeys.length > 0 ? 'MISSING_INFORMATION' : 'UNDER_REVIEW'
}

export type ClientSnapshot = {
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  /** "line1, city ST" of the primary address, when one exists. */
  address: string | null
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Flags extracted values that contradict what is already on the Client record.
 * A conflict never blocks extraction — it produces a note a reviewer must see.
 */
export function computeConflictNotes(
  fields: { key: string; value: string | null }[],
  client: ClientSnapshot,
): Record<string, string> {
  const notes: Record<string, string> = {}
  const clientName = norm(`${client.firstName} ${client.lastName}`)

  for (const f of fields) {
    const value = f.value?.trim()
    if (!value) continue

    if (f.key === 'full_name') {
      const got = norm(value)
      const tokens = clientName.split(' ').filter(Boolean)
      const overlap = tokens.filter((t) => got.includes(t)).length
      if (tokens.length && overlap < Math.min(2, tokens.length)) {
        notes[f.key] = `Document says "${value}" but the client record says "${client.firstName} ${client.lastName}".`
      }
    }

    if (f.key === 'service_address' && client.address) {
      const got = norm(value)
      const want = norm(client.address)
      const wantNumber = want.match(/^\d+/)?.[0]
      const wantStreet = want.split(' ')[1]
      const matches = (!wantNumber || got.includes(wantNumber)) && (!wantStreet || got.includes(wantStreet))
      if (!matches) {
        notes[f.key] = `Document says "${value}" but the client's address on file is "${client.address}".`
      }
    }
  }
  return notes
}

// ── Approval invariant ───────────────────────────────────────────

export type ReviewableField = {
  key: string
  label: string
  value: string | null
  correctedValue: string | null
  verification: 'UNVERIFIED' | 'VERIFIED' | 'CORRECTED' | 'REJECTED'
}

/** The value downstream code may read: the human correction wins, always. */
export function effectiveFieldValue(f: { value: string | null; correctedValue: string | null }): string | null {
  return f.correctedValue?.trim() ? f.correctedValue : f.value
}

export type ApprovalCheck = { ok: boolean; blocking: { key: string; label: string; reason: string }[] }

/**
 * A document can be approved only when every required field for its type has
 * been VERIFIED or CORRECTED by a human and carries a non-empty value. This is
 * the structural guarantee that no unreviewed AI output ever becomes approved
 * client data.
 */
export function canApproveDocument(spec: DocTypeSpec, fields: ReviewableField[]): ApprovalCheck {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const blocking: ApprovalCheck['blocking'] = []

  for (const req of spec.fields.filter((f) => f.required)) {
    const field = byKey.get(req.key)
    if (!field) {
      blocking.push({ key: req.key, label: req.label, reason: 'was not extracted' })
      continue
    }
    if (field.verification === 'UNVERIFIED') {
      blocking.push({ key: req.key, label: req.label, reason: 'has not been reviewed' })
    } else if (field.verification === 'REJECTED') {
      blocking.push({ key: req.key, label: req.label, reason: 'was rejected without a correction' })
    } else if (!effectiveFieldValue(field)?.trim()) {
      blocking.push({ key: req.key, label: req.label, reason: 'has no value' })
    }
  }
  return { ok: blocking.length === 0, blocking }
}
