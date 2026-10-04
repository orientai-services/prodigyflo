/**
 * Which Facebook lead ads belong on the Call Center desk.
 * The SCS English Page and its form stay off the Client path.
 * A repeated leadgen id keeps the id it already has, so Meta redelivery
 * cannot open a second row.
 */

export const SCS_ENGLISH_PAGE_ID = '1333173556539688'
export const SCS_ENGLISH_FORM_ID = '1864578424713034'

export type MetaLeadRoute = 'call-center' | 'client'

function clean(value: string | null | undefined): string {
  return (value ?? '').trim()
}

/** English Page or English form -> Call Center. Every other lead stays a Client. */
export function callCenterMetaRoute(input: {
  pageId?: string | null
  formId?: string | null
}): MetaLeadRoute {
  const pageId = clean(input.pageId)
  const formId = clean(input.formId)
  if (pageId === SCS_ENGLISH_PAGE_ID || formId === SCS_ENGLISH_FORM_ID) return 'call-center'
  return 'client'
}

/** Stable primary key. The same org + leadgen id always names the same row. */
export function callCenterLeadId(organizationId: string, leadgenId: string): string {
  return `meta:${organizationId}:${leadgenId}`
}

/**
 * Pure dedupe. `created` is false when this leadgen id is already stored,
 * so the caller does not write a second row.
 */
export function claimLeadgenId(stored: readonly string[], leadgenId: string): {
  stored: string[]
  created: boolean
} {
  const id = clean(leadgenId)
  if (!id || stored.includes(id)) return { stored: [...stored], created: false }
  return { stored: [...stored, id], created: true }
}

/** Last four digits only. A shorter value is not a phone we can show. */
export function phoneLast4FromFields(fields: Record<string, string | undefined>): string | null {
  const raw = fields.phone_number || fields.phone || ''
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 4) return null
  return digits.slice(-4)
}

/** A display name. A value that is really a phone number is not used as a name. */
export function callCenterPersonName(fields: Record<string, string | undefined>): string {
  const full = (fields.full_name || '').trim()
  const joined = full || [fields.first_name, fields.last_name].map((part) => (part || '').trim()).filter(Boolean).join(' ')
  if (!joined) return 'Facebook lead'
  if (joined.replace(/\D/g, '').length >= 7) return 'Facebook lead'
  return joined.slice(0, 80)
}

export function callCenterZip(fields: Record<string, string | undefined>): string | null {
  const raw = fields.zip_code || fields.zip || fields.postal_code || fields.post_code || ''
  const match = raw.match(/\d{5}/)
  return match ? match[0] : null
}

export function facebookFormEventBody(input: {
  leadgenId: string
  name: string
  zip: string | null
}): string {
  return JSON.stringify({
    label: 'Facebook form',
    leadgenId: input.leadgenId,
    name: input.name,
    zip: input.zip,
  })
}

export function readFacebookFormEvent(body: string): { name: string | null; zip: string | null } {
  try {
    const parsed = JSON.parse(body) as { label?: unknown; name?: unknown; zip?: unknown }
    if (parsed.label !== 'Facebook form') return { name: null, zip: null }
    const name = typeof parsed.name === 'string' ? callCenterPersonName({ full_name: parsed.name }) : null
    const zip = typeof parsed.zip === 'string' && /^\d{5}$/.test(parsed.zip) ? parsed.zip : null
    return { name: name === 'Facebook lead' ? null : name, zip }
  } catch {
    return { name: null, zip: null }
  }
}
