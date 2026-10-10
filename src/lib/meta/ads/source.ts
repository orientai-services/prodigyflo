import 'server-only'
import { createHash } from 'node:crypto'
import { adsMockAllowed, mockAdAccountId } from './allowlist'
import {
  createGraphClient, isTooMuchData, MetaGraphError, type GraphClientOptions, type UsageSnapshot,
} from './graph-client'
import type { RawInsight } from './metrics'
import { addDays, dayInZone } from './cycle'

/**
 * Where ads data comes from (docs/META_ADS_SCS.md §3.2). The account is fixed
 * when the source is built: there is no account-id parameter anywhere. There is
 * no leads() method: lead attribution comes from stored JSON, never from Graph.
 */

export type AdsWindow = 'today' | '7d' | '30d' | 'month' | 'max'
export const ADS_WINDOWS: AdsWindow[] = ['today', '7d', '30d', 'month', 'max']

export type RawAccount = {
  id?: string
  account_id?: string
  name?: string
  currency?: string
  timezone_name?: string
  account_status?: number
  disable_reason?: number
  balance?: string
  amount_spent?: string
  spend_cap?: string
  funding_source_details?: { display_string?: string; type?: number }
}
export type RawCampaign = {
  id: string; account_id?: string; name?: string; status?: string; effective_status?: string; objective?: string
  daily_budget?: string; lifetime_budget?: string; created_time?: string
}
export type RawAdSet = RawCampaign & { campaign_id?: string; optimization_goal?: string }
export type RawAd = {
  id: string; account_id?: string; campaign_id?: string; adset_id?: string; name?: string; status?: string
  effective_status?: string; created_time?: string; creative?: Record<string, unknown>
}

export type Ownership = 'allowed' | 'other_account' | 'no_access' | 'not_found'

/**
 * ads_read / ads_management targets from debug_token. `all`: no target list on
 * a non-system-user token. `unreported`: no target list on a system user token
 * (its reach is its asset assignment, which me/adaccounts shows).
 */
export type TokenTargets = { all: true } | { unreported: true } | { allowed: string[]; others: number } | null

export type VisibleAccounts = { allowedVisible: string[]; othersVisible: boolean }

/** Do these targets name (or cover) any account outside the allowlist? */
export function targetsWide(t: TokenTargets): boolean {
  return Boolean(t && ('all' in t || ('others' in t && t.others > 0)))
}

/**
 * Is the token limited to approved accounts? Explicit targets must list only
 * approved ones; unreported targets are judged by me/adaccounts alone.
 */
export function targetsNarrow(t: TokenTargets, visible: VisibleAccounts): boolean {
  if (!t || 'all' in t || visible.othersVisible) return false
  if ('unreported' in t) return visible.allowedVisible.length > 0
  return t.others === 0 && t.allowed.length > 0
}
export type TokenInfo = {
  valid: boolean
  appId: string | null
  type: string | null
  expiresAt: Date | null
  scopes: string[]
  /** ads_read target accounts: allowed ids, plus only a COUNT of any others. */
  adsRead: TokenTargets
  adsManagement: TokenTargets
}

export type WindowInsights = {
  rows: RawInsight[]
  truncated: boolean
  /** MAXIMUM had to fall back (37-month range, or campaign level). */
  partial: boolean
  /** Level the rows are at (MAXIMUM at ad level can fall back to campaign). */
  level: 'account' | 'campaign' | 'ad'
}

export interface AdsSource {
  readonly kind: 'mock' | 'graph'
  readonly adAccountId: string
  account(): Promise<RawAccount>
  campaigns(): Promise<{ rows: RawCampaign[]; truncated: boolean }>
  adSets(): Promise<{ rows: RawAdSet[]; truncated: boolean }>
  ads(): Promise<{ rows: RawAd[]; truncated: boolean }>
  windowInsights(level: 'account' | 'ad', w: AdsWindow): Promise<WindowInsights>
  daily(level: 'account' | 'campaign', since: string, until: string): Promise<{ rows: RawInsight[]; truncated: boolean }>
  hourly(day: string): Promise<{ hour: number; spend: number }[] | null>
  ownership(objectId: string): Promise<Ownership>
  tokenInfo(): Promise<TokenInfo>
  visibleAccounts(): Promise<{ allowedVisible: string[]; othersVisible: boolean }>
}

const PRESET: Record<AdsWindow, 'today' | 'last_7d' | 'last_30d' | 'this_month' | 'maximum'> = {
  today: 'today', '7d': 'last_7d', '30d': 'last_30d', month: 'this_month', max: 'maximum',
}

/** "13:00:00 - 13:59:59" → 13 */
export function parseHourBucket(v: string | undefined): number | null {
  const m = /^(\d{1,2}):/.exec(v ?? '')
  const h = m ? Number(m[1]) : NaN
  return Number.isInteger(h) && h >= 0 && h < 24 ? h : null
}

// ── Graph ──────────────────────────────────────────────────────────────────────

export class GraphAdsSource implements AdsSource {
  readonly kind = 'graph' as const
  private readonly client: ReturnType<typeof createGraphClient>

  constructor(readonly adAccountId: string, opts: GraphClientOptions) {
    this.client = createGraphClient(opts)
  }

  async account(): Promise<RawAccount> {
    return (await this.client.get<RawAccount>({ r: 'account', account: this.adAccountId, fields: 'snapshot' })).body
  }

  private async edge<T>(edge: 'campaigns' | 'adsets' | 'ads') {
    const { data, truncated } = await this.client.getAllPages<T>({ r: 'edge', account: this.adAccountId, edge })
    return { rows: data, truncated }
  }
  campaigns() { return this.edge<RawCampaign>('campaigns') }
  adSets() { return this.edge<RawAdSet>('adsets') }
  ads() { return this.edge<RawAd>('ads') }

  async windowInsights(level: 'account' | 'ad', w: AdsWindow): Promise<WindowInsights> {
    const datePreset = PRESET[w]
    if (level === 'account') {
      const { body } = await this.client.get<{ data: RawInsight[] }>({
        r: 'edge', account: this.adAccountId, edge: 'insights', params: { level: 'account', datePreset },
      })
      return { rows: body.data ?? [], truncated: false, partial: false, level: 'account' }
    }
    try {
      const { data, truncated } = await this.client.getAllPages<RawInsight>({
        r: 'edge', account: this.adAccountId, edge: 'insights', params: { level: 'ad', datePreset },
      })
      return { rows: data, truncated, partial: false, level: 'ad' }
    } catch (e) {
      if (w !== 'max' || !isTooMuchData(e)) throw e
    }
    // MAXIMUM was too big: retry once over the last 37 months, then fall back to campaign level.
    const until = new Date().toISOString().slice(0, 10)
    const since = addDays(until, -37 * 30)
    try {
      const { data, truncated } = await this.client.getAllPages<RawInsight>({
        r: 'edge', account: this.adAccountId, edge: 'insights', params: { level: 'ad', timeRange: { since, until } },
      })
      return { rows: data, truncated, partial: true, level: 'ad' }
    } catch (e) {
      if (!isTooMuchData(e)) throw e
    }
    const { data, truncated } = await this.client.getAllPages<RawInsight>({
      r: 'edge', account: this.adAccountId, edge: 'insights', params: { level: 'campaign', datePreset: 'maximum' },
    })
    return { rows: data, truncated, partial: true, level: 'campaign' }
  }

  async daily(level: 'account' | 'campaign', since: string, until: string) {
    const { data, truncated } = await this.client.getAllPages<RawInsight>({
      r: 'edge', account: this.adAccountId, edge: 'insights', params: { level, timeRange: { since, until }, daily: true },
    })
    return { rows: data, truncated }
  }

  /**
   * Spend per hour on one day (spend only: hourly breakdowns don't support
   * reach or frequency). null ONLY when Meta says the breakdown is unsupported
   * (code 100). Rate stops, token, transient and network errors are thrown so
   * the step is retried on a later run.
   */
  async hourly(day: string) {
    let data: RawInsight[]
    try {
      ;({ data } = await this.client.getAllPages<RawInsight>({
        r: 'edge', account: this.adAccountId, edge: 'insights',
        params: { level: 'account', timeRange: { since: day, until: day }, hourly: true },
      }))
    } catch (e) {
      if (e instanceof MetaGraphError && e.code === 100 && e.kind !== 'config') return null
      throw e
    }
    const out: { hour: number; spend: number }[] = []
    for (const r of data) {
      const hour = parseHourBucket(r.hourly_stats_aggregated_by_advertiser_time_zone)
      if (hour !== null) out.push({ hour, spend: Number(r.spend ?? 0) || 0 })
    }
    return out
  }

  async ownership(objectId: string): Promise<Ownership> {
    try {
      const { body } = await this.client.get<{ allowed: boolean; present: boolean }>({ r: 'ownership', objectId })
      if (body.allowed) return 'allowed'
      return body.present ? 'other_account' : 'not_found'
    } catch (e) {
      if (e instanceof MetaGraphError) {
        if (e.kind === 'permission') return 'no_access'
        if (e.kind === 'not_found') return 'not_found'
        if (e.code === 100) return 'not_found'
      }
      throw e
    }
  }

  async tokenInfo(): Promise<TokenInfo> {
    return (await this.client.get<TokenInfo>({ r: 'debugToken' })).body
  }

  async visibleAccounts() {
    return (await this.client.get<{ allowedVisible: string[]; othersVisible: boolean }>({ r: 'myAccounts' })).body
  }
}

// ── Mock (dev, test and preview only) ─────────────────────────────────────────

const seed = (s: string) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16)

type MockAd = { id: string; adset: string; campaign: string; name: string; status: string; effective: string; budget: number; creative: Record<string, unknown> }

/**
 * Deterministic synthetic account: 3 campaigns, 5 ad sets, 9 ads (one paused
 * that never delivered, one archived, one Advantage+ creative using
 * asset_feed_spec). The balance is a sawtooth with a payment every 3 simulated
 * days (one simulated day = 6 ten-minute readings), plus a stale-replica flap
 * and a bounce, so the payment detector has something honest to chew on.
 */
export class MockAdsSource implements AdsSource {
  readonly kind = 'mock' as const
  readonly adAccountId: string
  private readonly p: string

  constructor(readonly orgId: string, private readonly now: () => Date = () => new Date()) {
    if (!adsMockAllowed()) throw new Error('Mock ads data is not allowed in this environment.')
    this.adAccountId = mockAdAccountId(orgId)
    this.p = `mock_${orgId.slice(-8)}`
  }

  private get campaignsList() {
    const p = this.p
    return [
      { id: `${p}_c1`, name: 'Sample: Homeowner review', status: 'ACTIVE', objective: 'OUTCOME_LEADS', budget: 6000 },
      { id: `${p}_c2`, name: 'Sample: Retargeting', status: 'ACTIVE', objective: 'OUTCOME_LEADS', budget: 2500 },
      { id: `${p}_c3`, name: 'Sample: Spring test', status: 'PAUSED', objective: 'OUTCOME_LEADS', budget: 1500 },
    ]
  }

  private get adSetsList() {
    const p = this.p
    return [
      { id: `${p}_s1`, campaign: `${p}_c1`, name: 'Sample: Las Vegas 35+', status: 'ACTIVE' },
      { id: `${p}_s2`, campaign: `${p}_c1`, name: 'Sample: Henderson 35+', status: 'ACTIVE' },
      { id: `${p}_s3`, campaign: `${p}_c2`, name: 'Sample: Site visitors', status: 'ACTIVE' },
      { id: `${p}_s4`, campaign: `${p}_c3`, name: 'Sample: Broad', status: 'PAUSED' },
      { id: `${p}_s5`, campaign: `${p}_c3`, name: 'Sample: Lookalike', status: 'PAUSED' },
    ]
  }

  private get adsList(): MockAd[] {
    const p = this.p
    const link = (title: string, body: string) => ({
      thumbnail_url: 'https://example.com/sample-thumbnail.jpg',
      object_story_spec: { link_data: { name: title, message: body, link: 'https://example.com/review', call_to_action: { type: 'LEARN_MORE' } } },
    })
    return [
      { id: `${p}_a1`, adset: `${p}_s1`, campaign: `${p}_c1`, name: 'Sample: Video A', status: 'ACTIVE', effective: 'ACTIVE', budget: 2200, creative: link('Is your solar contract fair?', 'Get a free review.') },
      { id: `${p}_a2`, adset: `${p}_s1`, campaign: `${p}_c1`, name: 'Sample: Photo B', status: 'ACTIVE', effective: 'ACTIVE', budget: 1300, creative: link('See what you really pay', 'A free contract review.') },
      { id: `${p}_a3`, adset: `${p}_s2`, campaign: `${p}_c1`, name: 'Sample: Video C', status: 'ACTIVE', effective: 'ACTIVE', budget: 1800, creative: link('Questions about your panels?', 'Talk to us.') },
      { id: `${p}_a4`, adset: `${p}_s2`, campaign: `${p}_c1`, name: 'Sample: Advantage+ D', status: 'ACTIVE', effective: 'ACTIVE', budget: 700, creative: {
        thumbnail_url: 'https://example.com/sample-thumbnail-2.jpg',
        asset_feed_spec: { titles: [{ text: 'Free solar contract review' }], bodies: [{ text: 'Find out in 10 minutes.' }], call_to_action_types: ['SIGN_UP'], link_urls: [{ website_url: 'https://example.com/apply' }] },
      } },
      { id: `${p}_a5`, adset: `${p}_s3`, campaign: `${p}_c2`, name: 'Sample: Reminder E', status: 'ACTIVE', effective: 'ACTIVE', budget: 1500, creative: link('Still thinking it over?', 'Your review is waiting.') },
      { id: `${p}_a6`, adset: `${p}_s3`, campaign: `${p}_c2`, name: 'Sample: Testimonial F', status: 'ACTIVE', effective: 'ACTIVE', budget: 1000, creative: link('Hear from a neighbor', 'Real homeowners, real answers.') },
      { id: `${p}_a7`, adset: `${p}_s4`, campaign: `${p}_c3`, name: 'Sample: Never ran G', status: 'PAUSED', effective: 'PAUSED', budget: 0, creative: link('Draft headline', 'Draft body.') },
      { id: `${p}_a8`, adset: `${p}_s4`, campaign: `${p}_c3`, name: 'Sample: Old H', status: 'ARCHIVED', effective: 'ARCHIVED', budget: 0, creative: link('Old headline', 'Old body.') },
      { id: `${p}_a9`, adset: `${p}_s5`, campaign: `${p}_c3`, name: 'Sample: Paused I', status: 'PAUSED', effective: 'ADSET_PAUSED', budget: 0, creative: link('Paused headline', 'Paused body.') },
    ]
  }

  /** Daily stats for one ad on one day (cents budget → dollars). The archived ad spent until 20 days ago. */
  private dayStat(ad: MockAd, day: string): RawInsight {
    const today = dayInZone(this.now(), 'America/Los_Angeles')
    let budget = ad.budget
    if (ad.effective === 'ARCHIVED' && day <= addDays(today, -20) && day > addDays(today, -60)) budget = 900
    if (budget <= 0) return { ad_id: ad.id, adset_id: ad.adset, campaign_id: ad.campaign, account_id: this.adAccountId, date_start: day, date_stop: day, spend: '0', impressions: '0', reach: '0', clicks: '0', inline_link_clicks: '0', actions: [] }
    const r = seed(`${ad.id}:${day}`)
    const share = day === today ? 0.45 : 1
    const spend = Math.round((budget / 100) * (0.72 + (r % 29) / 100) * share * 100) / 100
    const impressions = Math.round((900 + (r % 4200)) * share)
    const linkClicks = Math.max(1, Math.round(impressions * (0.006 + (r % 17) / 1000)))
    const clicks = linkClicks + (r % 9)
    const leads = Math.max(0, Math.round(linkClicks * (0.04 + (r % 11) / 100)))
    return {
      account_id: this.adAccountId, campaign_id: ad.campaign, adset_id: ad.adset, ad_id: ad.id,
      date_start: day, date_stop: day, spend: spend.toFixed(2), impressions: String(impressions),
      reach: String(Math.round(impressions * 0.72)), clicks: String(clicks), inline_link_clicks: String(linkClicks),
      actions: [{ action_type: 'onsite_conversion.lead_grouped', value: String(leads) }, { action_type: 'landing_page_view', value: String(Math.round(linkClicks * 0.6)) }],
    }
  }

  private days(since: string, until: string): string[] {
    const out: string[] = []
    for (let d = since; d <= until && out.length < 2000; d = addDays(d, 1)) out.push(d)
    return out
  }

  private sum(rows: RawInsight[], extra: Partial<RawInsight>): RawInsight {
    let spend = 0, imp = 0, reach = 0, clicks = 0, link = 0, leads = 0, lpv = 0
    for (const r of rows) {
      spend += Number(r.spend ?? 0); imp += Number(r.impressions ?? 0); reach += Number(r.reach ?? 0)
      clicks += Number(r.clicks ?? 0); link += Number(r.inline_link_clicks ?? 0)
      leads += Number(r.actions?.find((a) => a.action_type === 'onsite_conversion.lead_grouped')?.value ?? 0)
      lpv += Number(r.actions?.find((a) => a.action_type === 'landing_page_view')?.value ?? 0)
    }
    // Unique reach over a window is lower than the sum of daily reach.
    const windowReach = Math.round(reach * (rows.length > 1 ? 0.55 : 1))
    return {
      account_id: this.adAccountId, ...extra, spend: spend.toFixed(2), impressions: String(imp), reach: String(windowReach),
      clicks: String(clicks), inline_link_clicks: String(link),
      frequency: windowReach ? (imp / windowReach).toFixed(3) : undefined,
      actions: [{ action_type: 'onsite_conversion.lead_grouped', value: String(leads) }, { action_type: 'landing_page_view', value: String(lpv) }],
    }
  }

  private windowRange(w: AdsWindow): { since: string; until: string } {
    const today = dayInZone(this.now(), 'America/Los_Angeles')
    if (w === 'today') return { since: today, until: today }
    if (w === '7d') return { since: addDays(today, -7), until: addDays(today, -1) }
    if (w === '30d') return { since: addDays(today, -30), until: addDays(today, -1) }
    if (w === 'month') return { since: `${today.slice(0, 8)}01`, until: today }
    return { since: addDays(today, -180), until: today }
  }

  async account(): Promise<RawAccount> {
    const slot = Math.floor(this.now().getTime() / 600_000)
    const cycle = 18 // a payment every 3 simulated days of 6 readings
    const pos = slot % cycle
    const spentAt = (s: number) => 1_250_000 + (s % 1_000_000) * 420
    let balance = spentAt(slot) - spentAt(slot - pos)
    let amountSpent = spentAt(slot)
    if (pos === 7) { amountSpent -= 900_000; balance = 3 } // stale replica flap
    if (pos === 12) balance = Math.round(balance * 0.3) // bounce: back up on the next reading
    return {
      id: this.adAccountId, account_id: this.adAccountId.replace(/^act_/, ''), name: 'Sample ad account',
      currency: 'USD', timezone_name: 'America/Los_Angeles', account_status: 1, disable_reason: 0,
      balance: String(balance), amount_spent: String(amountSpent), spend_cap: '0',
      funding_source_details: { display_string: 'Visa *0000 (sample)', type: 1 },
    }
  }

  async campaigns() {
    return {
      rows: this.campaignsList.map((c) => ({
        id: c.id, account_id: this.adAccountId, name: c.name, status: c.status, effective_status: c.status,
        objective: c.objective, daily_budget: String(c.budget), created_time: '2026-09-01T12:00:00+0000',
      })),
      truncated: false,
    }
  }

  async adSets() {
    return {
      rows: this.adSetsList.map((s) => ({
        id: s.id, account_id: this.adAccountId, campaign_id: s.campaign, name: s.name, status: s.status,
        effective_status: s.status, optimization_goal: 'LEAD_GENERATION', created_time: '2026-09-01T12:00:00+0000',
      })),
      truncated: false,
    }
  }

  async ads() {
    return {
      rows: this.adsList.map((a) => ({
        id: a.id, account_id: this.adAccountId, campaign_id: a.campaign, adset_id: a.adset, name: a.name,
        status: a.status, effective_status: a.effective, created_time: '2026-09-01T12:00:00+0000', creative: a.creative,
      })),
      truncated: false,
    }
  }

  async windowInsights(level: 'account' | 'ad', w: AdsWindow): Promise<WindowInsights> {
    const { since, until } = this.windowRange(w)
    const days = this.days(since, until)
    if (level === 'account') {
      const rows = this.adsList.flatMap((ad) => days.map((d) => this.dayStat(ad, d)))
      return { rows: [this.sum(rows, { date_start: since, date_stop: until })], truncated: false, partial: false, level: 'account' }
    }
    const rows = this.adsList.map((ad) =>
      this.sum(days.map((d) => this.dayStat(ad, d)), { ad_id: ad.id, adset_id: ad.adset, campaign_id: ad.campaign, date_start: since, date_stop: until }),
    ).filter((r) => Number(r.spend) > 0 || Number(r.impressions) > 0)
    return { rows, truncated: false, partial: false, level: 'ad' }
  }

  async daily(level: 'account' | 'campaign', since: string, until: string) {
    const rows: RawInsight[] = []
    for (const d of this.days(since, until)) {
      if (level === 'account') {
        rows.push(this.sum(this.adsList.map((ad) => this.dayStat(ad, d)), { date_start: d, date_stop: d }))
      } else {
        for (const c of this.campaignsList) {
          const r = this.sum(this.adsList.filter((a) => a.campaign === c.id).map((ad) => this.dayStat(ad, d)), { campaign_id: c.id, date_start: d, date_stop: d })
          if (Number(r.spend) > 0) rows.push(r)
        }
      }
    }
    return { rows, truncated: false }
  }

  async hourly(day: string) {
    const total = Number(this.sum(this.adsList.map((ad) => this.dayStat(ad, day)), {}).spend)
    return Array.from({ length: 24 }, (_, hour) => ({ hour, spend: Math.round((total / 24) * 100) / 100 }))
  }

  async ownership(objectId: string): Promise<Ownership> {
    return objectId.startsWith(`${this.p}_`) ? 'allowed' : 'other_account'
  }

  async tokenInfo(): Promise<TokenInfo> {
    return { valid: true, appId: null, type: 'SYSTEM_USER', expiresAt: null, scopes: ['ads_read'], adsRead: { allowed: [this.adAccountId], others: 0 }, adsManagement: null }
  }

  async visibleAccounts() {
    return { allowedVisible: [this.adAccountId], othersVisible: false }
  }
}

export type { UsageSnapshot }
