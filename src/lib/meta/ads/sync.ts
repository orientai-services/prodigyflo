import 'server-only'
import { randomUUID } from 'node:crypto'
import { Prisma, type MetaInsightLevel, type MetaInsightWindow } from '@prisma/client'
import { db } from '@/lib/db'
import {
  AdAccountNotAllowedError, adsBinding, auditRefusal, isBoundOrg, normalizeAdAccountId, refFor,
} from './allowlist'
import { resolveAdsConfig, type AdsConfig } from './config'
import { MetaGraphError, PLAIN, type GraphErrorKind, type UsageSnapshot } from './graph-client'
import {
  GraphAdsSource, MockAdsSource, ADS_WINDOWS, targetsNarrow, targetsWide, type AdsSource, type AdsWindow, type RawAccount,
} from './source'
import { minorToCents, minorToMajor, sumsFromInsight, accountStatusWords, type RawInsight } from './metrics'
import { parsePending, stepChargeDetector, type Reading } from './billing'
import { summarizeCreative } from './creative'
import { addDays, closedCycleSpend, dayInZone, excludedFromHours } from './cycle'
import { rebuildLeadTouches } from './touches'

/**
 * Graph → database (docs/META_ADS_SCS.md §3.3). Pages never call Graph; this is
 * the only writer. Every step runs under a per-account lease, every row carries
 * its adAccountId, and nothing here ever touches Connector.status (that drives
 * lead intake).
 */

type Env = Record<string, string | undefined>

export const WINDOW_ENUM: Record<AdsWindow, MetaInsightWindow> = {
  today: 'TODAY', '7d': 'LAST_7D', '30d': 'LAST_30D', month: 'THIS_MONTH', max: 'MAXIMUM',
}

const LEASE_MS = 280_000
const SNAPSHOT_KEEP_DAYS = 120
const USAGE_STOP_PCT = 75
const CONNECTION_CHECK_MS = 24 * 3_600_000

export function fullSyncMinutes(env: Env = process.env): number {
  const n = Number(env.META_SYNC_FULL_MINUTES)
  return Number.isFinite(n) && n >= 1 && n <= 24 * 60 ? Math.floor(n) : 30
}

export function defaultCycleDays(env: Env = process.env): number {
  const n = Number(env.META_ADS_CYCLE_DAYS)
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : 15
}

export function writesEnabled(env: Env = process.env): boolean {
  return env.META_ADS_WRITES_ENABLED === 'true'
}

/** Meta's usage headers say stop: throttled now, or at/over the threshold. */
export function shouldStopForUsage(u: UsageSnapshot): boolean {
  return u.maxPct >= USAGE_STOP_PCT || u.regainSeconds > 0
}

/** How long to wait after a usage stop: at least 15 minutes, longer when Meta says so. */
export function usageBackoffMs(u: UsageSnapshot): number {
  return Math.max(15 * 60_000, u.regainSeconds * 1000, (u.resetSeconds ?? 0) * 1000)
}

/** Thrown from onUsage when Meta's usage headers say stop. Stops mid-step. */
class UsageStop extends Error {
  constructor(readonly usage: UsageSnapshot) {
    super('usage')
  }
}

export type SyncOptions = {
  force?: boolean
  manual?: boolean
  recheck?: boolean
  now?: Date
  /** Test seam: the fetch used by the Graph client. */
  fetchImpl?: typeof fetch
  env?: Env
}

export type SyncResult =
  | { skipped: 'not_connected' | 'busy' | 'backoff' | 'refused'; adAccountId?: string }
  | {
      adAccountId: string
      mode: 'live' | 'mock'
      snapshot: 'ok' | 'stale' | 'skipped'
      billing: string
      full: boolean
      touches: { matched: number; outside: number; unmatched: number; pending: number } | null
      error?: { kind: GraphErrorKind }
    }

// ── Entry points ───────────────────────────────────────────────────────────────

/** The cron: only the bound workspace, only allowlisted accounts, within a time budget. */
export async function syncAllOrgs(opts: { budgetMs?: number; fetchImpl?: typeof fetch; env?: Env } = {}) {
  const env = opts.env ?? process.env
  const binding = adsBinding(env)
  if (!binding) return { adAccounts: 0, partial: false, reason: 'not_configured' as const }
  const started = Date.now()
  const budget = opts.budgetMs ?? 240_000
  const config = await resolveAdsConfig(binding.orgId, env)
  if (config.mode !== 'live') return { adAccounts: 0, partial: false, reason: config.mode }
  let done = 0
  let partial = false
  const counts = { ok: 0, busy: 0, errors: 0 }
  for (const account of config.accounts) {
    if (Date.now() - started > budget) {
      partial = true
      break
    }
    const r = await syncAccount(binding.orgId, account, config, { fetchImpl: opts.fetchImpl, env })
    done++
    if ('skipped' in r) counts.busy++
    else if (r.error) counts.errors++
    else counts.ok++
  }
  return { adAccounts: done, partial, ...counts }
}

/** One workspace (the bound one, or any workspace in mock mode). */
export async function syncAdsForOrg(orgId: string, opts: SyncOptions = {}): Promise<SyncResult[]> {
  const env = opts.env ?? process.env
  const config = await resolveAdsConfig(orgId, env)
  if (config.mode === 'not_connected') return [{ skipped: 'not_connected' }]
  const out: SyncResult[] = []
  for (const account of config.accounts) out.push(await syncAccount(orgId, account, config, opts))
  return out
}

function sourceFor(orgId: string, account: string, config: AdsConfig, acct: { tokenAppId: string | null }, opts: SyncOptions, onUsage: (u: UsageSnapshot) => void): AdsSource {
  if (config.mode === 'mock') return new MockAdsSource(orgId, opts.now ? () => opts.now! : undefined)
  const c = config.creds!
  return new GraphAdsSource(account, {
    orgId, token: c.token, appId: c.appId, appSecret: c.appSecret, tokenAppId: acct.tokenAppId,
    fetchImpl: opts.fetchImpl, env: opts.env, onUsage, writesEnabled: writesEnabled(opts.env),
  })
}

/** Find or create the account row; refuse when another workspace holds it. */
async function ensureAccountRow(orgId: string, account: string, env: Env) {
  const existing = await db.metaAdAccount.findUnique({ where: { adAccountId: account } })
  if (existing) {
    if (existing.organizationId !== orgId) {
      await auditRefusal(orgId, refFor(account), 'unbound_org', 'sync.account_row')
      return null
    }
    return existing
  }
  try {
    return await db.metaAdAccount.create({ data: { organizationId: orgId, adAccountId: account, cycleDays: defaultCycleDays(env) } })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const raced = await db.metaAdAccount.findUnique({ where: { adAccountId: account } })
      return raced && raced.organizationId === orgId ? raced : null
    }
    throw e
  }
}

async function syncAccount(orgId: string, account: string, config: AdsConfig, opts: SyncOptions): Promise<SyncResult> {
  const env = opts.env ?? process.env
  // Live accounts must be allowlisted AND the workspace bound (belt and braces:
  // resolveAdsConfig already guarantees this).
  if (config.mode === 'live') {
    const n = normalizeAdAccountId(account)
    if (!n || !isBoundOrg(orgId, env) || !adsBinding(env)!.accounts.has(n)) {
      await auditRefusal(orgId, refFor(account), 'not_allowlisted', 'sync.account')
      return { skipped: 'refused' }
    }
  }
  const acct = await ensureAccountRow(orgId, account, env)
  if (!acct) return { skipped: 'refused' }

  const now = opts.now ?? new Date()
  const owner = randomUUID()
  const lease = await db.metaAdAccount.updateMany({
    where: { id: acct.id, OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }] },
    data: { syncLeaseUntil: new Date(now.getTime() + LEASE_MS), syncLeaseOwner: owner },
  })
  if (lease.count === 0) return { skipped: 'busy', adAccountId: account }

  let usage: UsageSnapshot | null = null
  // Stop only when Meta says calls are throttled (a regain time) or usage is
  // high. reset_time_duration alone is normal after any call and never stops.
  const onUsage = (u: UsageSnapshot) => {
    usage = u
    if (shouldStopForUsage(u)) throw new UsageStop(u)
  }

  const result: Extract<SyncResult, { adAccountId: string; mode: string }> = {
    adAccountId: account, mode: config.mode === 'mock' ? 'mock' : 'live', snapshot: 'skipped', billing: 'none', full: false, touches: null,
  }
  try {
    if (acct.backoffUntil && acct.backoffUntil > now) return { skipped: 'backoff', adAccountId: account }
    const source = sourceFor(orgId, account, config, acct, opts, onUsage)

    // 4. Snapshot (every run, one Graph call).
    const snap = await snapshotStep(orgId, acct.id, account, source, now)
    result.snapshot = snap.stale ? 'stale' : 'ok'
    result.billing = snap.billing

    // 5. Full sync.
    const fresh = await db.metaAdAccount.findUniqueOrThrow({ where: { id: acct.id } })
    const due = !fresh.lastFullSyncAt || now.getTime() - fresh.lastFullSyncAt.getTime() >= fullSyncMinutes(env) * 60_000
    if ((opts.force || due) && (fresh.lastUsagePct ?? 0) < USAGE_STOP_PCT) {
      await fullSync(orgId, fresh, source, now)
      result.full = true
    }

    // 6. Lead touches.
    const t = await rebuildLeadTouches(orgId, { accounts: [account], source, limit: 200, probes: 50 })
    result.touches = { matched: t.matched, outside: t.outside, unmatched: t.unmatched, pending: t.pending }

    // 7. Connection check (daily, on Re-check, and right after a token error:
    // a run that got this far means the token works again).
    const checkDue = opts.recheck || fresh.lastErrorKind === 'token' || fresh.tokenValid === false ||
      !fresh.lastConnectionCheckAt || now.getTime() - fresh.lastConnectionCheckAt.getTime() >= CONNECTION_CHECK_MS
    if (checkDue) await connectionCheck(orgId, acct.id, source, now)

    await db.metaAdAccount.update({
      where: { id: acct.id },
      data: { lastErrorKind: null, lastError: null, lastUsagePct: usage ? (usage as UsageSnapshot).maxPct : fresh.lastUsagePct },
    })
    return result
  } catch (e) {
    const kind = await recordSyncError(orgId, acct.id, e, now)
    result.error = { kind }
    return result
  } finally {
    await db.metaAdAccount.updateMany({ where: { id: acct.id, syncLeaseOwner: owner }, data: { syncLeaseUntil: null, syncLeaseOwner: null } })
  }
}

// ── Errors ─────────────────────────────────────────────────────────────────────

async function recordSyncError(orgId: string, acctId: string, e: unknown, now: Date): Promise<GraphErrorKind> {
  let kind: GraphErrorKind = 'other'
  let plain: string = PLAIN.other
  let code: number | undefined
  let subcode: number | undefined
  const data: Prisma.MetaAdAccountUpdateInput = {}
  if (e instanceof UsageStop) {
    kind = 'rate'
    const until = new Date(now.getTime() + usageBackoffMs(e.usage))
    // '{time}' stays in the stored text; the page fills it in the viewer's format.
    plain = PLAIN.rate
    data.backoffUntil = until
    data.lastUsagePct = e.usage.maxPct
  } else if (e instanceof MetaGraphError) {
    kind = e.kind
    plain = e.plain
    code = e.code
    subcode = e.subcode
    if (kind === 'rate' || kind === 'blocked') {
      const until = new Date(now.getTime() + (kind === 'blocked' ? 60 : 15) * 60_000)
      data.backoffUntil = until
      if (kind === 'rate') plain = PLAIN.rate
    }
    if (kind === 'token') data.tokenValid = false
  } else if (e instanceof AdAccountNotAllowedError) {
    kind = 'config'
    plain = e.message
  }
  data.lastErrorKind = kind
  data.lastError = plain
  data.lastErrorAt = now
  await db.metaAdAccount.update({ where: { id: acctId }, data })
  const connector = await db.connector.findUnique({ where: { organizationId_kind: { organizationId: orgId, kind: 'META_ADS' } }, select: { id: true } })
  if (connector) {
    await db.connectorLog.create({
      data: { connectorId: connector.id, level: 'error', event: 'meta.ads.sync.error', detail: { kind, code: code ?? null, subcode: subcode ?? null, plain } },
    })
  }
  return kind
}

// ── Snapshot + billing ─────────────────────────────────────────────────────────

async function notifyAdmins(orgId: string, title: string, body: string) {
  const admins = await db.user.findMany({
    where: { organizationId: orgId, isActive: true, deletedAt: null, role: { key: 'SUPER_ADMIN' } },
    select: { id: true },
  })
  if (admins.length === 0) return
  await db.notification.createMany({
    data: admins.map((u) => ({ organizationId: orgId, userId: u.id, kind: 'SYSTEM' as const, title, body, href: '/call-center?tab=ads&view=billing' })),
  })
}

async function snapshotStep(orgId: string, acctId: string, account: string, source: AdsSource, now: Date): Promise<{ stale: boolean; billing: string }> {
  const raw: RawAccount = await source.account()
  const acct = await db.metaAdAccount.findUniqueOrThrow({ where: { id: acctId } })
  const balance = minorToCents(raw.balance)
  const spent = minorToCents(raw.amount_spent)
  const cap = minorToCents(raw.spend_cap)
  const fundingDisplay = raw.funding_source_details?.display_string?.slice(0, 80) ?? null
  const fundingType = typeof raw.funding_source_details?.type === 'number' ? raw.funding_source_details.type : null
  const status = typeof raw.account_status === 'number' ? raw.account_status : null
  // amount_spent never goes backwards on a real account, so a lower reading is
  // a stale replica... unless the owner reset the spending limit, which drops
  // it to near 0 for good. Accept the lower value as the new baseline when the
  // spend cap changed with it, or when RESET_AGREE readings in a row agree.
  let stale = acct.amountSpentCents !== null && spent !== null && spent < acct.amountSpentCents
  let rebased = false
  if (stale) {
    const capChanged = cap !== null && acct.spendCapCents !== null && cap !== acct.spendCapCents
    const recent = await db.metaAccountSnapshot.findMany({
      where: { organizationId: orgId, adAccountId: account, takenAt: { lte: now } },
      orderBy: { takenAt: 'desc' },
      take: RESET_AGREE - 1,
      select: { stale: true, amountSpentCents: true },
    })
    if (capChanged || readingsAgreeOnReset(recent, spent!, acct.amountSpentCents!)) {
      stale = false
      rebased = true
    }
  }

  const snapshot = await db.metaAccountSnapshot.create({
    data: {
      organizationId: orgId, adAccountId: account, takenAt: now, balanceCents: balance, amountSpentCents: spent,
      spendCapCents: cap, accountStatus: status, fundingDisplay, fundingType, stale,
    },
  })
  await db.metaAccountSnapshot.deleteMany({
    where: { organizationId: orgId, adAccountId: account, takenAt: { lt: new Date(now.getTime() - SNAPSHOT_KEEP_DAYS * 86_400_000) } },
  })

  if (stale) {
    await db.metaAdAccount.update({ where: { id: acctId }, data: { lastSnapshotAt: now } })
    return { stale: true, billing: 'stale' }
  }

  const prevSnap = await db.metaAccountSnapshot.findFirst({
    where: { organizationId: orgId, adAccountId: account, stale: false, id: { not: snapshot.id }, takenAt: { lte: now } },
    orderBy: { takenAt: 'desc' },
  })
  const reading = (s: { id: string; balanceCents: bigint | null; amountSpentCents: bigint | null; fundingType: number | null; takenAt: Date }): Reading | null =>
    s.balanceCents === null || s.amountSpentCents === null
      ? null
      : { snapshotId: s.id, balanceCents: Number(s.balanceCents), amountSpentCents: Number(s.amountSpentCents), fundingType: s.fundingType, at: s.takenAt }
  const r = reading(snapshot)
  // After a spending-limit reset the detector starts over from this reading.
  const prev = prevSnap && !rebased ? reading(prevSnap) : null
  const pendingBefore = rebased ? null : parsePending(acct.pendingCharge)
  const step = r ? stepChargeDetector(prev, pendingBefore, r) : { pending: pendingBefore, emit: null, event: 'none' as const }

  const saved = await db.metaAdAccount.updateMany({
    where: { id: acctId, billingVersion: acct.billingVersion },
    data: {
      billingVersion: acct.billingVersion + 1,
      pendingCharge: step.pending ? (step.pending as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      name: raw.name?.slice(0, 200) ?? acct.name,
      currency: raw.currency ?? acct.currency,
      timezoneName: raw.timezone_name ?? acct.timezoneName,
      accountStatus: status,
      disableReason: typeof raw.disable_reason === 'number' ? raw.disable_reason : null,
      balanceCents: balance,
      amountSpentCents: spent,
      spendCapCents: cap,
      fundingDisplay,
      fundingType,
      lastReadingAt: now,
      lastSnapshotAt: now,
    },
  })
  // Someone else advanced the detector: this run's billing step is dropped.
  if (saved.count === 0) return { stale: false, billing: 'lost_race' }

  const events: Prisma.MetaBillingEventCreateManyInput[] = []
  if (step.emit) {
    events.push({
      organizationId: orgId, adAccountId: account, kind: 'PAYMENT', occurredAt: new Date(step.emit.occurredAt),
      fromSnapshotId: step.emit.fromSnapshotId, amountCents: BigInt(step.emit.amountCents), approximate: true,
    })
  }
  if (acct.accountStatus !== null && status !== null && status !== acct.accountStatus) {
    const before = accountStatusWords(acct.accountStatus).words
    const after = accountStatusWords(status).words
    events.push({ organizationId: orgId, adAccountId: account, kind: 'STATUS_CHANGE', occurredAt: now, fromSnapshotId: snapshot.id, before, after, approximate: false })
    await notifyAdmins(orgId, 'Meta ad account status changed', `Status changed: ${before} → ${after}.`)
  }
  if (acct.fundingDisplay && fundingDisplay && fundingDisplay !== acct.fundingDisplay) {
    events.push({ organizationId: orgId, adAccountId: account, kind: 'CARD_CHANGE', occurredAt: now, fromSnapshotId: snapshot.id, before: acct.fundingDisplay, after: fundingDisplay, approximate: false })
  }
  if (events.length) await db.metaBillingEvent.createMany({ data: events, skipDuplicates: true })
  return { stale: false, billing: rebased ? 'rebased' : step.event }
}

/** Readings needed in a row before a lower amount_spent is a new baseline, not a stale replica. */
export const RESET_AGREE = 3

/**
 * The RESET_AGREE - 1 readings before this one (newest first) were all stale,
 * all below the stored baseline, and together with this one never go down.
 * A single stale-replica flap never passes.
 */
export function readingsAgreeOnReset(
  recentNewestFirst: { stale: boolean; amountSpentCents: bigint | null }[],
  spent: bigint,
  baseline: bigint,
): boolean {
  if (recentNewestFirst.length < RESET_AGREE - 1) return false
  const series: bigint[] = []
  for (const s of [...recentNewestFirst].reverse()) {
    if (!s.stale || s.amountSpentCents === null || s.amountSpentCents >= baseline) return false
    series.push(s.amountSpentCents)
  }
  series.push(spent)
  for (let i = 1; i < series.length; i++) if (series[i] < series[i - 1]) return false
  return true
}

// ── Full sync ──────────────────────────────────────────────────────────────────

const statusWord = (s: string | undefined) => (s === 'ACTIVE' ? 'active' : 'paused')
const dateOrNull = (v: string | undefined) => {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}
const dayDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

async function fullSync(
  orgId: string,
  acct: { id: string; adAccountId: string; currency: string; timezoneName: string | null },
  source: AdsSource,
  now: Date,
) {
  const account = acct.adAccountId
  const cur = acct.currency || 'USD'
  let truncated = false
  const mustBeOurs = (rowAccount: string | undefined) => {
    const n = rowAccount ? (rowAccount.startsWith('act_mock_') ? rowAccount : normalizeAdAccountId(rowAccount)) : null
    return n === account
  }

  // Campaigns.
  const campaigns = await source.campaigns()
  truncated ||= campaigns.truncated
  const campaignLocal = new Map<string, string>()
  for (const c of campaigns.rows) {
    if (!mustBeOurs(c.account_id)) continue
    const data = {
      name: (c.name ?? c.id).slice(0, 300),
      status: statusWord(c.status),
      effectiveStatus: c.effective_status ?? null,
      objective: c.objective ?? null,
      budget: minorToMajor(c.daily_budget, cur),
      lifetimeBudget: minorToMajor(c.lifetime_budget, cur),
      metaCreatedAt: dateOrNull(c.created_time),
      adAccountId: account,
    }
    // Under the lease; always update the oldest row so pre-existing duplicates converge.
    const existing = await db.campaign.findFirst({ where: { organizationId: orgId, channel: 'meta', externalId: c.id }, orderBy: { createdAt: 'asc' }, select: { id: true } })
    const local = existing
      ? await db.campaign.update({ where: { id: existing.id }, data, select: { id: true } })
      : await db.campaign.create({ data: { organizationId: orgId, channel: 'meta', externalId: c.id, ...data }, select: { id: true } })
    campaignLocal.set(c.id, local.id)
  }
  if (!campaigns.truncated) {
    await db.campaign.updateMany({
      where: { organizationId: orgId, channel: 'meta', adAccountId: account, externalId: { notIn: [...campaignLocal.keys()] } },
      data: { effectiveStatus: 'DELETED' },
    })
  }

  // Ad sets.
  const adSets = await source.adSets()
  truncated ||= adSets.truncated
  const adSetLocal = new Map<string, string>()
  for (const s of adSets.rows) {
    if (!mustBeOurs(s.account_id)) continue
    const campaignId = s.campaign_id ? campaignLocal.get(s.campaign_id) : undefined
    if (!campaignId) continue
    const data = {
      campaignId,
      name: (s.name ?? s.id).slice(0, 300),
      status: statusWord(s.status),
      effectiveStatus: s.effective_status ?? null,
      dailyBudget: minorToMajor(s.daily_budget, cur),
      lifetimeBudget: minorToMajor(s.lifetime_budget, cur),
      optimizationGoal: s.optimization_goal ?? null,
      adAccountId: account,
    }
    const row = await db.adSet.upsert({
      where: { organizationId_externalId: { organizationId: orgId, externalId: s.id } },
      create: { organizationId: orgId, externalId: s.id, ...data },
      update: data,
      select: { id: true },
    })
    adSetLocal.set(s.id, row.id)
  }
  if (!adSets.truncated) {
    await db.adSet.updateMany({
      where: { organizationId: orgId, adAccountId: account, externalId: { notIn: [...adSetLocal.keys()] } },
      data: { effectiveStatus: 'DELETED' },
    })
  }

  // Ads (never hard-deleted; thumbnails refresh every full sync).
  const ads = await source.ads()
  truncated ||= ads.truncated
  const seenAds: string[] = []
  for (const a of ads.rows) {
    if (!mustBeOurs(a.account_id)) continue
    const campaignId = a.campaign_id ? campaignLocal.get(a.campaign_id) : undefined
    if (!campaignId) continue
    const cr = summarizeCreative(a.creative)
    const data = {
      adAccountId: account,
      campaignId,
      adSetId: a.adset_id ? adSetLocal.get(a.adset_id) ?? null : null,
      name: (a.name ?? a.id).slice(0, 300),
      status: a.status ?? 'UNKNOWN',
      effectiveStatus: a.effective_status ?? null,
      removed: false,
      thumbnailUrl: cr.thumbnailUrl,
      headline: cr.headline,
      body: cr.body,
      cta: cr.cta,
      linkUrl: cr.linkUrl,
      metaCreatedAt: dateOrNull(a.created_time),
      syncedAt: now,
    }
    await db.metaAd.upsert({
      where: { organizationId_externalId: { organizationId: orgId, externalId: a.id } },
      create: { organizationId: orgId, externalId: a.id, ...data },
      update: data,
    })
    seenAds.push(a.id)
  }
  if (!ads.truncated) {
    await db.metaAd.updateMany({
      where: { organizationId: orgId, adAccountId: account, externalId: { notIn: seenAds } },
      data: { removed: true },
    })
  }

  // Window insights: account and ad level, five windows.
  for (const w of ADS_WINDOWS) {
    const win = WINDOW_ENUM[w]
    const acctIns = await source.windowInsights('account', w)
    const accountRow = acctIns.rows.find((r) => mustBeOurs(r.account_id)) ?? null
    const adIns = await source.windowInsights('ad', w)
    truncated ||= adIns.truncated
    await upsertSummary(orgId, account, 'ACCOUNT', account, win, accountRow ?? {}, adIns.partial)

    const level: MetaInsightLevel = adIns.level === 'campaign' ? 'CAMPAIGN' : 'AD'
    const ids: string[] = []
    for (const r of adIns.rows) {
      if (!mustBeOurs(r.account_id)) continue
      const id = level === 'AD' ? r.ad_id : r.campaign_id
      if (!id) continue
      ids.push(id)
      await upsertSummary(orgId, account, level, id, win, r, adIns.partial)
    }
    if (!adIns.truncated) {
      // Objects with nothing in this window must not keep last sync's numbers.
      await db.metaInsightSummary.deleteMany({ where: { organizationId: orgId, adAccountId: account, level, window: win, objectId: { notIn: ids } } })
      if (level === 'CAMPAIGN') {
        await db.metaInsightSummary.deleteMany({ where: { organizationId: orgId, adAccountId: account, level: 'AD', window: win } })
      }
    }
  }

  // Daily: account level for 90 days incl. today; campaign level for 30 days.
  const tz = (await db.metaAdAccount.findUnique({ where: { id: acct.id }, select: { timezoneName: true } }))?.timezoneName ?? acct.timezoneName
  const today = dayInZone(now, tz)
  const accDaily = await source.daily('account', addDays(today, -90), today)
  truncated ||= accDaily.truncated
  for (const r of accDaily.rows) {
    if (!mustBeOurs(r.account_id) || !r.date_start) continue
    await upsertDaily(orgId, account, 'ACCOUNT', account, r.date_start, r)
  }
  const campDaily = await source.daily('campaign', addDays(today, -30), today)
  truncated ||= campDaily.truncated
  for (const r of campDaily.rows) {
    if (!mustBeOurs(r.account_id) || !r.date_start || !r.campaign_id) continue
    await upsertDaily(orgId, account, 'CAMPAIGN', r.campaign_id, r.date_start, r)
    const localId = campaignLocal.get(r.campaign_id)
    if (!localId) continue
    const s = sumsFromInsight(r)
    const date = dayDate(r.date_start)
    await db.campaignDailyStat.upsert({
      where: { campaignId_date: { campaignId: localId, date } },
      create: { campaignId: localId, adSetId: null, date, spend: s.spend, impressions: s.impressions, clicks: s.clicks, leads: s.leads },
      update: { spend: s.spend, impressions: s.impressions, clicks: s.clicks, leads: s.leads, adSetId: null },
    })
  }

  // Campaign lifetime totals from the persisted daily series (as before); ad set spend from ad-level MAXIMUM.
  for (const localId of campaignLocal.values()) {
    const t = await db.campaignDailyStat.aggregate({ where: { campaignId: localId }, _sum: { spend: true, impressions: true, clicks: true } })
    await db.campaign.update({ where: { id: localId }, data: { spend: t._sum.spend ?? 0, impressions: t._sum.impressions ?? 0, clicks: t._sum.clicks ?? 0 } })
  }
  const maxAds = await db.metaInsightSummary.findMany({ where: { organizationId: orgId, adAccountId: account, level: 'AD', window: 'MAXIMUM' }, select: { objectId: true, spend: true } })
  if (maxAds.length) {
    const adToSet = new Map((await db.metaAd.findMany({ where: { organizationId: orgId, adAccountId: account }, select: { externalId: true, adSetId: true } })).map((a) => [a.externalId, a.adSetId]))
    const bySet = new Map<string, number>()
    for (const r of maxAds) {
      const setId = adToSet.get(r.objectId)
      if (setId) bySet.set(setId, (bySet.get(setId) ?? 0) + Number(r.spend))
    }
    for (const [setId, spend] of bySet) await db.adSet.update({ where: { id: setId }, data: { spend: Math.round(spend * 100) / 100 } })
  }

  await cycleStep(orgId, account, source, tz, now)

  await db.metaAdAccount.update({ where: { id: acct.id }, data: { lastFullSyncAt: now, lastTruncated: truncated } })
}

async function upsertSummary(orgId: string, account: string, level: MetaInsightLevel, objectId: string, window: MetaInsightWindow, r: RawInsight, partial: boolean) {
  const s = sumsFromInsight(r)
  const data = {
    adAccountId: account,
    spend: s.spend, impressions: s.impressions, reach: s.reach ?? 0, clicks: s.clicks, linkClicks: s.linkClicks,
    leads: s.leads, landingPageViews: s.landingPageViews,
    frequency: s.frequency === null || s.frequency === undefined ? null : Math.round(s.frequency * 1000) / 1000,
    dateStart: r.date_start ? dayDate(r.date_start) : null,
    dateStop: r.date_stop ? dayDate(r.date_stop) : null,
    partial,
  }
  await db.metaInsightSummary.upsert({
    where: { organizationId_level_objectId_window: { organizationId: orgId, level, objectId, window } },
    create: { organizationId: orgId, level, objectId, window, ...data },
    update: data,
  })
}

async function upsertDaily(orgId: string, account: string, level: MetaInsightLevel, objectId: string, day: string, r: RawInsight) {
  const s = sumsFromInsight(r)
  const date = dayDate(day)
  const data = {
    adAccountId: account, spend: s.spend, impressions: s.impressions, reach: s.reach ?? 0, clicks: s.clicks,
    linkClicks: s.linkClicks, leads: s.leads, landingPageViews: s.landingPageViews,
  }
  await db.metaInsightDaily.upsert({
    where: { organizationId_level_objectId_date: { organizationId: orgId, level, objectId, date } },
    create: { organizationId: orgId, level, objectId, date, ...data },
    update: data,
  })
}

// ── Cycle ──────────────────────────────────────────────────────────────────────

export async function accountDailySpend(orgId: string, account: string): Promise<{ date: string; spend: number }[]> {
  const rows = await db.metaInsightDaily.findMany({
    where: { organizationId: orgId, adAccountId: account, level: 'ACCOUNT', objectId: account },
    select: { date: true, spend: true },
    orderBy: { date: 'asc' },
  })
  return rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), spend: Number(r.spend) }))
}

/** How long a cycle keeps retrying Meta's hourly breakdown for its start day. */
export const HOURLY_RETRY_MS = 48 * 3_600_000

async function cycleStep(orgId: string, account: string, source: AdsSource, tz: string | null, now: Date) {
  const open = await db.metaSpendCycle.findFirst({ where: { organizationId: orgId, adAccountId: account, endedAt: null }, orderBy: { number: 'desc' } })
  if (open && now.getTime() - open.startedAt.getTime() < HOURLY_RETRY_MS && !open.spendApproximate) {
    const startDay = dayInZone(open.startedAt, tz)
    let hours: { hour: number; spend: number }[] | null | undefined
    try {
      hours = await source.hourly(startDay)
    } catch (e) {
      // A temporary Meta problem: try again on the next full sync (within 48 h).
      // Usage stops, rate, token and permission errors still end this run.
      if (!(e instanceof MetaGraphError) || !['transient', 'other'].includes(e.kind)) throw e
      hours = undefined
    }
    // null = Meta can't break this day down by hour: the cycle is approximate for good.
    if (hours === null) await db.metaSpendCycle.update({ where: { id: open.id }, data: { spendApproximate: true } })
    else if (hours) await db.metaSpendCycle.update({ where: { id: open.id }, data: { startDayExcludedSpend: excludedFromHours(hours, open.startedAt, tz), startDayExcludedAt: now } })
  }
  // Past the retry window without a single hourly answer: the start day's
  // pre-start spend was never taken out, so the total is labelled approximate.
  // Covers a cycle that closed inside the window too.
  await db.metaSpendCycle.updateMany({
    where: {
      organizationId: orgId, adAccountId: account, spendApproximate: false, startDayExcludedAt: null,
      startedAt: { lte: new Date(now.getTime() - HOURLY_RETRY_MS) },
    },
    data: { spendApproximate: true },
  })
  const restating = await db.metaSpendCycle.findMany({ where: { organizationId: orgId, adAccountId: account, endedAt: { not: null }, finalAfter: { gt: now } } })
  if (restating.length === 0) return
  const daily = await accountDailySpend(orgId, account)
  const next = await db.metaSpendCycle.findMany({
    where: { organizationId: orgId, adAccountId: account, number: { in: restating.map((c) => c.number + 1) } },
    select: { number: true, startedAt: true, startDayExcludedSpend: true },
  })
  const nextBy = new Map(next.map((n) => [n.number, n]))
  for (const c of restating) {
    const endDay = dayInZone(new Date(c.endedAt!.getTime() - 1), tz)
    const following = nextBy.get(c.number + 1)
    const spend = closedCycleSpend(daily, dayInZone(c.startedAt, tz), endDay, Number(c.startDayExcludedSpend), following
      ? { startDay: dayInZone(following.startedAt, tz), startDayExcludedSpend: Number(following.startDayExcludedSpend) }
      : null)
    const leads = await db.metaLeadTouch.count({ where: { organizationId: orgId, status: 'matched', adAccountId: account, leadCreatedAt: { gte: c.startedAt, lt: c.endedAt! } } })
    await db.metaSpendCycle.update({ where: { id: c.id }, data: { closedSpend: spend, closedLeads: leads } })
  }
}

// ── Connection check ───────────────────────────────────────────────────────────

async function connectionCheck(orgId: string, acctId: string, source: AdsSource, now: Date) {
  const { resolveMetaOrg } = await import('@/lib/meta/webhook-context')
  const leadOrg = await resolveMetaOrg().catch(() => null)
  const data: Prisma.MetaAdAccountUpdateInput = { lastConnectionCheckAt: now, leadOrgMatches: leadOrg ? leadOrg.id === orgId : null }
  try {
    const info = await source.tokenInfo()
    const visible = await source.visibleAccounts()
    data.tokenValid = info.valid
    data.tokenAppId = info.appId
    data.tokenType = info.type
    data.tokenExpiresAt = info.expiresAt
    data.tokenScopes = info.scopes.slice(0, 50)
    // A system user's missing target list is "not reported", judged by me/adaccounts.
    data.tokenSeesOthers = visible.othersVisible || targetsWide(info.adsRead) || targetsWide(info.adsManagement)
    data.tokenTargetsOk = targetsNarrow(info.adsRead, visible)
  } catch (e) {
    if (e instanceof MetaGraphError && e.kind === 'token') data.tokenValid = false
    else if (!(e instanceof UsageStop)) {
      await db.metaAdAccount.update({ where: { id: acctId }, data })
      throw e
    } else throw e
  }
  await db.metaAdAccount.update({ where: { id: acctId }, data })
}

// ── Writes (off by default) ────────────────────────────────────────────────────

/**
 * A write may touch only an object that is proven to live in an allowlisted
 * account of the bound workspace: a local synced row, or else an ownership
 * probe. Anything else is refused and audited.
 */
export async function assertWritableObject(orgId: string, externalId: string, opts: { source?: AdsSource; env?: Env } = {}): Promise<void> {
  const env = opts.env ?? process.env
  const ref = refFor(externalId)
  if (!writesEnabled(env)) {
    throw new AdAccountNotAllowedError(ref, 'route')
  }
  const binding = adsBinding(env)
  if (!binding || binding.orgId !== orgId) {
    await auditRefusal(orgId, ref, 'unbound_org', 'write')
    throw new AdAccountNotAllowedError(ref, binding ? 'unbound_org' : 'not_bound')
  }
  const accounts = [...binding.accounts]
  const where = { organizationId: orgId, externalId, adAccountId: { in: accounts } }
  const [c, s, a] = await Promise.all([
    db.campaign.findFirst({ where: { ...where, channel: 'meta' }, select: { id: true } }),
    db.adSet.findFirst({ where, select: { id: true } }),
    db.metaAd.findFirst({ where, select: { id: true } }),
  ])
  if (c || s || a) return
  if (opts.source && (await opts.source.ownership(externalId).catch(() => 'no_access' as const)) === 'allowed') return
  await auditRefusal(orgId, ref, 'not_allowlisted', 'write')
  throw new AdAccountNotAllowedError(ref, 'not_allowlisted')
}

/** Source for the bound workspace's first account (for probes outside a sync). */
export async function adsSourceFor(orgId: string, env: Env = process.env): Promise<AdsSource | null> {
  const config = await resolveAdsConfig(orgId, env)
  if (config.mode === 'mock') return new MockAdsSource(orgId)
  if (config.mode !== 'live' || !config.adAccountId) return null
  const acct = await db.metaAdAccount.findUnique({ where: { adAccountId: config.adAccountId }, select: { tokenAppId: true } })
  return sourceFor(orgId, config.adAccountId, config, { tokenAppId: acct?.tokenAppId ?? null }, { env }, () => {})
}
