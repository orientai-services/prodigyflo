import 'server-only'
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { spendCapToCents } from './money'
import type {
  MetaAccountInfo, MetaAdAccountInput, MetaAdSet, MetaAdsProvider, MetaCampaign,
  MetaCampaignInput, MetaDailyStat, MetaLead,
} from './provider'

/**
 * DB-backed mock: campaigns live in the real Campaign table (channel 'meta'),
 * ad sets in AdSet, daily stats in CampaignDailyStat. Metrics are deterministic
 * functions of the campaign id and date, so the numbers are stable across
 * reloads and obviously synthetic — a paused campaign accrues nothing.
 */

const seed = (s: string) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16)

const isoToday = () => new Date().toISOString().slice(0, 10)

function statFor(campaignExternalId: string, dailyBudget: number, isoDate: string) {
  const r = seed(`${campaignExternalId}:${isoDate}`)
  const spend = Math.round(dailyBudget * (0.72 + (r % 29) / 100) * 100) / 100 // 72–100% of budget
  const impressions = 900 + (r % 4200)
  const clicks = Math.max(4, Math.round(impressions * (0.008 + (r % 17) / 1000)))
  const leads = Math.max(0, Math.round(clicks * (0.05 + (r % 11) / 100)))
  return { spend, impressions, clicks, leads }
}

/**
 * Fills the campaign's daily series up to today. LAZY: when today's row already
 * exists there is nothing to add (past days are append-only), so a render pass
 * costs one indexed lookup instead of thirty upserts. Returns whether anything
 * was written so callers know to re-read totals.
 */
async function backfill(campaign: { id: string; externalId: string | null; budget: Prisma.Decimal | null; status: string; createdAt: Date }): Promise<boolean> {
  if (campaign.status !== 'active') return false

  const today = await db.campaignDailyStat.findUnique({
    where: { campaignId_date: { campaignId: campaign.id, date: new Date(isoToday()) } },
    select: { id: true },
  })
  if (today) return false

  const start = new Date(Math.max(campaign.createdAt.getTime(), Date.now() - 29 * 86_400_000))
  const days: Date[] = []
  for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) days.push(new Date(d))

  for (const day of days) {
    const iso = day.toISOString().slice(0, 10)
    const s = statFor(campaign.externalId ?? campaign.id, Number(campaign.budget ?? 0), iso)
    await db.campaignDailyStat.upsert({
      where: { campaignId_date: { campaignId: campaign.id, date: new Date(iso) } },
      // Campaign-level rows: adSetId stays null (the unique on [campaignId, date]
      // allows one row per campaign-day, so ad-set attribution lives on AdSet.spend).
      create: { campaignId: campaign.id, adSetId: null, date: new Date(iso), ...s },
      update: {}, // stats are append-only in the mock; past days never change
    })
  }
  const totals = await db.campaignDailyStat.aggregate({
    where: { campaignId: campaign.id },
    _sum: { spend: true, impressions: true, clicks: true },
  })
  await db.campaign.update({
    where: { id: campaign.id },
    data: {
      spend: totals._sum.spend ?? 0,
      impressions: totals._sum.impressions ?? 0,
      clicks: totals._sum.clicks ?? 0,
    },
  })
  return true
}

const toCampaign = (c: {
  id: string; externalId: string | null; name: string; utmCampaign: string | null
  status: string; budget: Prisma.Decimal | null; spendCap: Prisma.Decimal | null
  spend: Prisma.Decimal; impressions: number; clicks: number; leadCount: number
}): MetaCampaign => ({
  id: c.id,
  externalId: c.externalId ?? c.id,
  name: c.name,
  objective: c.utmCampaign?.toUpperCase() ?? 'LEADS',
  status: c.status === 'active' ? 'ACTIVE' : 'PAUSED',
  dailyBudget: Number(c.budget ?? 0),
  spendCap: c.spendCap === null ? null : Number(c.spendCap),
  spend: Number(c.spend),
  impressions: c.impressions,
  clicks: c.clicks,
  leads: c.leadCount,
})

const toAdSet = (a: {
  id: string; campaignId: string; externalId: string | null; name: string
  status: string; dailyBudget: Prisma.Decimal | null; spend: Prisma.Decimal
}): MetaAdSet => ({
  id: a.id,
  campaignId: a.campaignId,
  externalId: a.externalId ?? a.id,
  name: a.name,
  status: a.status === 'active' ? 'ACTIVE' : 'PAUSED',
  dailyBudget: Number(a.dailyBudget ?? 0),
  spend: Number(a.spend),
})

const AUDIENCES = ['Lookalike 1%', 'Retargeting 30d', 'Broad 25–54', 'Interest: solar owners', 'Homeowner stack']

/**
 * Deterministic 2–3 ad sets per campaign: names, budget split, and spend
 * weights all derive from the campaign's external id. Existing rows are left
 * alone (the user may have paused or re-budgeted them); only spend is rolled
 * forward from the campaign total so the child rows always sum to the parent.
 */
async function ensureAdSets(campaign: { id: string; organizationId: string; externalId: string | null; name: string; budget: Prisma.Decimal | null; spend: Prisma.Decimal }) {
  const ext = campaign.externalId ?? campaign.id
  const r = seed(`adsets:${ext}`)
  const count = 2 + (r % 2)

  const existing = await db.adSet.count({ where: { campaignId: campaign.id } })
  if (existing === 0) {
    const budget = Number(campaign.budget ?? 0)
    const per = Math.round((budget / count) * 100) / 100
    for (let i = 0; i < count; i++) {
      await db.adSet.create({
        data: {
          organizationId: campaign.organizationId,
          campaignId: campaign.id,
          externalId: `mockas_${createHash('sha256').update(`${ext}:${i}`).digest('hex').slice(0, 10)}`,
          name: AUDIENCES[(r + i * 7) % AUDIENCES.length],
          status: 'active',
          dailyBudget: per,
        },
      })
    }
  }

  // Roll campaign spend down onto the ad sets with stable weights.
  const sets = await db.adSet.findMany({ where: { campaignId: campaign.id }, orderBy: { createdAt: 'asc' } })
  // >>> keeps the shift unsigned: seed() can exceed 2^31, and a signed shift
  // would make weights negative (NaN shares) for half of all hash values.
  const weights = sets.map((_, i) => 1 + ((r >>> (i * 3)) % 3))
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const totalSpend = Number(campaign.spend)
  let allocated = 0
  for (let i = 0; i < sets.length; i++) {
    const share = i === sets.length - 1
      ? Math.round((totalSpend - allocated) * 100) / 100
      : Math.round(((totalSpend * weights[i]) / totalWeight) * 100) / 100
    allocated = Math.round((allocated + share) * 100) / 100
    if (Number(sets[i].spend) !== share) {
      await db.adSet.update({ where: { id: sets[i].id }, data: { spend: share } })
    }
  }
}

export class MockMetaAdsProvider implements MetaAdsProvider {
  readonly kind = 'mock' as const

  async listCampaigns(organizationId: string): Promise<MetaCampaign[]> {
    const rows = await db.campaign.findMany({
      where: { organizationId, channel: 'meta' },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { clients: true } } },
    })
    let changed = false
    for (const c of rows) changed = (await backfill(c)) || changed
    const fresh = changed
      ? await db.campaign.findMany({
          where: { organizationId, channel: 'meta' },
          orderBy: { createdAt: 'desc' },
          include: { _count: { select: { clients: true } } },
        })
      : rows
    return fresh.map((c) => toCampaign({ ...c, leadCount: c._count.clients }))
  }

  async createCampaign(organizationId: string, input: MetaCampaignInput): Promise<MetaCampaign> {
    const leadSource = await db.leadSource.findFirst({
      where: { organizationId, name: { contains: 'Meta', mode: 'insensitive' } },
    })
    const c = await db.campaign.create({
      data: {
        organizationId,
        leadSourceId: leadSource?.id ?? null,
        name: input.name,
        channel: 'meta',
        externalId: `mock_${Date.now().toString(36)}`,
        status: input.status === 'ACTIVE' ? 'active' : 'paused',
        startedAt: new Date(),
        budget: input.dailyBudget,
        utmCampaign: input.objective.toLowerCase(),
      },
    })
    await backfill(c)
    await ensureAdSets(c)
    return toCampaign({ ...c, leadCount: 0 })
  }

  async setCampaignStatus(organizationId: string, campaignId: string, status: 'ACTIVE' | 'PAUSED') {
    await db.campaign.update({
      where: { id: campaignId, organizationId },
      data: { status: status === 'ACTIVE' ? 'active' : 'paused', endedAt: status === 'PAUSED' ? new Date() : null },
    })
  }

  async updateDailyBudget(organizationId: string, campaignId: string, dailyBudget: number) {
    await db.campaign.update({ where: { id: campaignId, organizationId }, data: { budget: dailyBudget } })
  }

  async setCampaignSpendCap(organizationId: string, campaignId: string, spendCapUsd: number) {
    spendCapToCents(spendCapUsd) // enforce Meta's $100 lifetime minimum, mock included
    await db.campaign.update({ where: { id: campaignId, organizationId }, data: { spendCap: spendCapUsd } })
  }

  async listAdSets(organizationId: string, campaignId?: string): Promise<MetaAdSet[]> {
    const campaigns = await db.campaign.findMany({
      where: { organizationId, channel: 'meta', ...(campaignId ? { id: campaignId } : {}) },
    })
    for (const c of campaigns) await ensureAdSets(c)
    const rows = await db.adSet.findMany({
      where: { organizationId, ...(campaignId ? { campaignId } : { campaign: { channel: 'meta' } }) },
      orderBy: [{ campaignId: 'asc' }, { createdAt: 'asc' }],
    })
    return rows.map(toAdSet)
  }

  async setAdSetStatus(organizationId: string, adSetId: string, status: 'ACTIVE' | 'PAUSED') {
    await db.adSet.update({
      where: { id: adSetId, organizationId },
      data: { status: status === 'ACTIVE' ? 'active' : 'paused' },
    })
  }

  async updateAdSetBudget(organizationId: string, adSetId: string, dailyBudget: number) {
    await db.adSet.update({ where: { id: adSetId, organizationId }, data: { dailyBudget } })
  }

  async createAdAccount(organizationId: string, input: MetaAdAccountInput) {
    // Nothing persists — a mock account is a deterministic label, clearly fake.
    const id = `act_mock_${createHash('sha256').update(`${organizationId}:${input.name}`).digest('hex').slice(0, 10)}`
    return { id, mode: 'mock' as const }
  }

  async accountInfo(organizationId: string): Promise<MetaAccountInfo> {
    const [org, totals] = await Promise.all([
      db.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
      db.campaign.aggregate({ where: { organizationId, channel: 'meta' }, _sum: { spend: true } }),
    ])
    return {
      id: `act_mock_${seed(organizationId).toString(36)}`,
      name: `${org?.name ?? 'ProdigyFlo'} Ads (mock)`,
      currency: 'USD',
      amountSpent: Number(totals._sum.spend ?? 0),
      status: 'ACTIVE',
      mode: 'mock',
    }
  }

  async dailyStats(organizationId: string, days: number): Promise<MetaDailyStat[]> {
    const since = new Date(Date.now() - days * 86_400_000)
    const rows = await db.campaignDailyStat.findMany({
      where: { campaign: { organizationId, channel: 'meta' }, date: { gte: since } },
      orderBy: { date: 'asc' },
    })
    const byDay = new Map<string, MetaDailyStat>()
    for (const r of rows) {
      const key = r.date.toISOString().slice(0, 10)
      const agg = byDay.get(key) ?? { date: key, spend: 0, impressions: 0, clicks: 0, leads: 0 }
      agg.spend = Math.round((agg.spend + Number(r.spend)) * 100) / 100
      agg.impressions += r.impressions
      agg.clicks += r.clicks
      agg.leads += r.leads
      byDay.set(key, agg)
    }
    return [...byDay.values()]
  }

  async fetchLead(leadgenId: string): Promise<MetaLead> {
    // Deterministic synthetic lead so the webhook → CRM path is exercisable
    // without Meta. The id fully determines the person.
    const r = seed(leadgenId)
    const first = ['Marisol', 'Devon', 'Priya', 'Elias', 'Naomi', 'Tomas'][r % 6]
    const last = ['Vasquez', 'Okonkwo', 'Bergstrom', 'Marchetti', 'Halloran', 'Nakamura'][(r >>> 3) % 6]
    return {
      leadgenId,
      createdTime: new Date().toISOString(),
      fields: {
        full_name: `${first} ${last}`,
        email: `${first}.${last}.${leadgenId.slice(-4)}@example.test`.toLowerCase(),
        phone_number: `+1702555${String(1000 + (r % 9000))}`,
      },
    }
  }
}
