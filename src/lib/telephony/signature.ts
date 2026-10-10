import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Twilio request validation.
 *
 * The carrier webhooks are public endpoints — Twilio posts to them with no
 * session and no bearer token — so the signature IS the authentication. Twilio
 * signs the exact request URL plus, for form-encoded POSTs, every parameter
 * appended in key-sorted order, with HMAC-SHA1 keyed by the account's auth
 * token, base64-encoded, in the X-Twilio-Signature header.
 *
 *   https://www.twilio.com/docs/usage/security#validating-requests
 *
 * Kept pure and dependency-free so it is fully unit-testable, and written to
 * refuse rather than throw: no token, no header, or any mismatch all return
 * false, and the route answers 403 without touching the database.
 */

export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature'

/** The exact string Twilio signs: URL + sorted key/value concatenation. */
export function twilioSignatureBase(url: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort()
  return keys.reduce((acc, key) => acc + key + params[key], url)
}

export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  return createHmac('sha1', authToken).update(twilioSignatureBase(url, params), 'utf8').digest('base64')
}

export function validateTwilioSignature(input: {
  authToken: string | undefined | null
  url: string
  params: Record<string, string>
  header: string | null | undefined
}): boolean {
  if (!input.authToken || !input.header) return false
  const expected = Buffer.from(computeTwilioSignature(input.authToken, input.url, input.params), 'utf8')
  const received = Buffer.from(input.header.trim(), 'utf8')
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}

/**
 * The URL Twilio signed. Behind nginx the request the app sees is http on an
 * internal host, while Twilio signed the public https URL, so the forwarded
 * proto/host headers are what must be trusted here — the same reason AUTH_URL
 * is pinned for Auth.js.
 */
export function publicWebhookUrl(request: Request, appOrigin: string): string {
  const url = new URL(request.url)
  const origin = appOrigin.replace(/\/+$/, '')
  return `${origin}${url.pathname}${url.search}`
}

/**
 * Every URL Twilio may have signed for this request, canonical host first.
 *
 * On Vercel the app can see a different host from the one Twilio called (the
 * apex 308s app paths to www, previews have their own hosts), so the check
 * tries APP_URL's origin first and then the forwarded host — but ONLY when that
 * host is APP_URL's own or is on the explicit allowlist. An arbitrary
 * x-forwarded-host is never trusted: anyone can send that header.
 */
export function candidateWebhookUrls(
  request: Request,
  appOrigin: string,
  extraHosts: readonly string[] = [],
): string[] {
  const url = new URL(request.url)
  const tail = `${url.pathname}${url.search}`
  const origin = appOrigin.replace(/\/+$/, '')
  const out = [`${origin}${tail}`]

  let appHost = ''
  try {
    appHost = new URL(origin).host.toLowerCase()
  } catch {
    // An unparseable APP_URL leaves only the canonical candidate above.
  }
  const allowed = new Set([appHost, ...extraHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)])
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase()
  if (forwarded && allowed.has(forwarded)) {
    const candidate = `https://${forwarded}${tail}`
    if (!out.includes(candidate)) out.push(candidate)
  }
  return out
}

/** True when the signature matches ANY candidate URL. Each compare is constant-time. */
export function validateTwilioSignatureAny(input: {
  authToken: string | undefined | null
  urls: readonly string[]
  params: Record<string, string>
  header: string | null | undefined
}): boolean {
  let ok = false
  // Check every candidate rather than stopping at the first hit, so the time
  // taken does not reveal which URL matched.
  for (const url of input.urls) {
    if (validateTwilioSignature({ authToken: input.authToken, url, params: input.params, header: input.header })) {
      ok = true
    }
  }
  return ok
}

/** Comma list from TELEPHONY_WEBHOOK_HOSTS: extra hosts accepted for signatures. */
export function webhookHostAllowlist(env: Record<string, string | undefined> = process.env): string[] {
  return (env.TELEPHONY_WEBHOOK_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Whether the unsigned-webhook development bypass is honoured. All three must
 * hold: not a production build, not Vercel production, and the mock carrier.
 * In production the flag is ignored — a public endpoint that trusts anyone
 * because one variable was set by mistake is how these get abused.
 */
export function allowUnsignedWebhooks(env: Record<string, string | undefined> = process.env): boolean {
  if (env.TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS !== 'true') return false
  if (env.NODE_ENV === 'production') return false
  if (env.VERCEL_ENV === 'production') return false
  const provider = (env.TELEPHONY_PROVIDER ?? 'mock').trim().toLowerCase() || 'mock'
  return provider === 'mock'
}

/** Flattens a posted form body into the plain map the signature is computed over. */
export function formToParams(form: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}
