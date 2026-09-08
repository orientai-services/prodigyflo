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

/** Flattens a posted form body into the plain map the signature is computed over. */
export function formToParams(form: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}
