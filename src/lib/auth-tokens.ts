import 'server-only'
import { db } from '@/lib/db'
import { hashValue, randomToken } from '@/lib/crypto'

/**
 * Single-use auth tokens for the self-service flows: password reset and
 * magic-link sign-in. The idiom matches src/lib/invites.ts — the plaintext is
 * returned exactly once (it travels only inside the emailed link) and the
 * database stores its salted sha256 hash (hashValue). Consumption is an atomic
 * updateMany claim: the row flips usedAt in the same statement that validates
 * it, so two concurrent submits of one link can never both win — the claim IS
 * the validation, there is no check-then-use window.
 *
 * The db surface is injectable so the semantics (single-use atomicity, expiry,
 * kind isolation, prior-token invalidation) are covered by pure vitest tests
 * without a database — see auth-tokens.test.ts.
 */

export type AuthTokenKind = 'PASSWORD_RESET' | 'MAGIC_LINK'

/** A reset link may sit in an inbox a while; a sign-in link should not. */
export const AUTH_TOKEN_TTL_MS: Record<AuthTokenKind, number> = {
  PASSWORD_RESET: 30 * 60 * 1000,
  MAGIC_LINK: 15 * 60 * 1000,
}

/** What the auth flows are allowed to learn about the account. */
export type AuthTokenUser = {
  id: string
  organizationId: string
  email: string
  name: string
}

// ── injectable db surface (narrowed to exactly the calls made below) ─────────

export type AuthTokenRow = {
  userId: string
  kind: string
  tokenHash: string
  expiresAt: Date
  usedAt: Date | null
  requestedIpHash: string | null
}

export type AuthTokenDb = {
  authToken: {
    updateMany(args: {
      where: {
        userId?: string
        kind?: string
        tokenHash?: string
        usedAt: null
        expiresAt?: { gt: Date }
      }
      data: { usedAt: Date }
    }): Promise<{ count: number }>
    create(args: { data: AuthTokenRow }): Promise<unknown>
    findUnique(args: {
      where: { tokenHash: string }
      select: { userId: true }
    }): Promise<{ userId: string } | null>
  }
  user: {
    findFirst(args: {
      where: { id: string; isActive: true; deletedAt: null }
      select: { id: true; organizationId: true; email: true; name: true }
    }): Promise<AuthTokenUser | null>
  }
}

type Opts = { dbc?: AuthTokenDb; now?: Date }

function deps(opts: Opts = {}): { dbc: AuthTokenDb; now: Date } {
  return { dbc: opts.dbc ?? (db as unknown as AuthTokenDb), now: opts.now ?? new Date() }
}

/**
 * Issues a fresh token of one kind for a user, returning the show-once
 * plaintext. Any prior unused token of the SAME kind is stamped used first, so
 * exactly one live link of each kind exists per user — requesting a new reset
 * email quietly kills the old link.
 */
export async function issueAuthToken(
  userId: string,
  kind: AuthTokenKind,
  opts: Opts & { requestedIpHash?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const { dbc, now } = deps(opts)

  await dbc.authToken.updateMany({
    where: { userId, kind, usedAt: null },
    data: { usedAt: now },
  })

  const token = randomToken()
  const expiresAt = new Date(now.getTime() + AUTH_TOKEN_TTL_MS[kind])
  await dbc.authToken.create({
    data: {
      userId,
      kind,
      tokenHash: hashValue(token),
      expiresAt,
      usedAt: null,
      requestedIpHash: opts.requestedIpHash ?? null,
    },
  })

  return { token, expiresAt }
}

/**
 * Atomically claims a token and returns the live user it belongs to, or null
 * for anything not redeemable (unknown, expired, already used, wrong kind, or
 * a deactivated/deleted account). The kind lives in the claim's WHERE clause,
 * so presenting a reset token to the magic-link path both fails AND leaves the
 * reset token unburned.
 */
export async function consumeAuthToken(
  plaintext: string,
  kind: AuthTokenKind,
  opts: Opts = {},
): Promise<AuthTokenUser | null> {
  const { dbc, now } = deps(opts)
  if (!plaintext || plaintext.length < 20) return null

  const tokenHash = hashValue(plaintext)
  const claimed = await dbc.authToken.updateMany({
    where: { tokenHash, kind, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  })
  if (claimed.count !== 1) return null

  const row = await dbc.authToken.findUnique({ where: { tokenHash }, select: { userId: true } })
  if (!row) return null

  // A token issued while the account was live but redeemed after deactivation
  // stays burned (claimed above) and still signs nobody in.
  return dbc.user.findFirst({
    where: { id: row.userId, isActive: true, deletedAt: null },
    select: { id: true, organizationId: true, email: true, name: true },
  })
}

/**
 * Stamp used on EVERY outstanding token for a user, both kinds. Called after a
 * successful password reset: old reset links and pending sign-in links must
 * not survive a credential change.
 */
export async function invalidateAllAuthTokens(userId: string, opts: Opts = {}): Promise<void> {
  const { dbc, now } = deps(opts)
  await dbc.authToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } })
}

// ── burst-limit math (pure — the stepup.ts count-recent-rows idiom) ──────────

export const AUTH_BURST_WINDOW_MS = 15 * 60 * 1000
export const AUTH_BURST_MAX_PER_USER = 3
export const AUTH_BURST_MAX_PER_IP = 8

/**
 * True when another token may be issued. `byUser` counts this user's tokens of
 * the requested kind inside the window; `byIp` counts ALL tokens the caller's
 * hashed IP requested in the window (both kinds — one address hammering both
 * flows is still one address). Callers on the refused path MUST still return
 * the generic success shape so the limiter never becomes an enumeration oracle.
 */
export function burstAllowsIssue(counts: { byUser: number; byIp: number }): boolean {
  return counts.byUser < AUTH_BURST_MAX_PER_USER && counts.byIp < AUTH_BURST_MAX_PER_IP
}

// ── password policy (pure) ───────────────────────────────────────────────────

export const PASSWORD_MIN_LENGTH = 10

/**
 * Returns a human error for an unacceptable new password, or null when it
 * passes: at least 10 characters and not the email's local part (the one
 * "password equals username" howler everyone tries first).
 */
export function passwordPolicyError(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`
  }
  const localPart = email.split('@')[0] ?? ''
  if (localPart && password.toLowerCase() === localPart.toLowerCase()) {
    return 'Your password cannot be the first part of your email address.'
  }
  return null
}
