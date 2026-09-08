import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * HMAC token for document downloads. Bound to one storage key and an expiry,
 * so a leaked URL stops working quickly and can never be replayed against a
 * different file. Pure module — unit-tested without a server context.
 */

export type FileTokenPayload = {
  /** The storage key this token authorizes — and nothing else. */
  key: string
  /** Unix seconds. */
  exp: number
}

function secret(override?: string): string {
  const s = override ?? process.env.AUTH_SECRET
  if (!s) throw new Error('AUTH_SECRET must be set to sign file tokens.')
  return s
}

function hmac(data: string, sec: string): string {
  return createHmac('sha256', sec).update(data).digest('base64url')
}

export function signFileToken(payload: FileTokenPayload, secretOverride?: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${hmac(body, secret(secretOverride))}`
}

/** Returns the payload when the signature is valid and unexpired, else null. */
export function verifyFileToken(
  token: string,
  opts: { now?: number; secretOverride?: string } = {},
): FileTokenPayload | null {
  const [body, sig] = token.split('.')
  if (!body || !sig) return null

  const expected = hmac(body, secret(opts.secretOverride))
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let payload: FileTokenPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof payload.key !== 'string' || typeof payload.exp !== 'number') return null

  const now = opts.now ?? Math.floor(Date.now() / 1000)
  if (payload.exp < now) return null
  return payload
}
