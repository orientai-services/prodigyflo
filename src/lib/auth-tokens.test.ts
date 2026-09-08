import { describe, expect, it } from 'vitest'
import { hashValue } from './crypto'
import {
  AUTH_BURST_MAX_PER_IP,
  AUTH_BURST_MAX_PER_USER,
  AUTH_TOKEN_TTL_MS,
  burstAllowsIssue,
  consumeAuthToken,
  invalidateAllAuthTokens,
  issueAuthToken,
  PASSWORD_MIN_LENGTH,
  passwordPolicyError,
  type AuthTokenDb,
  type AuthTokenRow,
  type AuthTokenUser,
} from './auth-tokens'

/**
 * Pure tests: an in-memory AuthTokenDb reproduces exactly the Prisma
 * semantics the service relies on — most importantly that updateMany applies
 * its WHERE and its data in one atomic evaluation, which is what makes the
 * claim TOCTOU-free.
 */

type StoredToken = AuthTokenRow & { usedAt: Date | null }

function fakeDb(users: AuthTokenUser[] = [], activeIds?: Set<string>) {
  const tokens: StoredToken[] = []
  const active = activeIds ?? new Set(users.map((u) => u.id))

  const dbc: AuthTokenDb = {
    authToken: {
      async updateMany({ where, data }) {
        let count = 0
        for (const t of tokens) {
          if (where.userId !== undefined && t.userId !== where.userId) continue
          if (where.kind !== undefined && t.kind !== where.kind) continue
          if (where.tokenHash !== undefined && t.tokenHash !== where.tokenHash) continue
          if (t.usedAt !== null) continue // where.usedAt is always null
          if (where.expiresAt !== undefined && !(t.expiresAt > where.expiresAt.gt)) continue
          t.usedAt = data.usedAt
          count += 1
        }
        return { count }
      },
      async create({ data }) {
        tokens.push({ ...data })
        return data
      },
      async findUnique({ where }) {
        const t = tokens.find((x) => x.tokenHash === where.tokenHash)
        return t ? { userId: t.userId } : null
      },
    },
    user: {
      async findFirst({ where }) {
        const u = users.find((x) => x.id === where.id)
        return u && active.has(u.id) ? u : null
      },
    },
  }
  return { dbc, tokens }
}

const alice: AuthTokenUser = {
  id: 'u1',
  organizationId: 'org1',
  email: 'alice@example.com',
  name: 'Alice',
}

const NOW = new Date('2026-08-28T12:00:00Z')
const later = (ms: number) => new Date(NOW.getTime() + ms)

describe('issueAuthToken', () => {
  it('returns show-once plaintext and stores only its hash with the kind TTL', async () => {
    const { dbc, tokens } = fakeDb([alice])
    const { token, expiresAt } = await issueAuthToken('u1', 'PASSWORD_RESET', { dbc, now: NOW })

    expect(token.length).toBeGreaterThanOrEqual(20)
    expect(tokens).toHaveLength(1)
    expect(tokens[0].tokenHash).toBe(hashValue(token))
    expect(tokens[0].tokenHash).not.toContain(token)
    expect(expiresAt.getTime() - NOW.getTime()).toBe(AUTH_TOKEN_TTL_MS.PASSWORD_RESET)
    expect(AUTH_TOKEN_TTL_MS.PASSWORD_RESET).toBe(30 * 60 * 1000)
    expect(AUTH_TOKEN_TTL_MS.MAGIC_LINK).toBe(15 * 60 * 1000)
  })

  it('invalidates the user prior unused tokens of the SAME kind only', async () => {
    const { dbc, tokens } = fakeDb([alice])
    const first = await issueAuthToken('u1', 'PASSWORD_RESET', { dbc, now: NOW })
    const magic = await issueAuthToken('u1', 'MAGIC_LINK', { dbc, now: NOW })
    await issueAuthToken('u1', 'PASSWORD_RESET', { dbc, now: later(1000) })

    const firstRow = tokens.find((t) => t.tokenHash === hashValue(first.token))
    const magicRow = tokens.find((t) => t.tokenHash === hashValue(magic.token))
    expect(firstRow?.usedAt).not.toBeNull() // superseded
    expect(magicRow?.usedAt).toBeNull() // other kind untouched

    // The dead first token no longer redeems.
    expect(await consumeAuthToken(first.token, 'PASSWORD_RESET', { dbc, now: later(2000) })).toBeNull()
  })

  it('does not invalidate another user tokens', async () => {
    const bob: AuthTokenUser = { ...alice, id: 'u2', email: 'bob@example.com', name: 'Bob' }
    const { dbc } = fakeDb([alice, bob])
    const bobs = await issueAuthToken('u2', 'PASSWORD_RESET', { dbc, now: NOW })
    await issueAuthToken('u1', 'PASSWORD_RESET', { dbc, now: NOW })

    const got = await consumeAuthToken(bobs.token, 'PASSWORD_RESET', { dbc, now: later(1000) })
    expect(got?.id).toBe('u2')
  })
})

describe('consumeAuthToken', () => {
  it('claims once: the first consume wins, every replay gets null', async () => {
    const { dbc } = fakeDb([alice])
    const { token } = await issueAuthToken('u1', 'MAGIC_LINK', { dbc, now: NOW })

    const first = await consumeAuthToken(token, 'MAGIC_LINK', { dbc, now: later(1000) })
    expect(first).toEqual(alice)

    // Single-use atomicity: the claim already stamped usedAt, so a concurrent
    // or later replay matches zero rows.
    expect(await consumeAuthToken(token, 'MAGIC_LINK', { dbc, now: later(2000) })).toBeNull()
  })

  it('refuses an expired token', async () => {
    const { dbc } = fakeDb([alice])
    const { token } = await issueAuthToken('u1', 'MAGIC_LINK', { dbc, now: NOW })
    const afterExpiry = later(AUTH_TOKEN_TTL_MS.MAGIC_LINK + 1)
    expect(await consumeAuthToken(token, 'MAGIC_LINK', { dbc, now: afterExpiry })).toBeNull()
  })

  it('honours the boundary: gt means an exactly-at-expiry redeem fails', async () => {
    const { dbc } = fakeDb([alice])
    const { token, expiresAt } = await issueAuthToken('u1', 'MAGIC_LINK', { dbc, now: NOW })
    expect(await consumeAuthToken(token, 'MAGIC_LINK', { dbc, now: expiresAt })).toBeNull()
  })

  it('refuses a kind mismatch AND leaves the token unburned for its real kind', async () => {
    const { dbc } = fakeDb([alice])
    const { token } = await issueAuthToken('u1', 'PASSWORD_RESET', { dbc, now: NOW })

    expect(await consumeAuthToken(token, 'MAGIC_LINK', { dbc, now: later(1000) })).toBeNull()
    // The mismatch is part of the claim WHERE — nothing was stamped.
    const stillGood = await consumeAuthToken(token, 'PASSWORD_RESET', { dbc, now: later(2000) })
    expect(stillGood?.id).toBe('u1')
  })

  it('refuses a token for a deactivated user but still burns it', async () => {
    const { dbc, tokens } = fakeDb([alice], new Set())
    const { token } = await issueAuthToken('u1', 'MAGIC_LINK', { dbc, now: NOW })

    expect(await consumeAuthToken(token, 'MAGIC_LINK', { dbc, now: later(1000) })).toBeNull()
    expect(tokens[0].usedAt).not.toBeNull()
  })

  it('refuses junk input without touching the store', async () => {
    const { dbc } = fakeDb([alice])
    expect(await consumeAuthToken('', 'MAGIC_LINK', { dbc, now: NOW })).toBeNull()
    expect(await consumeAuthToken('short', 'MAGIC_LINK', { dbc, now: NOW })).toBeNull()
  })
})

describe('invalidateAllAuthTokens', () => {
  it('stamps every outstanding token across BOTH kinds', async () => {
    const { dbc, tokens } = fakeDb([alice])
    await issueAuthToken('u1', 'PASSWORD_RESET', { dbc, now: NOW })
    await issueAuthToken('u1', 'MAGIC_LINK', { dbc, now: NOW })

    await invalidateAllAuthTokens('u1', { dbc, now: later(1000) })
    expect(tokens.every((t) => t.usedAt !== null)).toBe(true)
  })
})

describe('burstAllowsIssue', () => {
  it('allows below both caps', () => {
    expect(burstAllowsIssue({ byUser: 0, byIp: 0 })).toBe(true)
    expect(burstAllowsIssue({ byUser: AUTH_BURST_MAX_PER_USER - 1, byIp: AUTH_BURST_MAX_PER_IP - 1 })).toBe(true)
  })

  it('refuses at the per-user cap (3 in the window)', () => {
    expect(burstAllowsIssue({ byUser: AUTH_BURST_MAX_PER_USER, byIp: 0 })).toBe(false)
  })

  it('refuses at the per-ip cap (8 in the window) even for a fresh user', () => {
    expect(burstAllowsIssue({ byUser: 0, byIp: AUTH_BURST_MAX_PER_IP })).toBe(false)
  })
})

describe('passwordPolicyError', () => {
  it('rejects short passwords', () => {
    expect(passwordPolicyError('a'.repeat(PASSWORD_MIN_LENGTH - 1), 'alice@example.com')).toMatch(/10/)
  })

  it('accepts a 10+ char password', () => {
    expect(passwordPolicyError('correct-horse-battery', 'alice@example.com')).toBeNull()
  })

  it('rejects the email local part, case-insensitively', () => {
    expect(passwordPolicyError('alicejones', 'AliceJones@example.com')).not.toBeNull()
    expect(passwordPolicyError('ALICEJONES', 'alicejones@example.com')).not.toBeNull()
  })

  it('allows a password that merely contains the local part', () => {
    expect(passwordPolicyError('alicejones-2026!', 'alicejones@example.com')).toBeNull()
  })
})
