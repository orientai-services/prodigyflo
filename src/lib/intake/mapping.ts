/**
 * CRM fields an intake source may map incoming payload keys onto.
 * `contact: true` marks the fields of which at least one is required to
 * create a client (the Client model needs an email or a phone to be reachable).
 */
export const CRM_FIELDS = [
  { key: 'firstName', label: 'First name', required: true },
  { key: 'lastName', label: 'Last name', required: true },
  { key: 'email', label: 'Email', contact: true },
  { key: 'phone', label: 'Phone', contact: true },
  { key: 'preferredLanguage', label: 'Preferred language' },
  { key: 'addressLine1', label: 'Address line 1' },
  { key: 'addressLine2', label: 'Address line 2' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'postalCode', label: 'Postal code' },
  { key: 'utmSource', label: 'UTM source' },
  { key: 'utmMedium', label: 'UTM medium' },
  { key: 'utmCampaign', label: 'UTM campaign' },
  { key: 'utmTerm', label: 'UTM term' },
  { key: 'utmContent', label: 'UTM content' },
  { key: 'estimatedValue', label: 'Estimated value' },
  { key: 'note', label: 'Note' },
] as const

export type CrmFieldKey = (typeof CRM_FIELDS)[number]['key']

export const CRM_FIELD_KEYS = CRM_FIELDS.map((f) => f.key) as string[]

export type MappedLead = Partial<Record<CrmFieldKey, string>>

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Read a dot-path (`entry.contact.email`) out of a nested payload. */
export function getPath(payload: unknown, path: string): unknown {
  let current: unknown = payload
  for (const part of path.split('.')) {
    if (!isPlainObject(current)) return undefined
    current = current[part]
  }
  return current
}

/** All leaf dot-paths in a payload — what the mapping UI offers as choices. */
export function flattenKeys(payload: unknown, prefix = ''): string[] {
  if (!isPlainObject(payload)) return []
  const keys: string[] = []
  for (const [k, v] of Object.entries(payload)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (isPlainObject(v)) keys.push(...flattenKeys(v, path))
    else keys.push(path)
  }
  return keys
}

function asScalarString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim()
    return t === '' ? undefined : t
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return String(v)
  return undefined
}

/**
 * Apply `{ crmField: incomingKey }` to a payload. Unknown crm keys in the
 * mapping are ignored; incoming leaf keys not consumed by the mapping are
 * reported so staff can wire them up later.
 */
export function applyMapping(
  fieldMapping: Record<string, string>,
  payload: unknown,
): { mapped: MappedLead; unmappedKeys: string[] } {
  const mapped: MappedLead = {}
  const used = new Set<string>()

  for (const [crmField, incomingKey] of Object.entries(fieldMapping)) {
    if (!CRM_FIELD_KEYS.includes(crmField) || typeof incomingKey !== 'string' || !incomingKey) continue
    const value = asScalarString(getPath(payload, incomingKey))
    if (value !== undefined) {
      mapped[crmField as CrmFieldKey] = value
      used.add(incomingKey)
    } else if (getPath(payload, incomingKey) !== undefined) {
      used.add(incomingKey) // present but empty — still consumed by the mapping
    }
  }

  const unmappedKeys = flattenKeys(payload).filter((k) => !used.has(k))
  return { mapped, unmappedKeys }
}

/** CRM fields a submission cannot be applied without. */
export function missingRequiredFields(mapped: MappedLead): string[] {
  const missing: string[] = []
  if (!mapped.firstName) missing.push('firstName')
  if (!mapped.lastName) missing.push('lastName')
  if (!mapped.email && !mapped.phone) missing.push('email or phone')
  return missing
}

/** Stable JSON: objects with the same content hash identically regardless of key order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
  return `{${entries.join(',')}}`
}

/** Dedupe keys a source may order. First hit wins. */
export const DEDUPE_KEYS = ['email', 'phone', 'name'] as const
export type DedupeKey = (typeof DEDUPE_KEYS)[number]

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return digits.length > 10 ? digits.slice(-10) : digits
}
