/**
 * Pure metric helpers for Meta ads (docs/META_ADS_SCS.md §2.7, B3, B4).
 * No DB, no network: safe to unit test and to share with the read model.
 */

export type Metrics = {
  spend: number
  impressions: number
  reach: number | null
  clicks: number
  linkClicks: number
  leads: number
  landingPageViews: number
  /** Cost per lead. */
  cpl: number | null
  /** Link click-through rate, in percent. */
  ctr: number | null
  /** Cost per link click. */
  cpc: number | null
  /** Cost per 1,000 impressions. */
  cpm: number | null
  frequency: number | null
}

export type MetricSums = {
  spend: number
  impressions: number
  reach: number | null
  clicks: number
  linkClicks: number
  leads: number
  landingPageViews: number
  /** Meta's own frequency for the window, when it gave one. */
  frequency?: number | null
}

export const ZERO_SUMS: MetricSums = {
  spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, leads: 0, landingPageViews: 0, frequency: null,
}

const round = (n: number, d = 2) => {
  const f = 10 ** d
  return Math.round(n * f) / f
}

/** a / b, or null when b is 0 (never NaN or Infinity). */
export function ratio(a: number, b: number): number | null {
  return b > 0 && Number.isFinite(a) ? a / b : null
}

/** Ratios from sums (ratio of sums, never a sum of ratios). */
export function computeMetrics(s: MetricSums): Metrics {
  const spend = round(s.spend)
  const cpl = ratio(spend, s.leads)
  const ctr = ratio(s.linkClicks * 100, s.impressions)
  const cpc = ratio(spend, s.linkClicks)
  const cpm = ratio(spend * 1000, s.impressions)
  const frequency = s.frequency ?? (s.reach ? ratio(s.impressions, s.reach) : null)
  return {
    spend,
    impressions: s.impressions,
    reach: s.reach,
    clicks: s.clicks,
    linkClicks: s.linkClicks,
    leads: s.leads,
    landingPageViews: s.landingPageViews,
    cpl: cpl === null ? null : round(cpl),
    ctr: ctr === null ? null : round(ctr, 2),
    cpc: cpc === null ? null : round(cpc),
    cpm: cpm === null ? null : round(cpm),
    frequency: frequency === null ? null : round(frequency, 2),
  }
}

/** Add sums. Reach can't be added across objects or days, so a sum's reach is null. */
export function addSums(a: MetricSums, b: MetricSums): MetricSums {
  return {
    spend: a.spend + b.spend,
    impressions: a.impressions + b.impressions,
    reach: null,
    clicks: a.clicks + b.clicks,
    linkClicks: a.linkClicks + b.linkClicks,
    leads: a.leads + b.leads,
    landingPageViews: a.landingPageViews + b.landingPageViews,
    frequency: null,
  }
}

// ── Graph insight rows ─────────────────────────────────────────────────────────

export type GraphAction = { action_type?: string; value?: string | number }

/** B4: `onsite_conversion.lead_grouped` first, otherwise `lead`. */
export const LEAD_ACTION_ORDER = ['onsite_conversion.lead_grouped', 'lead'] as const

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}

export function actionValue(actions: GraphAction[] | undefined | null, type: string): number | null {
  if (!Array.isArray(actions)) return null
  const hit = actions.find((a) => a?.action_type === type)
  return hit ? toNum(hit.value) : null
}

export function leadsFromActions(actions: GraphAction[] | undefined | null): number {
  for (const t of LEAD_ACTION_ORDER) {
    const v = actionValue(actions, t)
    if (v !== null) return Math.round(v)
  }
  return 0
}

export type RawInsight = {
  account_id?: string
  campaign_id?: string
  adset_id?: string
  ad_id?: string
  date_start?: string
  date_stop?: string
  spend?: string
  impressions?: string
  reach?: string
  clicks?: string
  inline_link_clicks?: string
  frequency?: string
  actions?: GraphAction[]
  hourly_stats_aggregated_by_advertiser_time_zone?: string
}

export function sumsFromInsight(r: RawInsight): MetricSums {
  const reach = r.reach === undefined ? null : Math.round(toNum(r.reach))
  const freq = r.frequency === undefined ? null : toNum(r.frequency)
  return {
    spend: round(toNum(r.spend)), // insights spend is already in major units
    impressions: Math.round(toNum(r.impressions)),
    reach,
    clicks: Math.round(toNum(r.clicks)),
    linkClicks: Math.round(toNum(r.inline_link_clicks)),
    leads: leadsFromActions(r.actions),
    landingPageViews: Math.round(actionValue(r.actions, 'landing_page_view') ?? 0),
    frequency: freq,
  }
}

// ── Units and words (§2.7) ─────────────────────────────────────────────────────

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'CLP', 'VND', 'ISK', 'TWD', 'HUF'])

/** Graph money strings (balance, amount_spent, spend_cap, budgets) are minor units. */
export function minorToMajor(value: string | number | bigint | null | undefined, currency = 'USD'): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'bigint' ? Number(value) : Number(value)
  if (!Number.isFinite(n)) return null
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? n : round(n / 100)
}

/** Minor-unit string → integer cents (BigInt-safe), or null. */
export function minorToCents(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') return null
  const s = String(value).trim()
  if (!/^-?\d+$/.test(s)) return null
  return BigInt(s)
}

export type StatusTone = 'ok' | 'warn' | 'bad'

const STATUS_WORDS: Record<number, [string, StatusTone]> = {
  1: ['Active', 'ok'], 2: ['Disabled', 'bad'], 3: ['Unpaid', 'bad'], 7: ['In review', 'warn'],
  8: ['Pending settlement', 'warn'], 9: ['Grace period', 'bad'], 100: ['Pending closure', 'bad'],
  101: ['Closed', 'bad'], 201: ['Active', 'ok'], 202: ['Closed', 'bad'],
}

export function accountStatusWords(code: number | null | undefined): { words: string; tone: StatusTone } {
  if (code === null || code === undefined) return { words: 'Unknown', tone: 'warn' }
  const hit = STATUS_WORDS[code]
  return hit ? { words: hit[0], tone: hit[1] } : { words: `Unknown (code ${code})`, tone: 'warn' }
}

const FUNDING_WORDS: Record<number, string> = {
  1: 'Card', 2: 'Meta balance', 3: 'Paid credit', 4: 'Credit line', 5: 'Order', 6: 'Invoice', 7: 'Token',
  8: 'External funding', 12: 'PayPal', 13: 'PayPal', 17: 'Direct debit', 20: 'Stored balance',
}

export function fundingWords(type: number | null | undefined): string | null {
  if (type === null || type === undefined) return null
  return FUNDING_WORDS[type] ?? 'Other'
}

/** The payment detector only runs for card (1) or direct debit (17). */
export function fundingTracksPayments(type: number | null | undefined): boolean {
  return type === 1 || type === 17
}

/** Billing deep link, built only from an allowed id. */
export function billingUrl(adAccountId: string): string {
  const digits = adAccountId.replace(/^act_/, '')
  return /^\d{5,20}$/.test(digits)
    ? `https://business.facebook.com/billing_hub/accounts/details?asset_id=${digits}`
    : 'https://business.facebook.com/billing_hub/accounts'
}

// ── Health badges (§3.8) ───────────────────────────────────────────────────────

/** Consecutive trailing days (newest first in time) with spend > 0 and leads = 0. */
export function zeroLeadStreak(days: { date: string; spend: number; leads: number }[]): number {
  const sorted = [...days].sort((a, b) => b.date.localeCompare(a.date))
  let n = 0
  for (const d of sorted) {
    if (d.spend > 0 && d.leads === 0) n++
    else break
  }
  return n
}

export function healthFlags(m7: Metrics | null): { highFrequency: boolean; lowCtr: boolean } {
  if (!m7) return { highFrequency: false, lowCtr: false }
  return {
    highFrequency: m7.frequency !== null && m7.frequency > 2.5,
    lowCtr: m7.impressions >= 1000 && m7.ctr !== null && m7.ctr < 1,
  }
}
