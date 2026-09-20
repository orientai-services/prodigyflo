import type { CysSourceType, CysValueStatus, FieldVerification } from '@prisma/client'
import { keysForField, keysForType, normalizeProduct, termMonthsFromYears } from '@/lib/desk-extract'

/**
 * Pure CYS field resolution. No DB access here — callers assemble a
 * SourceRecord and get back ResolvedValues, which keeps every precedence rule
 * unit-testable with plain fixtures.
 */

export type CysDefinitionInput = {
  key: string
  label: string
  groupName: string
  position: number
  isRequired: boolean
  dataType: string
  sourceType: CysSourceType
  sourcePath: string | null
}

export type DocumentFieldInput = {
  key: string
  /** detectedTypeKey of the extraction the field came from, e.g. "solar_contract". */
  documentTypeKey: string | null
  value: string | null
  correctedValue: string | null
  verification: FieldVerification
  confidence: number
  documentId: string
  extractedFieldId: string
  documentLabel: string
  sourcePage: number | null
}

export const CYS_DOCUMENT_KINDS: Record<string, string> = {
  doc_contract: 'signed_contract', doc_finance: 'finance_agreement', doc_proposal: 'proposal',
  doc_statement: 'lender_statement', doc_payoff: 'payoff_letter', doc_utility_bill: 'utility_bill', doc_photo_id: 'gov_id',
}

export type SourceRecord = {
  documents?: { id: string; kind: string; label: string; approved: boolean }[]
  client: Record<string, string | null | undefined>
  address: Record<string, string | null | undefined> | null
  survey: Record<string, string | null | undefined>
  surveyProvenance?: Record<string, { source?: string }>
  documentFields: DocumentFieldInput[]
}

export type ResolvedValue = {
  fieldKey: string
  value: string | null
  status: CysValueStatus
  confidence: number | null
  sourceLabel: string | null
  sourceDocumentId: string | null
  sourceExtractedFieldId: string | null
  sourcePage: number | null
  conflictValue: string | null
  note: string | null
}

const missing = (fieldKey: string, sourceLabel: string | null = null): ResolvedValue => ({
  fieldKey,
  value: null,
  status: 'MISSING',
  confidence: null,
  sourceLabel,
  sourceDocumentId: null,
  sourceExtractedFieldId: null,
  sourcePage: null,
  conflictValue: null,
  note: null,
})

export function normalizeForCompare(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function isBlank(value: string | null | undefined): value is null | undefined {
  return value === null || value === undefined || value.trim() === ''
}

/** Strips an expected prefix ("client.", "address.", ...) if present. */
function pathTail(path: string, prefix: string): string {
  return path.startsWith(`${prefix}.`) ? path.slice(prefix.length + 1) : path
}

/**
 * A CORRECTED or VERIFIED field speaks with the human's voice: the corrected
 * value, when present, is what the reviewer said the document really says.
 */
function effectiveValue(field: DocumentFieldInput): string | null {
  return isBlank(field.correctedValue) ? field.value : field.correctedValue
}

function docSource(field: DocumentFieldInput) {
  return {
    sourceLabel: field.sourcePage
      ? `${field.documentLabel} (p. ${field.sourcePage})`
      : field.documentLabel,
    sourceDocumentId: field.documentId,
    sourceExtractedFieldId: field.extractedFieldId,
    sourcePage: field.sourcePage,
  }
}

function resolveRecordField(
  def: CysDefinitionInput,
  record: Record<string, string | null | undefined> | null,
  prefix: string,
  sourceLabel: string,
): ResolvedValue {
  const path = pathTail(def.sourcePath ?? def.key, prefix)
  const value = record?.[path]
  if (isBlank(value)) return missing(def.key)
  return {
    ...missing(def.key),
    value: value.trim(),
    status: 'VERIFIED',
    sourceLabel,
  }
}

function resolveDocumentField(def: CysDefinitionInput, sources: SourceRecord): ResolvedValue {
  const path = pathTail(def.sourcePath ?? def.key, 'document')
  const dot = path.indexOf('.')
  const typeKey = dot === -1 ? null : path.slice(0, dot)
  const fieldKey = dot === -1 ? path : path.slice(dot + 1)

  // REJECTED fields are a human saying "this reading is wrong" — never a source.
  let candidates = sources.documentFields.filter(
    (f) =>
      keysForField(fieldKey).includes(f.key) &&
      f.verification !== 'REJECTED' &&
      (typeKey === null || keysForType(typeKey).includes(f.documentTypeKey ?? '')),
  )
  let derivation: string | null = null
  const at = (type: string, key: string) => sources.documentFields.filter(field => field.verification !== 'REJECTED' && keysForType(type).includes(field.documentTypeKey ?? '') && keysForField(key).includes(field.key))
  const productFields = sources.documentFields.filter(field => keysForField('product_type').includes(field.key) && field.verification !== 'REJECTED' && !isBlank(effectiveValue(field)))
  const productField = productFields.find(field => ['CORRECTED', 'VERIFIED'].includes(field.verification)) ?? productFields[0]
  const product = normalizeProduct(productField ? effectiveValue(productField) ?? '' : '')
  const isPpaOrLease = product === 'ppa' || product === 'lease'

  // Keep the schema-42 keys and support existing stored definitions. Product-aware
  // selection prevents a PPA escalation from turning into a loan interest rate.
  if (def.key === 'lender_confirmed' && isPpaOrLease) {
    candidates = at('solar_contract', 'contract_counterparty')
    derivation = 'PPA / lease contract counterparty; this is not a loan lender.'
  } else if (def.key === 'apr_or_escalator' && isPpaOrLease) {
    candidates = at('solar_contract', 'escalator_pct')
    derivation = 'Annual payment escalation; not loan APR.'
  } else if (def.key === 'term_months') {
    candidates = [...at('finance_agreement', 'term_months'), ...at('solar_contract', 'term_months')]
    if (!candidates.some(field => !isBlank(effectiveValue(field)))) {
      candidates = [...at('solar_contract', 'term_years'), ...at('finance_agreement', 'term_years')]
        .filter(field => termMonthsFromYears(effectiveValue(field) ?? ''))
        .map(field => ({ ...field, value: termMonthsFromYears(field.value ?? ''), correctedValue: field.correctedValue ? termMonthsFromYears(field.correctedValue) : null }))
      derivation = 'Derived months = stated years × 12. The term start date remains separate.'
    }
  } else if (def.key === 'first_payment_or_install' && isPpaOrLease) {
    candidates = at('solar_contract', 'in_service_date')
    derivation = 'Actual in-service date; never inferred from signing or the effective date.'
  }
  if (def.key === 'product_confirmed') candidates = candidates.map(field => ({ ...field, value: field.value ? normalizeProduct(field.value) : null, correctedValue: field.correctedValue ? normalizeProduct(field.correctedValue) : null }))

  const verified = candidates
    .filter(
      (f) =>
        (f.verification === 'VERIFIED' || f.verification === 'CORRECTED') &&
        !isBlank(effectiveValue(f)),
    )
    // VERIFIED outranks CORRECTED only for choosing the representative row;
    // disagreement between the two is still a conflict below.
    .sort((a, b) => (a.verification === b.verification ? 0 : a.verification === 'VERIFIED' ? -1 : 1))
  const suggested = candidates
    .filter((f) => f.verification === 'UNVERIFIED' && !isBlank(f.value))
    .sort((a, b) => b.confidence - a.confidence)

  if (verified.length > 0) {
    const primary = verified[0]
    const primaryValue = effectiveValue(primary) as string
    const disagreeing = verified.find(
      (f) => normalizeForCompare(effectiveValue(f) as string) !== normalizeForCompare(primaryValue),
    )
    if (disagreeing) {
      return {
        ...missing(def.key),
        ...docSource(primary),
        value: primaryValue,
        status: 'CONFLICT',
        conflictValue: effectiveValue(disagreeing),
        note: `Also read as "${effectiveValue(disagreeing)}" in ${disagreeing.documentLabel}.`,
      }
    }
    const dissent = suggested.find(
      (f) => normalizeForCompare(f.value as string) !== normalizeForCompare(primaryValue),
    )
    return {
      ...missing(def.key),
      ...docSource(primary),
      value: primaryValue,
      status: 'VERIFIED',
      confidence: primary.confidence,
      // A human-reviewed value beats an AI suggestion, but the disagreement is noted.
      note: [derivation, dissent ? `An unverified extraction read "${dissent.value}" (${dissent.documentLabel}).` : null].filter(Boolean).join(' ') || null,
    }
  }

  if (suggested.length > 0) {
    const primary = suggested[0]
    const disagreeing = suggested.find(
      (f) => normalizeForCompare(f.value as string) !== normalizeForCompare(primary.value as string),
    )
    if (disagreeing) {
      return {
        ...missing(def.key),
        ...docSource(primary),
        value: primary.value,
        status: 'CONFLICT',
        confidence: primary.confidence,
        conflictValue: disagreeing.value,
        note: `Also read as "${disagreeing.value}" in ${disagreeing.documentLabel}.`,
      }
    }
    // An UNVERIFIED extraction is never client data — it can only ever suggest.
    return {
      ...missing(def.key),
      ...docSource(primary),
      value: primary.value,
      status: 'SUGGESTED',
      confidence: primary.confidence,
      note: derivation,
    }
  }

  return missing(def.key)
}

export function resolveField(def: CysDefinitionInput, sources: SourceRecord): ResolvedValue {
  const documentKind = CYS_DOCUMENT_KINDS[def.key]
  if (documentKind && sources.documents) {
    const docs = sources.documents.filter((doc) => doc.kind === documentKind)
    const doc = docs.find((candidate) => candidate.approved) ?? docs[0]
    return doc ? { ...missing(def.key), value: 'On file', status: doc.approved ? 'VERIFIED' : 'SUGGESTED', sourceDocumentId: doc.id, sourceLabel: doc.label, note: doc.approved ? 'Document approved.' : 'File received; document review is still needed.' } : missing(def.key)
  }
  switch (def.sourceType) {
    case 'CLIENT_FIELD':
      return resolveRecordField(def, sources.client, 'client', 'CRM')
    case 'ADDRESS_FIELD':
      return resolveRecordField(def, sources.address, 'address', 'CRM · address')
    case 'SURVEY_FIELD':
      return resolveRecordField(def, sources.survey, 'survey', sources.surveyProvenance?.[pathTail(def.sourcePath ?? def.key, 'survey')]?.source === 'document_review' ? 'Client document review' : 'Client survey')
    case 'DOCUMENT_FIELD':
      return resolveDocumentField(def, sources)
    case 'MANUAL':
      // Filled and verified by staff in the workspace; resolution never invents it.
      return missing(def.key, 'Manual entry')
  }
}

export function resolveAll(defs: CysDefinitionInput[], sources: SourceRecord): ResolvedValue[] {
  return defs.map((def) => resolveField(def, sources))
}

/** Flattens a Client row into the record resolveField reads from. */
export function flattenClient(client: {
  firstName: string
  lastName: string
  email: string
  phone: string
  preferredLanguage: string
}): Record<string, string> {
  return {
    firstName: client.firstName,
    lastName: client.lastName,
    fullName: `${client.firstName} ${client.lastName}`.trim(),
    email: client.email,
    phone: client.phone,
    preferredLanguage: client.preferredLanguage,
  }
}

export function flattenAddress(
  address: {
    line1: string
    line2: string | null
    city: string
    state: string
    postalCode: string
  } | null,
): Record<string, string> | null {
  if (!address) return null
  const line2 = address.line2 ? ` ${address.line2}` : ''
  return {
    line1: address.line1,
    line2: address.line2 ?? '',
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    full: `${address.line1}${line2}, ${address.city}, ${address.state} ${address.postalCode}`,
  }
}

export function flattenSurveyAnswers(answers: unknown): Record<string, string> {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
    if (key.startsWith('_')) continue
    if (value === null || value === undefined) continue
    out[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return out
}
