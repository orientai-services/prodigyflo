// Pure CSV parsing and column-mapping helpers for the client importer.
// No server-only import: the import wizard parses in the browser too.

export type ParsedCsv = { headers: string[]; rows: string[][] }

/** RFC 4180 parser: quoted cells, escaped quotes, CR/LF/CRLF line ends. */
export function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      rows.push(row)
      row = []
    } else {
      cell += ch
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }

  // Drop rows that are entirely empty (trailing newlines, spacer lines).
  const filled = rows.filter((r) => r.some((c) => c.trim() !== ''))
  const [headers = [], ...body] = filled
  return { headers: headers.map((h) => h.trim()), rows: body }
}

export const CRM_FIELDS = [
  { key: 'firstName', label: 'First name', required: true },
  { key: 'lastName', label: 'Last name', required: true },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'preferredLanguage', label: 'Preferred language' },
  { key: 'line1', label: 'Address line 1' },
  { key: 'line2', label: 'Address line 2' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'postalCode', label: 'Postal code' },
  { key: 'estimatedValue', label: 'Estimated value' },
  { key: 'utmSource', label: 'UTM source' },
  { key: 'utmMedium', label: 'UTM medium' },
  { key: 'utmCampaign', label: 'UTM campaign' },
  { key: 'leadSource', label: 'Lead source name' },
  { key: 'note', label: 'Note' },
] as const

export type CrmFieldKey = (typeof CRM_FIELDS)[number]['key']

/** mapping[field] = column index in the CSV, or -1 for "not mapped". */
export type ColumnMapping = Record<CrmFieldKey, number>

const SYNONYMS: Record<CrmFieldKey, string[]> = {
  firstName: ['firstname', 'first', 'fname', 'givenname'],
  lastName: ['lastname', 'last', 'lname', 'surname', 'familyname'],
  email: ['email', 'emailaddress', 'mail'],
  phone: ['phone', 'phonenumber', 'mobile', 'cell', 'telephone', 'tel'],
  preferredLanguage: ['language', 'preferredlanguage', 'lang', 'locale'],
  line1: ['address', 'address1', 'addressline1', 'street', 'line1', 'streetaddress'],
  line2: ['address2', 'addressline2', 'line2', 'apt', 'unit', 'suite'],
  city: ['city', 'town'],
  state: ['state', 'province', 'region'],
  postalCode: ['zip', 'zipcode', 'postal', 'postalcode', 'postcode'],
  estimatedValue: ['value', 'estimatedvalue', 'dealvalue', 'amount'],
  utmSource: ['utmsource', 'source'],
  utmMedium: ['utmmedium', 'medium'],
  utmCampaign: ['utmcampaign', 'campaign'],
  leadSource: ['leadsource', 'leadsourcename', 'channel', 'origin'],
  note: ['note', 'notes', 'comment', 'comments', 'remarks'],
}

function slug(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Guesses which column feeds which CRM field. Exact synonym match only. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping = Object.fromEntries(CRM_FIELDS.map((f) => [f.key, -1])) as ColumnMapping
  const used = new Set<number>()
  for (const field of CRM_FIELDS) {
    const idx = headers.findIndex((h, i) => !used.has(i) && SYNONYMS[field.key].includes(slug(h)))
    if (idx >= 0) {
      mapping[field.key] = idx
      used.add(idx)
    }
  }
  return mapping
}

export type ImportRecord = Partial<Record<CrmFieldKey, string>>

export function rowToRecord(row: string[], mapping: ColumnMapping): ImportRecord {
  const record: ImportRecord = {}
  for (const field of CRM_FIELDS) {
    const idx = mapping[field.key]
    if (idx >= 0) {
      const value = (row[idx] ?? '').trim()
      if (value !== '') record[field.key] = value
    }
  }
  return record
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Field-level problems that make a row unimportable. */
export function validateRecord(record: ImportRecord): string[] {
  const errors: string[] = []
  if (!record.firstName) errors.push('Missing first name')
  if (!record.lastName) errors.push('Missing last name')
  if (!record.email && !record.phone) errors.push('Needs an email or a phone')
  if (record.email && !EMAIL_RE.test(record.email)) errors.push('Invalid email')
  if (record.estimatedValue && Number.isNaN(Number(record.estimatedValue.replace(/[$,]/g, '')))) {
    errors.push('Estimated value is not a number')
  }
  return errors
}

/** Hard cap per import run — a CSV import is an onboarding tool, not an ETL pipeline. */
export const MAX_IMPORT_ROWS = 500
