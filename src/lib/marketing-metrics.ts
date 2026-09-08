import 'server-only'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'
import { rate } from '@/lib/format'

/**
 * Marketing perspective — every lead-generation number in one place.
 *
 * Data here is read-only measurement for the /marketing pages. Pages gate with
 * `requirePermissionPage('analytics:marketing')`; Client queries still spread
 * `clientScope(user)` (a marketing seat holds org-wide read, so in practice the
 * scope is the organization), and non-client tables are keyed to the caller's
 * organization directly.
 */

// ── Range selection (30/60/90 days) ──────────────────────────────────────────

export type MarketingRangeKey = '30' | '60' | '90'

export type MarketingRange = {
  key: MarketingRangeKey
  days: number
  from: Date
  /** Start of the equally-sized window immediately before `from`. */
  prevFrom: Date
  label: string
}

export const MARKETING_RANGES: { key: MarketingRangeKey; label: string }[] = [
  { key: '30', label: '30 days' },
  { key: '60', label: '60 days' },
  { key: '90', label: '90 days' },
]

export function marketingRange(param: string | undefined, now = new Date()): MarketingRange {
  const key: MarketingRangeKey = param === '60' ? '60' : param === '90' ? '90' : '30'
  const days = Number(key)
  return {
    key,
    days,
    from: new Date(now.getTime() - days * 86_400_000),
    prevFrom: new Date(now.getTime() - 2 * days * 86_400_000),
    label: `Last ${days} days`,
  }
}

// ── Pure rollup logic (unit-tested) ──────────────────────────────────────────

export type MarketingClientRow = {
  leadSourceId: string | null
  campaignId: string | null
  createdAt: Date
  reachedQualified: boolean
  reachedWon: boolean
}

export type FunnelCounts = {
  leads: number
  qualified: number
  won: number
  /** Qualified ÷ leads, percent. Null when there are no leads. */
  qualifiedRate: number | null
  /** Won ÷ leads, percent. Null when there are no leads. */
  wonRate: number | null
}

export function rollupFunnel(rows: MarketingClientRow[]): FunnelCounts {
  const leads = rows.length
  const qualified = rows.filter((r) => r.reachedQualified).length
  const won = rows.filter((r) => r.reachedWon).length
  return { leads, qualified, won, qualifiedRate: rate(qualified, leads), wonRate: rate(won, leads) }
}

export type SourceRollup = FunnelCounts & {
  id: string
  name: string
  channel: string
  isActive: boolean
}

/**
 * Per-source funnel over the given clients. Sources with zero leads in range
 * are kept (marketing needs to see the silent ones), sorted by volume.
 */
export function rollupBySource(
  rows: MarketingClientRow[],
  sources: { id: string; name: string; channel: string; isActive: boolean }[],
): SourceRollup[] {
  const bySource = new Map<string, MarketingClientRow[]>()
  for (const row of rows) {
    if (!row.leadSourceId) continue
    const list = bySource.get(row.leadSourceId) ?? []
    list.push(row)
    bySource.set(row.leadSourceId, list)
  }
  return sources
    .map((s) => ({ ...s, ...rollupFunnel(bySource.get(s.id) ?? []) }))
    .sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name))
}

export type CampaignStat = { spend: number; impressions: number; clicks: number; leads: number }

export type CampaignRollup = FunnelCounts & {
  id: string
  name: string
  channel: string
  sourceName: string | null
  status: string
  /** In-range ad-platform numbers (CampaignDailyStat). */
  spend: number
  impressions: number
  clicks: number
  /** Leads as the ad platform reported them — CRM `leads` is the truth. */
  adLeads: number
  ctr: number | null
  costPerLead: number | null
  costPerQualified: number | null
}

/** Per-campaign funnel + in-range spend. Campaigns with no activity are dropped. */
export function rollupByCampaign(
  rows: MarketingClientRow[],
  campaigns: { id: string; name: string; channel: string; sourceName: string | null; status: string }[],
  statsByCampaign: Map<string, CampaignStat>,
): CampaignRollup[] {
  const byCampaign = new Map<string, MarketingClientRow[]>()
  for (const row of rows) {
    if (!row.campaignId) continue
    const list = byCampaign.get(row.campaignId) ?? []
    list.push(row)
    byCampaign.set(row.campaignId, list)
  }
  return campaigns
    .map((c) => {
      const funnel = rollupFunnel(byCampaign.get(c.id) ?? [])
      const stat = statsByCampaign.get(c.id) ?? { spend: 0, impressions: 0, clicks: 0, leads: 0 }
      return {
        ...c,
        ...funnel,
        spend: stat.spend,
        impressions: stat.impressions,
        clicks: stat.clicks,
        adLeads: stat.leads,
        ctr: rate(stat.clicks, stat.impressions),
        costPerLead: costPer(stat.spend, funnel.leads),
        costPerQualified: costPer(stat.spend, funnel.qualified),
      }
    })
    .filter((c) => c.leads > 0 || c.spend > 0 || c.impressions > 0)
    .sort((a, b) => b.spend - a.spend || b.leads - a.leads)
}

/** Null (never Infinity/NaN) when there is no spend or nothing to divide by. */
export function costPer(spend: number, count: number): number | null {
  if (!spend || !count) return null
  return spend / count
}

export type WeekBucket = { label: string; count: number }

/**
 * Weekly counts, oldest bucket first, covering `days` back from `now`. The
 * oldest bucket can be a partial week when `days` is not a multiple of 7.
 */
export function bucketWeekly(dates: Date[], days: number, now = new Date()): WeekBucket[] {
  const weeks = Math.ceil(days / 7)
  const buckets: WeekBucket[] = []
  for (let i = weeks - 1; i >= 0; i--) {
    const from = new Date(now.getTime() - (i + 1) * 7 * 86_400_000)
    const to = new Date(now.getTime() - i * 7 * 86_400_000)
    buckets.push({
      label: to.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      count: dates.filter((d) => d >= from && d < to).length,
    })
  }
  return buckets
}

/** Percentage change vs the previous window. Null when the base is zero. */
export function deltaPct(current: number, previous: number): number | null {
  if (!previous) return null
  return ((current - previous) / previous) * 100
}

// ── Queries ──────────────────────────────────────────────────────────────────

const num = (v: unknown): number => (v == null ? 0 : Number(String(v)))

async function loadClientRows(user: SessionUser, from: Date): Promise<MarketingClientRow[]> {
  const rows = await db.client.findMany({
    where: { AND: [clientScope(user), { createdAt: { gte: from } }] },
    select: {
      leadSourceId: true,
      campaignId: true,
      createdAt: true,
      currentStage: { select: { key: true } },
      stageHistory: {
        where: { toKey: { in: ['QUALIFIED', 'CLOSED_WON'] } },
        select: { toKey: true },
      },
    },
  })
  return rows.map((r) => ({
    leadSourceId: r.leadSourceId,
    campaignId: r.campaignId,
    createdAt: r.createdAt,
    reachedQualified:
      r.stageHistory.some((h) => h.toKey === 'QUALIFIED') || r.currentStage.key === 'QUALIFIED',
    reachedWon:
      r.stageHistory.some((h) => h.toKey === 'CLOSED_WON') || r.currentStage.key === 'CLOSED_WON',
  }))
}

export type AdSpendSummary = {
  spend: number
  impressions: number
  clicks: number
  adLeads: number
  ctr: number | null
  cpc: number | null
  /** Total in-range spend ÷ CRM leads attributed to any campaign in range. */
  costPerLead: number | null
  costPerQualified: number | null
  campaignLeads: number
  campaignQualified: number
}

export type MarketingOverview = {
  totals: FunnelCounts & {
    prevLeads: number
    leadsDeltaPct: number | null
    /** Leads in range with no LeadSource attached — the attribution gap. */
    unattributed: number
  }
  weekly: WeekBucket[]
  sources: SourceRollup[]
  campaigns: CampaignRollup[]
  ads: AdSpendSummary
}

export async function getMarketingOverview(
  user: SessionUser,
  range: MarketingRange,
): Promise<MarketingOverview> {
  const [rows, prevLeads, sources, campaigns, stats] = await Promise.all([
    loadClientRows(user, range.from),
    db.client.count({
      where: { AND: [clientScope(user), { createdAt: { gte: range.prevFrom, lt: range.from } }] },
    }),
    db.leadSource.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, channel: true, isActive: true },
    }),
    db.campaign.findMany({
      where: { organizationId: user.organizationId },
      select: {
        id: true,
        name: true,
        channel: true,
        status: true,
        leadSource: { select: { name: true, channel: true } },
      },
    }),
    db.campaignDailyStat.groupBy({
      by: ['campaignId'],
      where: { campaign: { organizationId: user.organizationId }, date: { gte: range.from } },
      _sum: { spend: true, impressions: true, clicks: true, leads: true },
    }),
  ])

  const statsByCampaign = new Map<string, CampaignStat>(
    stats.map((s) => [
      s.campaignId,
      {
        spend: num(s._sum.spend),
        impressions: s._sum.impressions ?? 0,
        clicks: s._sum.clicks ?? 0,
        leads: s._sum.leads ?? 0,
      },
    ]),
  )

  const campaignRows = rollupByCampaign(
    rows,
    campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      channel: c.leadSource?.channel ?? c.channel,
      sourceName: c.leadSource?.name ?? null,
      status: c.status,
    })),
    statsByCampaign,
  )

  const totals = rollupFunnel(rows)
  const spend = campaignRows.reduce((sum, c) => sum + c.spend, 0)
  const impressions = campaignRows.reduce((sum, c) => sum + c.impressions, 0)
  const clicks = campaignRows.reduce((sum, c) => sum + c.clicks, 0)
  const adLeads = campaignRows.reduce((sum, c) => sum + c.adLeads, 0)
  // Cost efficiency only counts leads that came through a campaign with spend —
  // dividing spend by organic volume would flatter the ads.
  const spendCampaigns = campaignRows.filter((c) => c.spend > 0)
  const campaignLeads = spendCampaigns.reduce((sum, c) => sum + c.leads, 0)
  const campaignQualified = spendCampaigns.reduce((sum, c) => sum + c.qualified, 0)

  return {
    totals: {
      ...totals,
      prevLeads,
      leadsDeltaPct: deltaPct(totals.leads, prevLeads),
      unattributed: rows.filter((r) => !r.leadSourceId).length,
    },
    weekly: bucketWeekly(rows.map((r) => r.createdAt), range.days),
    sources: rollupBySource(rows, sources),
    campaigns: campaignRows,
    ads: {
      spend,
      impressions,
      clicks,
      adLeads,
      ctr: rate(clicks, impressions),
      cpc: costPer(spend, clicks),
      costPerLead: costPer(spend, campaignLeads),
      costPerQualified: costPer(spend, campaignQualified),
      campaignLeads,
      campaignQualified,
    },
  }
}

// ── Intake submissions funnel ────────────────────────────────────────────────

export const INTAKE_STATUS_ORDER = ['RECEIVED', 'APPLIED', 'DUPLICATE', 'NEEDS_MAPPING', 'FAILED'] as const
export type IntakeStatusKey = (typeof INTAKE_STATUS_ORDER)[number]

export type IntakeStatusCount = { status: IntakeStatusKey; count: number }

export type IntakeSourceFunnel = {
  id: string
  name: string
  kind: string
  isEnabled: boolean
  total: number
  applied: number
  duplicates: number
  failed: number
  needsMapping: number
  createdClients: number
  /** Applied ÷ total, percent. Null with no submissions. */
  appliedRate: number | null
}

export type IntakeFunnel = {
  total: number
  byStatus: IntakeStatusCount[]
  bySource: IntakeSourceFunnel[]
}

export async function getIntakeFunnel(user: SessionUser, from: Date): Promise<IntakeFunnel> {
  const [byStatus, bySourceStatus, createdBySource, intakeSources] = await Promise.all([
    db.intakeSubmission.groupBy({
      by: ['status'],
      where: { organizationId: user.organizationId, createdAt: { gte: from } },
      _count: { _all: true },
    }),
    db.intakeSubmission.groupBy({
      by: ['sourceId', 'status'],
      where: { organizationId: user.organizationId, createdAt: { gte: from } },
      _count: { _all: true },
    }),
    db.intakeSubmission.groupBy({
      by: ['sourceId'],
      where: { organizationId: user.organizationId, createdAt: { gte: from }, createdClient: true },
      _count: { _all: true },
    }),
    db.intakeSource.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, kind: true, isEnabled: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const statusCount = new Map(byStatus.map((g) => [g.status, g._count._all]))
  const createdCount = new Map(createdBySource.map((g) => [g.sourceId, g._count._all]))

  const perSource = new Map<string, Map<string, number>>()
  for (const g of bySourceStatus) {
    const inner = perSource.get(g.sourceId) ?? new Map<string, number>()
    inner.set(g.status, g._count._all)
    perSource.set(g.sourceId, inner)
  }

  const bySource = intakeSources
    .map((s) => {
      const counts = perSource.get(s.id) ?? new Map<string, number>()
      const total = [...counts.values()].reduce((a, b) => a + b, 0)
      const applied = counts.get('APPLIED') ?? 0
      return {
        id: s.id,
        name: s.name,
        kind: s.kind,
        isEnabled: s.isEnabled,
        total,
        applied,
        duplicates: counts.get('DUPLICATE') ?? 0,
        failed: counts.get('FAILED') ?? 0,
        needsMapping: counts.get('NEEDS_MAPPING') ?? 0,
        createdClients: createdCount.get(s.id) ?? 0,
        appliedRate: rate(applied, total),
      }
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))

  return {
    total: byStatus.reduce((sum, g) => sum + g._count._all, 0),
    byStatus: INTAKE_STATUS_ORDER.map((status) => ({ status, count: statusCount.get(status) ?? 0 })),
    bySource,
  }
}
