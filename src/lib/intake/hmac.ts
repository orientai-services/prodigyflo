import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Webhook signing scheme.
 *
 * We never store the plaintext secret — only `secretHash = SHA-256(secret)`.
 * Because HMAC verification needs the same key on both sides, the signing key
 * IS that hash: callers compute `key = sha256_hex(secret)` from the secret they
 * were shown once, then send `X-Intake-Signature: sha256=HMAC_SHA256(key, rawBody)`.
 * The server verifies with the stored hash directly and can never leak the
 * original secret.
 */

export const SIGNATURE_HEADER = 'x-intake-signature'

export function generateIntakeSecret(): string {
  return `ik_${randomBytes(24).toString('base64url')}`
}

/** SHA-256 hex of the plaintext secret — both the stored value and the HMAC key. */
export function hashIntakeSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** Compute the signature header value for a raw request body. */
export function signRawBody(secretHash: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secretHash).update(rawBody, 'utf8').digest('hex')}`
}

/** Timing-safe check of the incoming signature header against the stored hash. */
export function verifySignature(
  secretHash: string | null | undefined,
  rawBody: string,
  header: string | null | undefined,
): boolean {
  if (!secretHash || !header) return false
  const expected = Buffer.from(signRawBody(secretHash, rawBody), 'utf8')
  const received = Buffer.from(header.trim(), 'utf8')
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}

/** Header GoHighLevel (and any static-token sender) presents its shared token in. */
export const TOKEN_HEADER = 'x-connector-token'

/**
 * Timing-safe check of a presented static token against the stored hash.
 * TOKEN mode: the sender can only attach a fixed header (GoHighLevel workflow
 * webhooks), so we hash what they send and compare it to the stored hash.
 */
export function verifyToken(
  secretHash: string | null | undefined,
  presented: string | null | undefined,
): boolean {
  if (!secretHash || !presented) return false
  const expected = Buffer.from(secretHash, 'utf8')
  const received = Buffer.from(hashIntakeSecret(presented.trim()), 'utf8')
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}
