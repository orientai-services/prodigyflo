import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'

/**
 * Agency org switch: a signed, long-lived cookie recording which organization
 * an agency user is currently working in. The cookie is a PREFERENCE, not the
 * security boundary — every request re-validates the grant in getSessionUser:
 * the signature must verify, the grant must belong to the signed-in user, the
 * user's HOME org must be an AGENCY, and the target must be the home org or
 * one of its direct, non-deleted children. Any failure silently falls back to
 * the home org, which is byte-identical to pre-switch behavior.
 *
 * Token style mirrors src/lib/stepup.ts (base64url payload + HMAC-SHA256,
 * timingSafeEqual, injectable secret/clock for pure tests). TTL is 30 days
 * because losing the cookie only resets a preference; revoking access happens
 * at the data layer (org deleted / user moved / role changed), never here.
 */

export type OrgSwitchGrant = {
  /** The user this grant was issued to — and nobody else. */
  uid: string
  /** The organization the user chose to work in. */
  orgId: string
  /** Unix seconds. */
  exp: number
}

export const ORG_SWITCH_COOKIE = 'pf-active-org'
export const ORG_SWITCH_TTL_SECONDS = 30 * 24 * 60 * 60

function secret(override?: string): string {
  const s = override ?? process.env.AUTH_SECRET
  if (!s) throw new Error('AUTH_SECRET must be set to sign org-switch grants.')
  return s
}

function hmac(data: string, sec: string): string {
  return createHmac('sha256', sec).update(data).digest('base64url')
}

export function signOrgSwitchGrant(grant: OrgSwitchGrant, secretOverride?: string): string {
  const body = Buffer.from(JSON.stringify(grant)).toString('base64url')
  return `${body}.${hmac(body, secret(secretOverride))}`
}

/** Returns the grant when the signature is valid and unexpired, else null. */
export function verifyOrgSwitchGrant(
  token: string,
  opts: { now?: number; secretOverride?: string } = {},
): OrgSwitchGrant | null {
  const [body, sig] = token.split('.')
  if (!body || !sig) return null

  const expected = hmac(body, secret(opts.secretOverride))
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let grant: OrgSwitchGrant
  try {
    grant = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof grant !== 'object' || grant === null) return null
  if (typeof grant.uid !== 'string' || typeof grant.orgId !== 'string' || typeof grant.exp !== 'number') {
    return null
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000)
  if (grant.exp < now) return null
  return grant
}

/**
 * Pure eligibility rule: may a user whose HOME org is `home` work inside
 * `target`? Only agency users switch, and only into their own org or a
 * direct, non-deleted child. Grandchildren are deliberately out of reach —
 * the tree is one level deep by design.
 */
export function isSwitchableTarget(
  home: { id: string; kind: string },
  target: { id: string; parentOrganizationId: string | null; deletedAt: Date | null },
): boolean {
  if (home.kind !== 'AGENCY') return false
  if (target.deletedAt !== null) return false
  return target.id === home.id || target.parentOrganizationId === home.id
}

/**
 * Issues the active-org cookie. Callers (the agency console's switch action)
 * must re-validate eligibility BEFORE calling — this only records the choice.
 */
export async function setActiveOrganizationCookie(uid: string, orgId: string): Promise<void> {
  const token = signOrgSwitchGrant({
    uid,
    orgId,
    exp: Math.floor(Date.now() / 1000) + ORG_SWITCH_TTL_SECONDS,
  })
  const store = await cookies()
  store.set(ORG_SWITCH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ORG_SWITCH_TTL_SECONDS,
  })
}

/** Drops the preference — the next request resolves to the home org. */
export async function clearActiveOrganizationCookie(): Promise<void> {
  const store = await cookies()
  store.delete(ORG_SWITCH_COOKIE)
}
