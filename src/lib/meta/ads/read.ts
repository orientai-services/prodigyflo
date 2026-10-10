import 'server-only'
import { db } from '@/lib/db'
import { can, ForbiddenError, type SessionUser } from '@/lib/rbac'
import { adsBinding, isBoundOrg } from './allowlist'
import { resolveAdsConfig, type AdsConfig } from './config'
import type { GraphErrorKind } from './graph-client'
import {
  accountStatusWords, billingUrl, computeMetrics, fundingTracksPayments, fundingWords, healthFlags, minorToMajor,
  zeroLeadStreak, type Metrics, type MetricSums,
} from './metrics'
import { buildTree, type AdFlags, type AdNode, type AdSetNode, type CampaignNode, type RemainderNode } from './tree'
import { parsePending } from './billing'
import { addDays, cycleSpend, cycleState, dayInZone, zonedMidnight } from './cycle'
import { attributionBroken, buildFunnelRows, type FunnelRange, type FunnelRow, type LeadOutcome } from './funnel'
import { fullSyncMinutes, writesEnabled, WINDOW_ENUM } from './sync'
import type { AdsWindow } from './source'
import type { MetaInsightSummary } from '@prisma/client'

/**
 * The read model behind /marketing/meta (docs/META_ADS_SCS.md §2.5). Reads the
 * database only: no page render ever calls Graph.
 *
 * Every function resolves the workspace's mode first. A workspace that isn't the
 * bound one gets the not_connected shape with empty data and NO query against
 * the ads tables. Every query filters on the workspace AND the ad accounts it
 * may read. BigInt and Decimal never leave this file: numbers out, Dates kept.
 */

export type { Metrics, AdNode, AdSetNode, CampaignNode, RemainderNode, FunnelRange, FunnelRow, AdsWindow, GraphErrorKind }

export function parseAdsWindow(v: string | undefined): AdsWindow {
  return v === 'today' || v === '7d' || v === '30d' || v === 'month' || v === 'max' ? v : '30d'
}

export function parseFunnelRange(v: string | undefined): FunnelRange {
  return v === '7d' || v === '30d' || v === 'all' ? v : '30d'
}

export type AccountCard = {
  adAccountId: string
  name: string
  currency: string
  timezoneName: string | null
  statusCode: number | null
  statusWords: string
  statusTone: 'ok' | 'warn' | 'bad'
  balance: number | null
  amountSpent: number | null
  spendCap: number | null
  card: string | null
  cardType: string | null
  billingUrl: string
}

export type SyncState = {
  mode: 'mock' | 'live' | 'not_connected'
  lastFullSyncAt: Date | null
  lastSnapshotAt: Date | null
  stale: boolean
  error: { kind: GraphErrorKind; plain: string; at: Date } | null
  backoffUntil: Date | null
  partialMax: boolean
}

export type AdsDashboard = {
  account: AccountCard | null
  window: AdsWindow
  totals: Metrics
  counts: { campaigns: number; adSets: number; ads: number; activeAds: number }
  tree: (CampaignNode | RemainderNode)[]
  daily: { date: string; spend: number; leads: number }[]
  sync: SyncState
  writesEnabled: boolean
  canManage: boolean
}

export type BillingView = {
  account: AccountCard
  spend90: { date: string; spend: number }[]
  detector: 'on' | 'off_funding'
  ledger: { id: string; kind: 'PAYMENT' | 'STATUS_CHANGE' | 'CARD_CHANGE'; at: Date; amount: number | null; approximate: boolean; before: string | null; after: string | null }[]
  pending: { amount: number; since: Date } | null
}

export type CycleView = {
  current: { number: number; startedAt: Date; endsAt: Date; day: number; lengthDays: number; overdue: boolean; spend: number; leads: number; cpl: number | null; approximate: boolean } | null
  history: { number: number; startedAt: Date; endedAt: Date; spend: number | null; leads: number | null; final: boolean; finalAfter: Date | null; approximate: boolean }[]
  lengthDays: number
}

export type FunnelView = {
  range: FunnelRange
  rows: FunnelRow[]
  unmatched: number
  outside: number
  pending: number
  attributionBroken: boolean
  leadOrgMatches: boolean | null
}

export type ConnectionView = {
  mode: SyncState['mode']
  boundHere: boolean
  allowlist: { configured: boolean; accounts: { id: string; reachable: boolean | null; name: string | null }[] }
  token: { valid: boolean | null; expiresAt: Date | null; scopes: string[]; type: string | null; appMatches: boolean | null; targetsOk: boolean | null; seesOthers: boolean }
  leadOrgMatches: boolean | null
  lastFullSyncAt: Date | null
  lastSnapshotAt: Date | null
  usagePct: number | null
  backoffUntil: Date | null
  truncated: boolean
  errors: { kind: GraphErrorKind; plain: string; at: Date }[]
  writesEnabled: boolean
}

const EMPTY_SUMS: MetricSums = { spend: 0, impressions: 0, reach: null, clicks: 0, linkClicks: 0, leads: 0, landingPageViews: 0, frequency: null }
const EMPTY_METRICS = computeMetrics(EMPTY_SUMS)

const GRAPH_KINDS: GraphErrorKind[] = ['rate', 'permission', 'token', 'not_found', 'config', 'transient', 'blocked', 'other']
const asKind = (k: string | null | undefined): GraphErrorKind => (GRAPH_KINDS.includes(k as GraphErrorKind) ? (k as GraphErrorKind) : 'other')

function requireRead(user: SessionUser) {
  if (!can(user, 'connectors:read')) throw new ForbiddenError()
}
function requireManage(user: SessionUser) {
  if (!can(user, 'connectors:manage')) throw new ForbiddenError()
}

/** Mode + the one account this view shows. No ads-table query for an unbound workspace. */
async function context(user: SessionUser): Promise<{ config: AdsConfig; account: string | null }> {
  const config = await resolveAdsConfig(user.organizationId)
  if (config.mode === 'not_connected') return { config, account: null }
  return { config, account: config.adAccountId ?? null }
}

type AccountRow = NonNullable<Awaited<ReturnType<typeof loadAccount>>>

async function loadAccount(orgId: string, account: string) {
  return db.metaAdAccount.findFirst({ where: { organizationId: orgId, adAccountId: account } })
}

function cardFor(a: AccountRow): AccountCard {
  const s = accountStatusWords(a.accountStatus)
  const cur = a.currency || 'USD'
  return {
    adAccountId: a.adAccountId,
    name: a.name ?? 'Meta ad account',
    currency: cur,
    timezoneName: a.timezoneName,
    statusCode: a.accountStatus,
    statusWords: s.words,
    statusTone: s.tone,
    balance: minorToMajor(a.balanceCents, cur),
    amountSpent: minorToMajor(a.amountSpentCents, cur),
    spendCap: a.spendCapCents && a.spendCapCents > BigInt(0) ? minorToMajor(a.spendCapCents, cur) : null,
    card: a.fundingDisplay,
    cardType: fundingWords(a.fundingType),
    billingUrl: billingUrl(a.adAccountId),
  }
}

function syncStateFor(mode: SyncState['mode'], a: AccountRow | null, partialMax: boolean, now = new Date()): SyncState {
  if (!a) return { mode, lastFullSyncAt: null, lastSnapshotAt: null, stale: mode !== 'not_connected', error: null, backoffUntil: null, partialMax: false }
  const fullMs = fullSyncMinutes() * 60_000
  const stale =
    !a.lastFullSyncAt || now.getTime() - a.lastFullSyncAt.getTime() > 2 * fullMs ||
    !a.lastSnapshotAt || now.getTime() - a.lastSnapshotAt.getTime() > 30 * 60_000
  return {
    mode,
    lastFullSyncAt: a.lastFullSyncAt,
    lastSnapshotAt: a.lastSnapshotAt,
    stale,
    error: a.lastErrorKind && a.lastError && a.lastErrorAt ? { kind: asKind(a.lastErrorKind), plain: a.lastError, at: a.lastErrorAt } : null,
    backoffUntil: a.backoffUntil && a.backoffUntil > now ? a.backoffUntil : null,
    partialMax,
  }
}

function sumsOf(r: Pick<MetaInsightSummary, 'spend' | 'impressions' | 'reach' | 'clicks' | 'linkClicks' | 'leads' | 'landingPageViews' | 'frequency'> | null): MetricSums {
  if (!r) return EMPTY_SUMS
  return {
    spend: Number(r.spend),
    impressions: r.impressions,
    reach: r.reach,
    clicks: r.clicks,
    linkClicks: r.linkClicks,
    leads: r.leads,
    landingPageViews: r.landingPageViews,
    frequency: r.frequency === null ? null : Number(r.frequency),
  }
}

function emptyDashboard(window: AdsWindow, mode: SyncState['mode'], canManage: boolean): AdsDashboard {
  return {
    account: null, window, totals: EMPTY_METRICS, counts: { campaigns: 0, adSets: 0, ads: 0, activeAds: 0 }, tree: [], daily: [],
    sync: syncStateFor(mode, null, false), writesEnabled: false, canManage,
  }
}

// ── Dashboard ──────────────────────────────────────────────────────────────────

export async function getAdsDashboard(user: SessionUser, window: AdsWindow): Promise<AdsDashboard> {
  requireRead(user)
  const canManage = can(user, 'connectors:manage')
  const { config, account } = await context(user)
  if (config.mode === 'not_connected' || !account) return emptyDashboard(window, 'not_connected', canManage)
  const orgId = user.organizationId
  const a = await loadAccount(orgId, account)
  if (!a) return emptyDashboard(window, config.mode, canManage)

  const win = WINDOW_ENUM[window]
  const tz = a.timezoneName
  const today = dayInZone(new Date(), tz)
  const scope = { organizationId: orgId, adAccountId: account }

  const [accountSummary, maxSummary, adSummaries, ad7, campaigns, adSets, ads, campDaily, accDaily] = await Promise.all([
    db.metaInsightSummary.findFirst({ where: { ...scope, level: 'ACCOUNT', objectId: account, window: win } }),
    db.metaInsightSummary.findFirst({ where: { ...scope, level: 'ACCOUNT', objectId: account, window: 'MAXIMUM' }, select: { partial: true } }),
    db.metaInsightSummary.findMany({ where: { ...scope, level: 'AD', window: win } }),
    db.metaInsightSummary.findMany({ where: { ...scope, level: 'AD', window: 'LAST_7D' } }),
    db.campaign.findMany({ where: { ...scope, channel: 'meta' }, select: { id: true, externalId: true, name: true, status: true, effectiveStatus: true, objective: true, budget: true, lifetimeBudget: true } }),
    db.adSet.findMany({ where: scope, select: { id: true, externalId: true, campaignId: true, name: true, status: true, effectiveStatus: true, dailyBudget: true, lifetimeBudget: true } }),
    db.metaAd.findMany({ where: scope }),
    db.metaInsightDaily.findMany({ where: { ...scope, level: 'CAMPAIGN', date: { gte: new Date(`${addDays(today, -30)}T00:00:00Z`) } }, select: { objectId: true, date: true, spend: true, leads: true } }),
    db.metaInsightDaily.findMany({ where: { ...scope, level: 'ACCOUNT', objectId: account, date: { gte: new Date(`${addDays(today, -29)}T00:00:00Z`) } }, select: { date: true, spend: true, leads: true }, orderBy: { date: 'asc' } }),
  ])

  // Health badges: zero-lead streak from campaign daily rows, inherited by ads.
  const streakByCampaign = new Map<string, number>()
  const campDays = new Map<string, { date: string; spend: number; leads: number }[]>()
  for (const r of campDaily) {
    const list = campDays.get(r.objectId) ?? []
    list.push({ date: r.date.toISOString().slice(0, 10), spend: Number(r.spend), leads: r.leads })
    campDays.set(r.objectId, list)
  }
  for (const [id, days] of campDays) streakByCampaign.set(id, zeroLeadStreak(days))
  const campaignExternal = new Map(campaigns.map((c) => [c.id, c.externalId ?? '']))
  const ad7By = new Map(ad7.map((r) => [r.objectId, computeMetrics(sumsOf(r))]))
  const flags = new Map<string, AdFlags>()
  for (const ad of ads) {
    const f = healthFlags(ad7By.get(ad.externalId) ?? null)
    flags.set(ad.externalId, { zeroLeadStreakDays: streakByCampaign.get(campaignExternal.get(ad.campaignId) ?? '') ?? 0, ...f })
  }

  const adSums = new Map(adSummaries.map((r) => [r.objectId, sumsOf(r)]))
  const accountSums = sumsOf(accountSummary)
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  const visibleCampaigns = campaigns.filter((c) => c.effectiveStatus !== 'DELETED' || ads.some((ad) => ad.campaignId === c.id && (adSums.get(ad.externalId)?.spend ?? 0) > 0))
  const { tree } = buildTree({
    campaigns: visibleCampaigns.map((c) => ({ id: c.id, externalId: c.externalId ?? '', name: c.name, status: c.effectiveStatus ?? c.status.toUpperCase(), objective: c.objective, dailyBudget: num(c.budget), lifetimeBudget: num(c.lifetimeBudget) })),
    adSets: adSets.map((s) => ({ id: s.id, externalId: s.externalId ?? '', campaignId: s.campaignId, name: s.name, status: s.effectiveStatus ?? s.status.toUpperCase(), dailyBudget: num(s.dailyBudget), lifetimeBudget: num(s.lifetimeBudget) })),
    ads: ads.map((ad) => ({
      id: ad.id, externalId: ad.externalId, campaignId: ad.campaignId, adSetId: ad.adSetId, name: ad.name, status: ad.status,
      effectiveStatus: ad.effectiveStatus, removed: ad.removed, thumbnailUrl: ad.thumbnailUrl, headline: ad.headline, body: ad.body, cta: ad.cta, linkUrl: ad.linkUrl,
    })),
    adSums,
    adFlags: flags,
    account: accountSums,
  })

  const dailyBy = new Map(accDaily.map((r) => [r.date.toISOString().slice(0, 10), r]))
  const daily: AdsDashboard['daily'] = []
  for (let i = 29; i >= 0; i--) {
    const d = addDays(today, -i)
    const r = dailyBy.get(d)
    daily.push({ date: d, spend: r ? Number(r.spend) : 0, leads: r?.leads ?? 0 })
  }

  return {
    account: cardFor(a),
    window,
    totals: computeMetrics(accountSums),
    counts: {
      campaigns: campaigns.filter((c) => c.effectiveStatus !== 'DELETED').length,
      adSets: adSets.filter((s) => s.effectiveStatus !== 'DELETED').length,
      ads: ads.filter((ad) => !ad.removed).length,
      activeAds: ads.filter((ad) => !ad.removed && ad.effectiveStatus === 'ACTIVE').length,
    },
    tree,
    daily,
    sync: syncStateFor(config.mode, a, Boolean(maxSummary?.partial)),
    writesEnabled: config.mode === 'live' && writesEnabled(),
    canManage,
  }
}

// ── Billing ────────────────────────────────────────────────────────────────────

export async function getBillingView(user: SessionUser): Promise<BillingView | null> {
  requireManage(user)
  const { config, account } = await context(user)
  if (config.mode === 'not_connected' || !account) return null
  const orgId = user.organizationId
  const a = await loadAccount(orgId, account)
  if (!a) return null
  const today = dayInZone(new Date(), a.timezoneName)
  const [daily, events] = await Promise.all([
    db.metaInsightDaily.findMany({
      where: { organizationId: orgId, adAccountId: account, level: 'ACCOUNT', objectId: account, date: { gte: new Date(`${addDays(today, -89)}T00:00:00Z`) } },
      select: { date: true, spend: true }, orderBy: { date: 'asc' },
    }),
    db.metaBillingEvent.findMany({ where: { organizationId: orgId, adAccountId: account }, orderBy: { occurredAt: 'desc' }, take: 50 }),
  ])
  const byDay = new Map(daily.map((r) => [r.date.toISOString().slice(0, 10), Number(r.spend)]))
  const spend90: BillingView['spend90'] = []
  for (let i = 89; i >= 0; i--) {
    const d = addDays(today, -i)
    spend90.push({ date: d, spend: byDay.get(d) ?? 0 })
  }
  const cur = a.currency || 'USD'
  const tracks = fundingTracksPayments(a.fundingType)
  const pending = tracks ? parsePending(a.pendingCharge) : null
  return {
    account: cardFor(a),
    spend90,
    detector: tracks ? 'on' : 'off_funding',
    ledger: events.map((e) => ({
      id: e.id, kind: e.kind, at: e.occurredAt, amount: e.amountCents === null ? null : minorToMajor(e.amountCents, cur),
      approximate: e.approximate, before: e.before, after: e.after,
    })),
    pending: pending ? { amount: minorToMajor(pending.fromCents - pending.toCents, cur) ?? 0, since: new Date(pending.detectedAt) } : null,
  }
}

// ── Cycle ──────────────────────────────────────────────────────────────────────

export async function getCycleView(user: SessionUser): Promise<CycleView> {
  requireRead(user)
  const { config, account } = await context(user)
  if (config.mode === 'not_connected' || !account) return { current: null, history: [], lengthDays: 15 }
  const orgId = user.organizationId
  const a = await loadAccount(orgId, account)
  if (!a) return { current: null, history: [], lengthDays: 15 }
  const now = new Date()
  const tz = a.timezoneName
  const [open, closed] = await Promise.all([
    db.metaSpendCycle.findFirst({ where: { organizationId: orgId, adAccountId: account, endedAt: null }, orderBy: { number: 'desc' } }),
    db.metaSpendCycle.findMany({ where: { organizationId: orgId, adAccountId: account, endedAt: { not: null } }, orderBy: { number: 'desc' }, take: 6 }),
  ])
  let current: CycleView['current'] = null
  if (open) {
    const st = cycleState(open.startedAt, open.lengthDays, now, tz)
    const daily = await db.metaInsightDaily.findMany({
      where: { organizationId: orgId, adAccountId: account, level: 'ACCOUNT', objectId: account, date: { gte: new Date(`${st.startDay}T00:00:00Z`) } },
      select: { date: true, spend: true },
    })
    const spend = cycleSpend(daily.map((r) => ({ date: r.date.toISOString().slice(0, 10), spend: Number(r.spend) })), st.startDay, dayInZone(now, tz), Number(open.startDayExcludedSpend))
    const leads = await db.metaLeadTouch.count({ where: { organizationId: orgId, adAccountId: account, status: 'matched', leadCreatedAt: { gte: open.startedAt } } })
    current = {
      number: open.number, startedAt: open.startedAt, endsAt: st.endsAt, day: st.day, lengthDays: open.lengthDays, overdue: st.overdue,
      spend, leads, cpl: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null, approximate: open.spendApproximate,
    }
  }
  return {
    current,
    history: closed.map((c) => ({
      number: c.number, startedAt: c.startedAt, endedAt: c.endedAt!, spend: c.closedSpend === null ? null : Number(c.closedSpend),
      leads: c.closedLeads, final: !c.finalAfter || c.finalAfter <= now, finalAfter: c.finalAfter, approximate: c.spendApproximate,
    })),
    lengthDays: a.cycleDays,
  }
}

// ── Funnel ─────────────────────────────────────────────────────────────────────

const FUNNEL_WINDOW: Record<FunnelRange, AdsWindow> = { '7d': '7d', '30d': '30d', all: 'max' }

export async function getFunnelView(user: SessionUser, range: FunnelRange): Promise<FunnelView> {
  requireRead(user)
  const empty: FunnelView = { range, rows: [], unmatched: 0, outside: 0, pending: 0, attributionBroken: false, leadOrgMatches: null }
  const { config, account } = await context(user)
  if (config.mode === 'not_connected' || !account) return empty
  const orgId = user.organizationId
  const a = await loadAccount(orgId, account)
  if (!a) return empty
  const tz = a.timezoneName
  const today = dayInZone(new Date(), tz)
  // Meta's last_7d / last_30d end yesterday, so the CRM side stops at today's
  // midnight too; 'all' compares against maximum, which includes today.
  const since = range === 'all' ? null : zonedMidnight(addDays(today, range === '7d' ? -7 : -30), tz)
  const until = range === 'all' ? null : zonedMidnight(today, tz)
  const dateFilter = since && until ? { leadCreatedAt: { gte: since, lt: until } } : {}

  const [matched, unmatched, outside, pending, spendRows, ads, campaigns] = await Promise.all([
    db.metaLeadTouch.findMany({ where: { organizationId: orgId, status: 'matched', adAccountId: account, adId: { not: null }, ...dateFilter }, select: { adId: true, clientId: true, callCenterLeadId: true } }),
    db.metaLeadTouch.count({ where: { organizationId: orgId, status: 'unmatched', ...dateFilter } }),
    db.metaLeadTouch.count({ where: { organizationId: orgId, status: 'outside', ...dateFilter } }),
    db.metaLeadTouch.count({ where: { organizationId: orgId, status: 'pending', ...dateFilter } }),
    db.metaInsightSummary.findMany({ where: { organizationId: orgId, adAccountId: account, level: 'AD', window: WINDOW_ENUM[FUNNEL_WINDOW[range]] }, select: { objectId: true, spend: true, leads: true } }),
    db.metaAd.findMany({ where: { organizationId: orgId, adAccountId: account }, select: { externalId: true, name: true, campaignId: true } }),
    db.campaign.findMany({ where: { organizationId: orgId, channel: 'meta', adAccountId: account }, select: { id: true, name: true } }),
  ])

  const clientIds = [...new Set(matched.map((t) => t.clientId).filter((x): x is string => Boolean(x)))]
  const ccIds = [...new Set(matched.map((t) => t.callCenterLeadId).filter((x): x is string => Boolean(x)))]
  const [clients, ccLeads] = await Promise.all([
    clientIds.length
      ? db.client.findMany({
          where: { organizationId: orgId, id: { in: clientIds } },
          select: {
            id: true, firstContactAt: true,
            appointments: { select: { status: true } },
            stageHistory: { where: { toKey: 'PRESENTATION_COMPLETED' }, select: { id: true }, take: 1 },
            deal: { select: { status: true, value: true } },
          },
        })
      : Promise.resolve([]),
    ccIds.length
      ? db.callCenterLead.findMany({ where: { organizationId: orgId, id: { in: ccIds } }, select: { id: true, tries: true, status: true } })
      : Promise.resolve([]),
  ])

  const outcomes = new Map<string, LeadOutcome>()
  for (const c of clients) {
    const sold = c.deal?.status === 'WON'
    outcomes.set(`c:${c.id}`, {
      contacted: Boolean(c.firstContactAt),
      booked: c.appointments.some((ap) => ap.status !== 'CANCELLED'),
      sat: c.appointments.some((ap) => ap.status === 'COMPLETED') || c.stageHistory.length > 0,
      sold,
      revenue: sold ? Number(c.deal?.value ?? 0) : 0,
    })
  }
  for (const l of ccLeads) {
    outcomes.set(`l:${l.id}`, { contacted: l.tries > 0, booked: l.status === 'BOOKED', sat: false, sold: false, revenue: 0 })
  }

  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]))
  const rows = buildFunnelRows({
    touches: matched.map((t) => ({ adId: t.adId!, outcomeKey: t.clientId ? `c:${t.clientId}` : `l:${t.callCenterLeadId}` })),
    outcomes,
    ads: new Map(ads.map((ad) => [ad.externalId, { name: ad.name, campaignName: campaignName.get(ad.campaignId) ?? '' }])),
    spend: new Map(spendRows.map((r) => [r.objectId, { spend: Number(r.spend), metaLeads: r.leads }])),
  })
  return { range, rows, unmatched, outside, pending, attributionBroken: attributionBroken(rows), leadOrgMatches: a.leadOrgMatches }
}

// ── Connection ─────────────────────────────────────────────────────────────────

export async function getConnectionView(user: SessionUser): Promise<ConnectionView> {
  requireManage(user)
  const { config, account } = await context(user)
  const boundHere = isBoundOrg(user.organizationId)
  const writes = config.mode === 'live' && writesEnabled()
  // The approved list is an env fact about the binding, independent of whether
  // the ads token is saved yet: missing credentials must not read as a missing
  // allowlist. Without a live config the accounts are listed but not checked.
  const binding = adsBinding()
  const allowlistConfigured = boundHere && Boolean(binding)
  const bindingAccounts = allowlistConfigured ? [...binding!.accounts].sort() : []
  const base: ConnectionView = {
    mode: config.mode, boundHere,
    allowlist: { configured: allowlistConfigured, accounts: bindingAccounts.map((id) => ({ id, reachable: null, name: null })) },
    token: { valid: null, expiresAt: null, scopes: [], type: null, appMatches: null, targetsOk: null, seesOthers: false },
    leadOrgMatches: null, lastFullSyncAt: null, lastSnapshotAt: null, usagePct: null, backoffUntil: null, truncated: false, errors: [], writesEnabled: writes,
  }
  if (config.mode === 'not_connected' || !account) return base
  const orgId = user.organizationId
  const accounts = config.accounts
  const rows = await db.metaAdAccount.findMany({ where: { organizationId: orgId, adAccountId: { in: accounts } } })
  const a = rows.find((r) => r.adAccountId === account) ?? null
  const now = new Date()
  const reachable = (r: (typeof rows)[number] | undefined): boolean | null => {
    if (!r || !r.lastSnapshotAt) return null
    if (r.lastErrorKind && ['permission', 'token', 'config'].includes(r.lastErrorKind)) return false
    return now.getTime() - r.lastSnapshotAt.getTime() < 24 * 3_600_000
  }

  const connector = await db.connector.findUnique({ where: { organizationId_kind: { organizationId: orgId, kind: 'META_ADS' } }, select: { id: true } })
  const logs = connector
    ? await db.connectorLog.findMany({ where: { connectorId: connector.id, event: 'meta.ads.sync.error' }, orderBy: { createdAt: 'desc' }, take: 5, select: { detail: true, createdAt: true } })
    : []
  const errors = logs.map((l) => {
    const d = (l.detail ?? {}) as { kind?: string; plain?: string }
    return { kind: asKind(d.kind), plain: typeof d.plain === 'string' ? d.plain : "Meta didn't answer as expected.", at: l.createdAt }
  })
  if (errors.length === 0 && a?.lastErrorKind && a.lastError && a.lastErrorAt) errors.push({ kind: asKind(a.lastErrorKind), plain: a.lastError, at: a.lastErrorAt })

  return {
    ...base,
    // Live: the approved accounts with their reachability. Sample mode in the
    // bound workspace: the approved accounts, unchecked. Sample mode with no
    // binding: the sample account.
    allowlist: config.mode === 'live' || !allowlistConfigured
      ? {
          configured: allowlistConfigured,
          accounts: accounts.map((id) => {
            const r = rows.find((x) => x.adAccountId === id)
            return { id, reachable: reachable(r), name: r?.name ?? null }
          }),
        }
      : base.allowlist,
    token: {
      valid: a?.tokenValid ?? null,
      expiresAt: a?.tokenExpiresAt ?? null,
      scopes: a?.tokenScopes ?? [],
      type: a?.tokenType ?? null,
      appMatches: a?.tokenAppId && config.creds ? a.tokenAppId === config.creds.appId : null,
      targetsOk: a?.tokenTargetsOk ?? null,
      seesOthers: a?.tokenSeesOthers ?? false,
    },
    leadOrgMatches: a?.leadOrgMatches ?? null,
    lastFullSyncAt: a?.lastFullSyncAt ?? null,
    lastSnapshotAt: a?.lastSnapshotAt ?? null,
    usagePct: a?.lastUsagePct ?? null,
    backoffUntil: a?.backoffUntil && a.backoffUntil > now ? a.backoffUntil : null,
    truncated: a?.lastTruncated ?? false,
    errors,
  }
}
