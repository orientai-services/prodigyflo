import 'server-only'
import { db } from '@/lib/db'
import { hashValue } from '@/lib/crypto'
import { recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/rbac'
import { metaFixtureModeEnabled } from '../fixture'

/**
 * The ad-account allowlist and the workspace binding (docs/META_ADS_SCS.md §2.2).
 *
 * Exactly one workspace (`META_ADS_ORG_ID`) may see Meta ads data, and only for
 * the ad accounts listed in `META_ALLOWED_AD_ACCOUNTS`. Both are required; when
 * either is unset, empty or malformed, nothing is bound and no ads Graph call
 * happens anywhere. There is deliberately no deny-list: any account that isn't
 * listed is refused, and a refusal is audited by hash only, never by digits.
 */

type Env = Record<string, string | undefined>

const MAX_DECODE_ROUNDS = 5

/** decodeURIComponent until the value stops changing; null when it never settles or is malformed. */
export function decodeStable(raw: string): string | null {
  let cur = raw
  for (let i = 0; i < MAX_DECODE_ROUNDS; i++) {
    let next: string
    try {
      next = decodeURIComponent(cur)
    } catch {
      return null
    }
    if (next === cur) return cur
    cur = next
  }
  return null
}

/** 'act_123…' or '123…' (5 to 20 digits) → 'act_123…'. Anything else → null. */
export function normalizeAdAccountId(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const decoded = decodeStable(raw.trim())
  if (decoded === null) return null
  const m = /^(?:act_)?(\d{5,20})$/.exec(decoded.trim())
  return m ? `act_${m[1]}` : null
}

/** Mock rows for one workspace. Only ever written or shown where adsMockAllowed(). */
export function mockAdAccountId(orgId: string): string {
  return `act_mock_${orgId}`
}

export function isMockAdAccountId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('act_mock_')
}

export type AdsBinding = { orgId: string; accounts: ReadonlySet<string> } | null

/** null unless BOTH vars are set and every listed account parses. */
export function adsBinding(env: Env = process.env): AdsBinding {
  const orgId = (env.META_ADS_ORG_ID ?? '').trim()
  if (!orgId || orgId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(orgId)) return null
  const parts = (env.META_ALLOWED_AD_ACCOUNTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const accounts = new Set<string>()
  for (const p of parts) {
    const n = normalizeAdAccountId(p)
    if (!n) return null // one bad entry fails the whole list closed
    accounts.add(n)
  }
  return { orgId, accounts }
}

export function isAllowedAdAccount(id: string | null | undefined, env: Env = process.env): boolean {
  if (!id) return false
  const b = adsBinding(env)
  const n = normalizeAdAccountId(id)
  return Boolean(b && n && b.accounts.has(n))
}

export function isBoundOrg(orgId: string | null | undefined, env: Env = process.env): boolean {
  const b = adsBinding(env)
  return Boolean(b && orgId && b.orgId === orgId)
}

/**
 * Same environment rules as the preview lead fixture (never on Vercel production
 * or the prodigyflo.ai hosts; only development, test and preview), without the
 * opt-in variable.
 */
export function adsMockAllowed(env: Env = process.env): boolean {
  return metaFixtureModeEnabled({ ...env, META_FIXTURE_LEADS: 'true' })
}

/**
 * The ad account ids this workspace may read. [] for every workspace except the
 * bound one. The workspace's mock id is appended only where mock mode is allowed
 * and the workspace could be in mock mode (no binding at all, or it is bound).
 */
export function allowedAccountsForOrg(orgId: string, env: Env = process.env): string[] {
  const b = adsBinding(env)
  const out: string[] = []
  if (b && b.orgId === orgId) out.push(...b.accounts)
  if (adsMockAllowed(env) && (!b || b.orgId === orgId)) out.push(mockAdAccountId(orgId))
  return out
}

export type RefusalReason = 'not_allowlisted' | 'malformed' | 'not_bound' | 'unbound_org' | 'route'

export class AdAccountNotAllowedError extends Error {
  readonly ref: string
  readonly reason: RefusalReason
  constructor(ref: string, reason: RefusalReason) {
    super(
      reason === 'unbound_org'
        ? 'Meta Ads reporting is connected to a different ProdigyFlo workspace.'
        : reason === 'not_bound'
          ? "Meta Ads reporting isn't connected."
          : "This ad account isn't approved for ProdigyFlo.",
    )
    this.name = 'AdAccountNotAllowedError'
    this.ref = ref
    this.reason = reason
  }
}

/**
 * 'acct#' plus 10 letters derived from a hash of the (normalized) id. Letters
 * only, so no run of the id's digits can ever appear in an audit row or log.
 */
export function refFor(id: string): string {
  const key = normalizeAdAccountId(id) ?? String(id)
  const hex = hashValue(`meta-ad-account:${key}`).slice(0, 10)
  const letters = [...hex].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('')
  return `acct#${letters}`
}

/** Returns the normalized id, or throws AdAccountNotAllowedError (the caller audits). */
export function assertAllowedAdAccount(id: string | null | undefined, orgId: string, env: Env = process.env): string {
  const n = id ? normalizeAdAccountId(id) : null
  const ref = refFor(id ?? '')
  if (!n) throw new AdAccountNotAllowedError(ref, 'malformed')
  const b = adsBinding(env)
  if (!b) throw new AdAccountNotAllowedError(ref, 'not_bound')
  if (b.orgId !== orgId) throw new AdAccountNotAllowedError(ref, 'unbound_org')
  if (!b.accounts.has(n)) throw new AdAccountNotAllowedError(ref, 'not_allowlisted')
  return n
}

export const REFUSAL_ACTION = 'meta.ad_account.refused'

/**
 * One audit row per (workspace, ref, where) per hour. Written into the actor's
 * workspace, else the workspace the refusal happened for (`orgId`) when it
 * exists, else the bound workspace (only for refusals that have no workspace
 * of their own). Another tenant's refusal never lands in the bound
 * workspace's log. Never throws: a refusal must not turn into an outage.
 */
export async function auditRefusal(
  orgId: string | null,
  ref: string,
  reason: string,
  where: string,
  actor?: SessionUser,
): Promise<void> {
  try {
    let target = actor?.organizationId ?? orgId ?? null
    if (!actor && orgId) {
      const exists = await db.organization.findUnique({ where: { id: orgId }, select: { id: true } })
      if (!exists) target = null
    }
    target ??= adsBinding()?.orgId ?? null
    if (!target) return
    const summary = `${where} (${reason})`.slice(0, 300)
    const recent = await db.auditEvent.findFirst({
      where: {
        organizationId: target,
        action: REFUSAL_ACTION,
        entityId: ref,
        summary,
        createdAt: { gte: new Date(Date.now() - 3_600_000) },
      },
      select: { id: true },
    })
    if (recent) return
    if (actor) {
      await recordAudit(actor, { action: REFUSAL_ACTION, entityType: 'MetaAdAccount', entityId: ref, summary })
      return
    }
    const org = await db.organization.findUnique({ where: { id: target }, select: { id: true } })
    if (!org) return
    await db.auditEvent.create({
      data: {
        organizationId: target,
        actorLabel: 'system:meta-sync',
        action: REFUSAL_ACTION,
        entityType: 'MetaAdAccount',
        entityId: ref,
        summary,
      },
    })
  } catch {
    // Auditing is best effort here; the refusal itself already happened.
  }
}
