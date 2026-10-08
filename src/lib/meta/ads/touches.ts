import 'server-only'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { MetaGraphError } from './graph-client'
import type { AdsSource, Ownership } from './source'

/**
 * MetaLeadTouch: a rebuildable index over the leadAttribution JSON that intake
 * already stores (src/lib/meta/attribution.ts, storedAttribution). There are no
 * Graph lead reads here. The ads token is only used to ask which account an
 * unknown ad id belongs to (GET /{ad_id}?fields=account_id), cached in
 * MetaObjectAccount. Anything not proven to be in an allowed account is
 * OUTSIDE (fail closed), and outside touches keep no ad, ad set, campaign or
 * account ids at all: only a count.
 */

export type TouchStatus = 'matched' | 'outside' | 'unmatched' | 'pending'

export type ParsedAttribution = {
  leadgenId: string
  adId: string | null
  adsetId: string | null
  campaignId: string | null
  formId: string | null
  platform: string | null
  isOrganic: boolean | null
  capturedAt: Date | null
}

const s = (v: unknown, max = 64): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const t = String(v).trim()
  return t ? t.slice(0, max) : null
}

/** The stored JSON → the fields a touch needs. Names are deliberately ignored. */
export function parseStoredAttribution(raw: unknown): ParsedAttribution | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const a = raw as Record<string, unknown>
  if (a.provider !== 'meta') return null
  const leadgenId = s(a.leadgenId, 100)
  if (!leadgenId) return null
  const captured = typeof a.capturedAt === 'string' ? new Date(a.capturedAt) : null
  return {
    leadgenId,
    adId: s(a.adId),
    adsetId: s(a.adsetId),
    campaignId: s(a.campaignId),
    formId: s(a.formId),
    platform: s(a.platform, 20),
    isOrganic: typeof a.isOrganic === 'boolean' ? a.isOrganic : null,
    capturedAt: captured && !Number.isNaN(captured.getTime()) ? captured : null,
  }
}

/**
 * Probe answers that may be temporary: a permission blip, or a brand-new ad
 * Meta doesn't return yet. They are cached, but the touch stays pending and the
 * ad is probed again after RETRY_MS, until the lead is GIVE_UP_MS old.
 */
const TENTATIVE: ReadonlySet<string> = new Set<Ownership>(['no_access', 'not_found'])
export const TOUCH_RETRY_MS = 6 * 3_600_000
export const TOUCH_GIVE_UP_MS = 3 * 86_400_000

type CachedOwner = { outside: boolean; adAccountId: string | null; final?: boolean }

/** Classification for one lead. Pure. A cached verdict that isn't final keeps the touch pending. */
export function classifyTouch(
  a: ParsedAttribution | null,
  lookup: { local: string | null; cached: CachedOwner | null; probe: Ownership | null },
  accounts: readonly string[],
): { status: TouchStatus; adAccountId: string | null } {
  if (!a || !a.adId) return { status: 'unmatched', adAccountId: null }
  if (lookup.local && accounts.includes(lookup.local)) return { status: 'matched', adAccountId: lookup.local }
  if (lookup.cached) {
    if (!lookup.cached.outside && lookup.cached.adAccountId && accounts.includes(lookup.cached.adAccountId)) {
      return { status: 'matched', adAccountId: lookup.cached.adAccountId }
    }
    if (lookup.cached.final === false) return { status: 'pending', adAccountId: null }
    return { status: 'outside', adAccountId: null }
  }
  if (lookup.probe === null) return { status: 'pending', adAccountId: null }
  return lookup.probe === 'allowed' ? { status: 'matched', adAccountId: accounts[0] ?? null } : { status: 'outside', adAccountId: null }
}

/** Accounts + ownership source for this workspace's current mode, unless the caller passed them. */
async function resolveTouchScope(
  orgId: string,
  o: { accounts?: string[]; source?: AdsSource | null; limit?: number; probes?: number },
): Promise<{ accounts: string[]; source: AdsSource | null; limit?: number; probes?: number }> {
  if (o.accounts && o.source !== undefined) return { ...o, accounts: o.accounts, source: o.source }
  const { resolveAdsConfig } = await import('./config')
  const config = await resolveAdsConfig(orgId)
  const accounts = o.accounts ?? (config.mode === 'not_connected' ? [] : config.accounts)
  let source = o.source ?? null
  if (o.source === undefined && accounts.length) {
    const { adsSourceFor } = await import('./sync')
    source = await adsSourceFor(orgId)
  }
  return { ...o, accounts, source }
}

type LeadRow = { id: string; createdAt: Date; leadAttribution: unknown }

/**
 * Leads in one table whose stored attribution is Meta's and whose leadgen id
 * has no settled touch. The leadgen id is compared the way
 * parseStoredAttribution reads it (trimmed, at most 100 characters). The table
 * name comes from a fixed list, never from input.
 */
function unsettledMetaLeads(table: 'Client' | 'CallCenterLead', orgId: string, limit: number): Promise<LeadRow[]> {
  const from = Prisma.raw(table === 'Client' ? '"Client"' : '"CallCenterLead"')
  return db.$queryRaw<LeadRow[]>`
    SELECT l."id", l."createdAt", l."leadAttribution"
    FROM ${from} l
    WHERE l."organizationId" = ${orgId}
      AND l."leadAttribution"->>'provider' = 'meta'
      AND nullif(btrim(l."leadAttribution"->>'leadgenId'), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "MetaLeadTouch" t
        WHERE t."organizationId" = l."organizationId"
          AND t."leadgenId" = left(btrim(l."leadAttribution"->>'leadgenId'), 100)
          AND t."status" <> 'pending'
      )
    ORDER BY l."createdAt" DESC
    LIMIT ${limit}`
}

type Candidate = { kind: 'client' | 'callCenter'; id: string; createdAt: Date; attribution: ParsedAttribution | null; raw: unknown }

export type RebuildResult = { scanned: number; matched: number; outside: number; unmatched: number; pending: number; probed: number }

/**
 * Index leads whose touch is missing or still pending, newest first.
 * `accounts` are the ad accounts this workspace may read in the current mode
 * ([] means do nothing). `source` answers ownership probes, at most `probes`.
 */
export async function rebuildLeadTouches(
  orgId: string,
  options: { accounts?: string[]; source?: AdsSource | null; limit?: number; probes?: number } = {},
): Promise<RebuildResult> {
  const out: RebuildResult = { scanned: 0, matched: 0, outside: 0, unmatched: 0, pending: 0, probed: 0 }
  const opts = await resolveTouchScope(orgId, options)
  if (opts.accounts.length === 0) return out
  const limit = opts.limit ?? 200
  let probesLeft = opts.probes ?? 50

  // Candidates are picked in the database: Meta leads with no settled touch
  // (none yet, or still pending), newest first, at most `limit` per table. The
  // work per run stays bounded however many leads have been settled before.
  const [clients, ccLeads] = await Promise.all([unsettledMetaLeads('Client', orgId, limit), unsettledMetaLeads('CallCenterLead', orgId, limit)])

  const candidates: Candidate[] = [
    ...clients.map((c) => ({ kind: 'client' as const, id: c.id, createdAt: c.createdAt, raw: c.leadAttribution, attribution: parseStoredAttribution(c.leadAttribution) })),
    ...ccLeads.map((c) => ({ kind: 'callCenter' as const, id: c.id, createdAt: c.createdAt, raw: c.leadAttribution, attribution: parseStoredAttribution(c.leadAttribution) })),
  ]
    .filter((c) => c.attribution)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit)

  const adIds = [...new Set(candidates.map((c) => c.attribution!.adId).filter((x): x is string => Boolean(x)))]
  const [localAds, cached] = await Promise.all([
    adIds.length
      ? db.metaAd.findMany({ where: { organizationId: orgId, externalId: { in: adIds }, adAccountId: { in: opts.accounts } }, select: { externalId: true, adAccountId: true } })
      : Promise.resolve([]),
    adIds.length
      ? db.metaObjectAccount.findMany({ where: { objectId: { in: adIds } }, select: { objectId: true, outside: true, adAccountId: true, reason: true, checkedAt: true } })
      : Promise.resolve([]),
  ])
  const localBy = new Map(localAds.map((a) => [a.externalId, a.adAccountId]))
  const cacheBy = new Map(cached.map((c) => [c.objectId, { outside: c.outside, adAccountId: c.adAccountId, reason: c.reason, checkedAt: c.checkedAt }]))
  const nowMs = Date.now()

  for (const c of candidates) {
    const a = c.attribution!
    out.scanned++
    let probe: Ownership | null = null
    const adId = a.adId
    const leadAt = (a.capturedAt ?? c.createdAt).getTime()
    const givenUp = nowMs - leadAt >= TOUCH_GIVE_UP_MS
    const hit = adId ? cacheBy.get(adId) : undefined
    const retry = Boolean(hit && TENTATIVE.has(hit.reason) && !givenUp && nowMs - hit.checkedAt.getTime() >= TOUCH_RETRY_MS)
    if (adId && !localBy.has(adId) && (!hit || retry) && probesLeft > 0 && opts.source) {
      probesLeft--
      try {
        probe = await opts.source.ownership(adId)
        out.probed++
        const allowed = probe === 'allowed'
        const row = { adAccountId: allowed ? opts.source.adAccountId : null, outside: !allowed, reason: probe, checkedAt: new Date() }
        await db.metaObjectAccount.upsert({ where: { objectId: adId }, create: { objectId: adId, ...row }, update: row })
        cacheBy.set(adId, { outside: row.outside, adAccountId: row.adAccountId, reason: row.reason, checkedAt: row.checkedAt })
        probe = null // the cache now answers
      } catch (e) {
        // Only a temporary Meta problem keeps the lead pending for the next run.
        // A usage stop, rate, token or block error ends the run, so the sync
        // records the back-off instead of firing the remaining probes.
        if (!(e instanceof MetaGraphError) || !['transient', 'other'].includes(e.kind)) throw e
        probe = null
      }
    }
    const owner = adId ? cacheBy.get(adId) : undefined
    const cachedOwner = owner ? { outside: owner.outside, adAccountId: owner.adAccountId, final: !TENTATIVE.has(owner.reason) || givenUp } : null
    const verdict = classifyTouch(a, { local: adId ? localBy.get(adId) ?? null : null, cached: cachedOwner, probe }, opts.accounts)
    out[verdict.status]++

    const matched = verdict.status === 'matched'
    const data = {
      adAccountId: matched ? verdict.adAccountId : null,
      adId: matched ? a.adId : null,
      adSetId: matched ? a.adsetId : null,
      campaignId: matched ? a.campaignId : null,
      formId: matched ? a.formId : null,
      platform: a.platform,
      isOrganic: a.isOrganic,
      status: verdict.status,
      leadCreatedAt: a.capturedAt ?? c.createdAt,
      checkedAt: new Date(),
      ...(c.kind === 'client' ? { clientId: c.id } : { callCenterLeadId: c.id }),
    }
    await db.metaLeadTouch.upsert({
      where: { organizationId_leadgenId: { organizationId: orgId, leadgenId: a.leadgenId } },
      create: { organizationId: orgId, leadgenId: a.leadgenId, ...data },
      update: data,
    })
  }

  const outside = await db.metaLeadTouch.count({ where: { organizationId: orgId, status: 'outside' } })
  await db.metaAdAccount.updateMany({ where: { organizationId: orgId, adAccountId: { in: opts.accounts } }, data: { outsideLeadCount: outside } })
  return out
}

/**
 * "Re-match leads to ads": everything not matched goes back to pending, and
 * every ownership answer that could have been temporary (no access, not found)
 * is forgotten so the ad is asked about again. A proven other-account answer
 * stays cached.
 */
export async function resetUnmatchedTouches(orgId: string): Promise<number> {
  const r = await db.metaLeadTouch.updateMany({
    where: { organizationId: orgId, status: { in: ['outside', 'unmatched'] } },
    data: { status: 'pending' },
  })
  await db.metaObjectAccount.deleteMany({ where: { reason: { in: [...TENTATIVE] } } })
  return r.count
}
