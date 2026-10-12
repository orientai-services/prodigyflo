import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The SCS Intake link (docs/CYS_BRIDGE.md §B1). The desk hands a lead an SCS
 * `/begin` URL carrying `pfl`, an opaque token only ProdigyFlo signs and
 * reads: `v1.<base64url(leadId)>.<exp seconds>.<hmac>`. SCS copies it into
 * `data.attribution.pfl`, and the packet receiver uses it to link the new
 * Client back to this lead. No PII rides in the URL.
 *
 * The key is a subkey of AUTH_SECRET, so no new secret exists for this.
 * Pure (no DB): the receiver and the desk both call it.
 */

export const SCS_BEGIN_URL = 'https://solarcontractservices.com/begin'
export const INTAKE_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000

const VERSION = 'v1'
const SUBKEY_LABEL = 'pf-cc-intake-link/v1'
const LEAD_ID = /^[A-Za-z0-9:_-]{1,200}$/

export type IntakeTokenCheck =
  | { ok: true; leadId: string; expiresAt: Date; tokenId: string }
  | { ok: false; reason: 'no_secret' | 'malformed' | 'bad_signature' | 'expired' }

function subkey(secret: string): Buffer {
  return createHmac('sha256', secret).update(SUBKEY_LABEL, 'utf8').digest()
}

function mac(secret: string, body: string): string {
  return createHmac('sha256', subkey(secret)).update(body, 'utf8').digest('base64url')
}

/** Short, non-secret id for a token: the trail and audit rows name it, never the token. */
export function intakeTokenId(token: string): string {
  return token.split('.')[3]?.slice(0, 12) ?? ''
}

export function signIntakeToken(
  leadId: string,
  now = new Date(),
  secret: string | undefined = process.env.AUTH_SECRET,
): string {
  if (!secret) throw new Error('AUTH_SECRET is not set; the intake link cannot be signed.')
  if (!LEAD_ID.test(leadId)) throw new Error('Not a desk lead id.')
  const exp = Math.floor((now.getTime() + INTAKE_LINK_TTL_MS) / 1000)
  const body = `${VERSION}.${Buffer.from(leadId, 'utf8').toString('base64url')}.${exp}`
  return `${body}.${mac(secret, body)}`
}

export function verifyIntakeToken(
  token: unknown,
  now = new Date(),
  secret: string | undefined = process.env.AUTH_SECRET,
): IntakeTokenCheck {
  if (!secret) return { ok: false, reason: 'no_secret' }
  if (typeof token !== 'string' || token.length > 600) return { ok: false, reason: 'malformed' }
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION || !/^\d{1,12}$/.test(parts[2])) return { ok: false, reason: 'malformed' }
  const expected = Buffer.from(mac(secret, parts.slice(0, 3).join('.')))
  const given = Buffer.from(parts[3])
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' }
  const leadId = Buffer.from(parts[1], 'base64url').toString('utf8')
  if (!LEAD_ID.test(leadId)) return { ok: false, reason: 'malformed' }
  const expiresAt = new Date(Number(parts[2]) * 1000)
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' }
  return { ok: true, leadId, expiresAt, tokenId: intakeTokenId(token) }
}

function attributionString(raw: unknown, key: string): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = (raw as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null
}

/**
 * The URL a rep opens, copies or texts. `assist` marks the rep-assisted
 * ("Open with client") path: SCS then shows its rep banner and read-aloud
 * consent scripts. `fresh=1` stops SCS offering to resume another client's
 * case from the rep's browser.
 */
export function scsIntakeUrl(opts: {
  token: string
  pageId?: string | null
  leadAttribution?: unknown
  assist?: boolean
}): string {
  const url = new URL(SCS_BEGIN_URL)
  url.searchParams.set('pfl', opts.token)
  url.searchParams.set('utm_source', 'prodigyflo')
  url.searchParams.set('utm_medium', 'call_center')
  if (opts.pageId) url.searchParams.set('utm_campaign', opts.pageId)
  const content = attributionString(opts.leadAttribution, 'adId') ?? attributionString(opts.leadAttribution, 'formId')
  if (content) url.searchParams.set('utm_content', content)
  url.searchParams.set('fresh', '1')
  if (opts.assist) url.searchParams.set('assist', '1')
  return url.toString()
}

const TEXT_HOURS = { start: 9, end: 20 }
const DEFAULT_ZONE = 'America/Los_Angeles'

function hourIn(zone: string, now: Date): number {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(now))
  } catch {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(now))
  }
}

/**
 * Why "Text link" can't be used for this lead right now, or null when it can.
 * The send itself still runs the full outbound decision; this is what lets
 * the panel hide the option with a reason before the rep tries.
 */
export function intakeTextBlock(
  lead: {
    consentAt: Date | null
    consentRevokedAt: Date | null
    doNotCallAt: Date | null
    timeZone: string | null
  },
  smsMock: boolean,
  now = new Date(),
): string | null {
  if (lead.doNotCallAt) return 'This lead is on the do-not-call list.'
  if (lead.consentRevokedAt) return 'They texted STOP, so we cannot text them.'
  if (!lead.consentAt) return 'No consent to text on file. Copy the link or open it with them instead.'
  if (smsMock) return 'Texting is not switched on yet. Copy the link instead.'
  const hour = hourIn(lead.timeZone || DEFAULT_ZONE, now)
  if (hour < TEXT_HOURS.start || hour >= TEXT_HOURS.end) return 'Outside texting hours (9:00 to 20:00 their time).'
  return null
}

/** The text that carries the link, in the lead's language. */
export function intakeTextBody(url: string, language: 'EN' | 'ES'): string {
  return language === 'ES'
    ? `Solar Contract Services: este es su enlace para la revisión de su contrato solar: ${url} Responda STOP para no recibir más mensajes.`
    : `Solar Contract Services: here is your link to start your solar contract review: ${url} Reply STOP to opt out.`
}
