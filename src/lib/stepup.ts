import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import type { SessionUser } from '@/lib/rbac'

/**
 * Step-up authentication: a short-lived, HMAC-signed grant proving the signed-in
 * user re-entered a secret moments ago. Required in front of the three most
 * dangerous surfaces — the connector credential vault, the deploy console, and
 * buying a phone number on the agency's card — so a hijacked session alone is
 * not enough to read secrets, ship code, or spend money.
 *
 * The 'vault' and 'deploy' scopes are issued against the user's OWN password
 * (confirmPasswordAction). 'telephony' is deliberately different: it is issued
 * only against the shared agency provisioning passphrase
 * (src/lib/telephony/passphrase.ts), so an admin's login can never stand in
 * for the owner's authorisation to charge the card.
 *
 * The grant travels in one httpOnly cookie and follows the same token style as
 * src/lib/storage/sign.ts: base64url payload + HMAC-SHA256, verified with
 * timingSafeEqual. One cookie holds one grant, so confirming for a new scope
 * replaces the previous one — the two consoles are separate pages, and a
 * fresh password prompt on switching is the intended behavior.
 */

export type StepUpScope = 'vault' | 'deploy' | 'telephony'

/**
 * The scopes that <StepUpGate> / confirmPasswordAction may issue — everything
 * except 'telephony', which has its own passphrase issuer. Narrowing the type
 * here is what makes "a login password can never unlock the agency card" a
 * compile-time fact rather than a convention.
 */
export type PasswordStepUpScope = Exclude<StepUpScope, 'telephony'>

export type StepUpGrant = {
  /** The user this grant was issued to — and nobody else. */
  uid: string
  scope: StepUpScope
  /** Unix seconds. */
  exp: number
}

export const STEP_UP_COOKIE = 'pf-stepup'
export const STEP_UP_TTL_SECONDS = 10 * 60

export class StepUpRequiredError extends Error {
  readonly scope: StepUpScope
  constructor(scope: StepUpScope) {
    super('Confirm your password to continue — this area requires a recent check.')
    this.name = 'StepUpRequiredError'
    this.scope = scope
  }
}

function secret(override?: string): string {
  const s = override ?? process.env.AUTH_SECRET
  if (!s) throw new Error('AUTH_SECRET must be set to sign step-up grants.')
  return s
}

function hmac(data: string, sec: string): string {
  return createHmac('sha256', sec).update(data).digest('base64url')
}

export function signStepUpGrant(grant: StepUpGrant, secretOverride?: string): string {
  const body = Buffer.from(JSON.stringify(grant)).toString('base64url')
  return `${body}.${hmac(body, secret(secretOverride))}`
}

/** Returns the grant when the signature is valid and unexpired, else null. */
export function verifyStepUpGrant(
  token: string,
  opts: { now?: number; secretOverride?: string } = {},
): StepUpGrant | null {
  const [body, sig] = token.split('.')
  if (!body || !sig) return null

  const expected = hmac(body, secret(opts.secretOverride))
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let grant: StepUpGrant
  try {
    grant = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof grant.uid !== 'string' || typeof grant.exp !== 'number') return null
  if (grant.scope !== 'vault' && grant.scope !== 'deploy' && grant.scope !== 'telephony') return null

  const now = opts.now ?? Math.floor(Date.now() / 1000)
  if (grant.exp < now) return null
  return grant
}

/** True when the caller holds a fresh grant for this scope. Never throws. */
export async function hasStepUp(user: SessionUser, scope: StepUpScope): Promise<boolean> {
  const store = await cookies()
  const token = store.get(STEP_UP_COOKIE)?.value
  if (!token) return false
  const grant = verifyStepUpGrant(token)
  return grant !== null && grant.uid === user.id && grant.scope === scope
}

/**
 * Guard for server actions and route handlers behind a step-up surface.
 * Call it AFTER the permission gate — it proves recency, not authority.
 */
export async function requireStepUp(user: SessionUser, scope: StepUpScope): Promise<void> {
  if (!(await hasStepUp(user, scope))) throw new StepUpRequiredError(scope)
}

/** Issues the cookie grant. Only confirmPasswordAction should call this. */
export async function grantStepUp(user: SessionUser, scope: StepUpScope): Promise<void> {
  const token = signStepUpGrant({
    uid: user.id,
    scope,
    exp: Math.floor(Date.now() / 1000) + STEP_UP_TTL_SECONDS,
  })
  const store = await cookies()
  store.set(STEP_UP_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: STEP_UP_TTL_SECONDS,
  })
}
