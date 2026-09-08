import 'server-only'
import { db } from '@/lib/db'
import { centsToUsd, spendCapToCents, usdToCents } from './money'
import { metaCredentials } from './provider'
import type {
  MetaAccountInfo, MetaAdAccountInput, MetaAdSet, MetaAdsProvider, MetaCampaign,
  MetaCampaignInput, MetaDailyStat, MetaLead,
} from './provider'
import type { MetaCredentials } from './provider'

const GRAPH = 'https://graph.facebook.com/v21.0'

/** account_status codes from GET /act_X — anything unknown renders as the raw code. */
const ACCOUNT_STATUS: Record<number, string> = {
  1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW',
  8: 'PENDING_SETTLEMENT', 9: 'IN_GRACE_PERIOD', 100: 'PENDING_CLOSURE', 101: 'CLOSED',
}

type GraphError = { message?: string; code?: number; error_subcode?: number }

/**
 * Real adapter over the Marketing API. Active only when credentials exist;
 * campaigns and ad sets sync into the local Campaign/AdSet tables so the rest
 * of the app (lead attribution, reports) never cares which adapter produced
 * them.
 *
 * Written against the documented Graph endpoints but NOT yet exercised against
 * a live ad account — first run with real credentials should be watched.
 */
export class GraphMetaAdsProvider implements MetaAdsProvider {
  readonly kind = 'graph' as const

  constructor(private readonly creds: MetaCredentials = metaCredentials()) {}

  /**
   * Ads-management calls prefer the System User token: Page tokens are the
   * right credential for leadgen webhooks but usually 403 on /act_X writes.
   */
  private adsToken(): string {
    return this.creds.systemUserToken ?? this.creds.pageAccessToken ?? ''
  }

  private act(): string {
    const { adAccountId } = this.creds
    if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID is not set.')
    return adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`
  }

  /** GET when `form` is absent, POST x-www-form-urlencoded when present. */
  private async graph<T>(
    path: string,
    params: Record<string, string> = {},
    form?: Record<string, string>,
    token = this.adsToken(),
  ): Promise<T> {
    const qs = new URLSearchParams({ ...params, access_token: token })
    const init: RequestInit | undefined = form
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...form, access_token: token }),
        }
      : undefined
    const res = await fetch(`${GRAPH}${path}?${qs}`, init)
    const body = (await res.json().catch(() => ({}))) as T & { error?: GraphError }
    if (!res.ok || body.error) {
      const err = body.error ?? {}
      // Codes 10/200/294 (+ HTTP 403) are Meta's permission family. The usual
      // culprit: a Page access token on an ads_management call. Say so plainly
      // instead of parroting an opaque OAuth message.
      const permissionProblem =
        res.status === 403 || err.code === 10 || err.code === 200 || err.code === 294 ||
        /permission|ads_management/i.test(err.message ?? '')
      if (permissionProblem) {
        throw new Error(
          `Meta refused this call${err.message ? ` (${err.message})` : ''}. ` +
          'Page access tokens usually cannot manage ads — use a System User token with the ' +
          'ads_management permission (META_SYSTEM_USER_TOKEN) for campaign, ad set, budget, ' +
          'and account operations.',
        )
      }
      throw new Error(`Meta API: ${err.message ?? res.statusText}`)
    }
    return body
  }

  async listCampaigns(organizationId: string): Promise<MetaCampaign[]> {
    // Lead-capture-only installs connect an app + token but no ad account. That
    // is a valid live state (leads flow via fetchLead), so the campaign surfaces
    // degrade to empty instead of throwing "META_AD_ACCOUNT_ID is not set".
    if (!this.creds.adAccountId) return []
    type Row = { id: string; name: string; objective: string; status: string; daily_budget?: string; spend_cap?: string }
    const res = await this.graph<{ data: Row[] }>(`/${this.act()}/campaigns`, {
      fields: 'id,name,objective,status,daily_budget,spend_cap',
      limit: '100',
    })
    const out: MetaCampaign[] = []
    for (const r of res.data) {
      const dailyBudget = r.daily_budget ? centsToUsd(r.daily_budget) : null
      const spendCap = r.spend_cap && Number(r.spend_cap) > 0 ? centsToUsd(r.spend_cap) : null
      const shared = {
        name: r.name,
        status: r.status === 'ACTIVE' ? 'active' : 'paused',
        // Budget and cap refresh on every sync so an edit made in Ads Manager
        // (or a previous console command) is never shadowed by a stale mirror.
        budget: dailyBudget,
        spendCap,
        utmCampaign: r.objective?.toLowerCase() ?? null,
      }
      // Mirror into the local table so attribution and reports can join on it.
      const existing = await db.campaign.findFirst({ where: { organizationId, externalId: r.id } })
      const local = existing
        ? await db.campaign.update({ where: { id: existing.id }, data: shared })
        : await db.campaign.create({ data: { organizationId, channel: 'meta', externalId: r.id, ...shared } })
      const leads = await db.client.count({ where: { campaignId: local.id } })
      out.push({
        id: local.id, externalId: r.id, name: r.name, objective: r.objective ?? 'LEADS',
        status: r.status, dailyBudget: dailyBudget ?? 0, spendCap,
        spend: Number(local.spend), impressions: local.impressions, clicks: local.clicks, leads,
      })
    }
    return out
  }

  async createCampaign(organizationId: string, input: MetaCampaignInput): Promise<MetaCampaign> {
    const created = await this.graph<{ id: string }>(`/${this.act()}/campaigns`, {}, {
      name: input.name,
      objective: `OUTCOME_${input.objective}`,
      status: input.status,
      daily_budget: String(usdToCents(input.dailyBudget)),
      special_ad_categories: '[]',
    })
    const local = await db.campaign.create({
      data: {
        organizationId, name: input.name, channel: 'meta', externalId: created.id,
        status: input.status === 'ACTIVE' ? 'active' : 'paused',
        startedAt: new Date(), budget: input.dailyBudget, utmCampaign: input.objective.toLowerCase(),
      },
    })
    return {
      id: local.id, externalId: created.id, name: input.name, objective: input.objective,
      status: input.status, dailyBudget: input.dailyBudget, spendCap: null,
      spend: 0, impressions: 0, clicks: 0, leads: 0,
    }
  }

  private async localCampaign(organizationId: string, campaignId: string) {
    const local = await db.campaign.findFirst({ where: { id: campaignId, organizationId } })
    if (!local?.externalId) throw new Error('Campaign has no Meta id.')
    return local as typeof local & { externalId: string }
  }

  async setCampaignStatus(organizationId: string, campaignId: string, status: 'ACTIVE' | 'PAUSED') {
    const local = await this.localCampaign(organizationId, campaignId)
    await this.graph(`/${local.externalId}`, {}, { status })
    await db.campaign.update({ where: { id: local.id }, data: { status: status === 'ACTIVE' ? 'active' : 'paused' } })
  }

  async updateDailyBudget(organizationId: string, campaignId: string, dailyBudget: number) {
    const local = await this.localCampaign(organizationId, campaignId)
    await this.graph(`/${local.externalId}`, {}, { daily_budget: String(usdToCents(dailyBudget)) })
    await db.campaign.update({ where: { id: local.id }, data: { budget: dailyBudget } })
  }

  async setCampaignSpendCap(organizationId: string, campaignId: string, spendCapUsd: number) {
    const local = await this.localCampaign(organizationId, campaignId)
    // spend_cap is LIFETIME cents with a $100 floor — a different knob from daily_budget.
    await this.graph(`/${local.externalId}`, {}, { spend_cap: String(spendCapToCents(spendCapUsd)) })
    await db.campaign.update({ where: { id: local.id }, data: { spendCap: spendCapUsd } })
  }

  async listAdSets(organizationId: string, campaignId?: string): Promise<MetaAdSet[]> {
    // The account-level listing needs an ad account; the campaign-scoped path
    // resolves via localCampaign() and does not, so only guard the former.
    if (!campaignId && !this.creds.adAccountId) return []
    type Row = { id: string; name: string; status: string; daily_budget?: string; campaign_id?: string }
    const path = campaignId
      ? `/${(await this.localCampaign(organizationId, campaignId)).externalId}/adsets`
      : `/${this.act()}/adsets`
    const res = await this.graph<{ data: Row[] }>(path, {
      fields: 'id,name,status,daily_budget,campaign_id',
      limit: '200',
    })

    const locals = await db.campaign.findMany({
      where: { organizationId, channel: 'meta', externalId: { not: null } },
      select: { id: true, externalId: true },
    })
    const campaignByExternal = new Map(locals.map((c) => [c.externalId!, c.id]))

    const out: MetaAdSet[] = []
    for (const r of res.data) {
      const localCampaignId = campaignId ?? (r.campaign_id ? campaignByExternal.get(r.campaign_id) : undefined)
      if (!localCampaignId) continue // ad set of a campaign we have never synced
      const dailyBudget = r.daily_budget ? centsToUsd(r.daily_budget) : null
      const row = await db.adSet.upsert({
        where: { organizationId_externalId: { organizationId, externalId: r.id } },
        create: {
          organizationId, campaignId: localCampaignId, externalId: r.id, name: r.name,
          status: r.status === 'ACTIVE' ? 'active' : 'paused', dailyBudget,
        },
        update: {
          name: r.name,
          status: r.status === 'ACTIVE' ? 'active' : 'paused',
          dailyBudget,
          campaignId: localCampaignId,
        },
      })
      out.push({
        id: row.id, campaignId: localCampaignId, externalId: r.id, name: r.name,
        status: r.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
        dailyBudget: dailyBudget ?? 0, spend: Number(row.spend),
      })
    }

    // CampaignDailyStat.adSetId is a plain scalar with no FK — hygiene is ours:
    // any stat row pointing at an ad set that no longer exists gets detached.
    const liveIds = await db.adSet.findMany({ where: { organizationId }, select: { id: true } })
    await db.campaignDailyStat.updateMany({
      where: {
        campaign: { organizationId, channel: 'meta' },
        adSetId: { not: null, notIn: liveIds.map((a) => a.id) },
      },
      data: { adSetId: null },
    })
    return out
  }

  private async localAdSet(organizationId: string, adSetId: string) {
    const local = await db.adSet.findFirst({ where: { id: adSetId, organizationId } })
    if (!local?.externalId) throw new Error('Ad set has no Meta id.')
    return local as typeof local & { externalId: string }
  }

  async setAdSetStatus(organizationId: string, adSetId: string, status: 'ACTIVE' | 'PAUSED') {
    const local = await this.localAdSet(organizationId, adSetId)
    await this.graph(`/${local.externalId}`, {}, { status })
    await db.adSet.update({ where: { id: local.id }, data: { status: status === 'ACTIVE' ? 'active' : 'paused' } })
  }

  async updateAdSetBudget(organizationId: string, adSetId: string, dailyBudget: number) {
    const local = await this.localAdSet(organizationId, adSetId)
    await this.graph(`/${local.externalId}`, {}, { daily_budget: String(usdToCents(dailyBudget)) })
    await db.adSet.update({ where: { id: local.id }, data: { dailyBudget } })
  }

  async createAdAccount(_organizationId: string, input: MetaAdAccountInput) {
    const { businessId, systemUserToken } = this.creds
    if (!businessId || !systemUserToken) {
      throw new Error(
        'Ad account creation needs META_BUSINESS_ID and META_SYSTEM_USER_TOKEN (a System User ' +
        'token with business_management + ads_management). Set both, or stay in mock mode.',
      )
    }
    if (!/^\d+$/.test(input.timezone)) {
      throw new Error("Meta wants its numeric timezone_id here (see the Marketing API's timezone-ids table).")
    }
    const created = await this.graph<{ id: string }>(`/${businessId}/adaccount`, {}, {
      name: input.name,
      currency: input.currency,
      timezone_id: input.timezone,
      end_advertiser: businessId,
      media_agency: 'NONE',
      partner: 'NONE',
    }, systemUserToken)
    return { id: created.id, mode: 'live' as const }
  }

  async accountInfo(organizationId: string): Promise<MetaAccountInfo> {
    void organizationId // account identity comes from the credential set, not the org
    if (!this.creds.adAccountId) {
      return { id: '—', name: 'Ad account not connected', currency: 'USD', status: 'NOT_CONNECTED', mode: 'live' }
    }
    type Res = { id: string; name?: string; currency?: string; account_status?: number; amount_spent?: string; spend_cap?: string }
    const res = await this.graph<Res>(`/${this.act()}`, {
      fields: 'id,name,currency,account_status,amount_spent,spend_cap',
    })
    return {
      id: res.id,
      name: res.name ?? this.act(),
      currency: res.currency ?? 'USD',
      spendCap: res.spend_cap && Number(res.spend_cap) > 0 ? centsToUsd(res.spend_cap) : undefined,
      amountSpent: res.amount_spent ? centsToUsd(res.amount_spent) : undefined,
      status: ACCOUNT_STATUS[res.account_status ?? -1] ?? String(res.account_status ?? 'UNKNOWN'),
      mode: 'live',
    }
  }

  async dailyStats(organizationId: string, days: number): Promise<MetaDailyStat[]> {
    if (!this.creds.adAccountId) return []
    type Row = { date_start: string; campaign_id?: string; spend?: string; impressions?: string; clicks?: string }
    // level=campaign so each row carries its real campaign_id — account-level
    // rows used to be dumped onto whichever campaign happened to sort first.
    const res = await this.graph<{ data: Row[] }>(`/${this.act()}/insights`, {
      level: 'campaign',
      time_increment: '1',
      date_preset: days <= 7 ? 'last_7d' : 'last_30d',
      fields: 'campaign_id,spend,impressions,clicks',
      limit: '500',
    })

    const locals = await db.campaign.findMany({
      where: { organizationId, channel: 'meta', externalId: { not: null } },
      select: { id: true, externalId: true },
    })
    const byExternal = new Map(locals.map((c) => [c.externalId!, c.id]))

    const byDay = new Map<string, MetaDailyStat>()
    for (const r of res.data) {
      const spend = Number(r.spend ?? 0)
      const impressions = Number(r.impressions ?? 0)
      const clicks = Number(r.clicks ?? 0)

      const agg = byDay.get(r.date_start) ?? { date: r.date_start, spend: 0, impressions: 0, clicks: 0, leads: 0 }
      agg.spend = Math.round((agg.spend + spend) * 100) / 100
      agg.impressions += impressions
      agg.clicks += clicks
      byDay.set(r.date_start, agg)

      // Persist per-campaign so history survives the API's date-preset window.
      const localId = r.campaign_id ? byExternal.get(r.campaign_id) : undefined
      if (localId) {
        await db.campaignDailyStat.upsert({
          where: { campaignId_date: { campaignId: localId, date: new Date(r.date_start) } },
          create: { campaignId: localId, adSetId: null, date: new Date(r.date_start), spend, impressions, clicks },
          update: { spend, impressions, clicks, adSetId: null },
        })
      }
    }

    // Keep the campaign lifetime totals in step with what we just learned.
    for (const c of locals) {
      const totals = await db.campaignDailyStat.aggregate({
        where: { campaignId: c.id },
        _sum: { spend: true, impressions: true, clicks: true },
      })
      await db.campaign.update({
        where: { id: c.id },
        data: {
          spend: totals._sum.spend ?? 0,
          impressions: totals._sum.impressions ?? 0,
          clicks: totals._sum.clicks ?? 0,
        },
      })
    }

    return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
  }

  async fetchLead(leadgenId: string): Promise<MetaLead> {
    type Res = { id: string; created_time: string; field_data: { name: string; values: string[] }[] }
    // Leadgen reads want the PAGE token; a System User token with leads_retrieval
    // is an accepted fallback, so a single system-user credential can run the
    // whole webhook without a separately-minted Page token.
    const leadToken = this.creds.pageAccessToken ?? this.creds.systemUserToken ?? ''
    const res = await this.graph<Res>(`/${leadgenId}`, { fields: 'id,created_time,field_data' }, undefined, leadToken)
    return {
      leadgenId: res.id,
      createdTime: res.created_time,
      fields: Object.fromEntries(res.field_data.map((f) => [f.name, f.values[0] ?? ''])),
    }
  }
}
