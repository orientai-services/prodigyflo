/**
 * A fake Graph API for tests. Routes by path and query the way the guarded
 * client builds them. Nothing here reaches Meta. Every request is recorded so
 * tests can assert what was (and was not) sent.
 */
import { ALLOWED_ACCOUNT, ALLOWED_DIGITS, FOREIGN_ACCOUNT, FOREIGN_DIGITS, FOREIGN_NAMES, FOREIGN_SPEND, IDS } from './ids'

export type GraphCall = { url: URL; method: string; auth: string | null; body: string | null }

export type FakeGraphOptions = {
  balanceCents?: () => number
  amountSpentCents?: () => number
  fundingType?: number
  accountStatus?: () => number
  /** Edges and insights also return a row from the foreign account (must be dropped). */
  includeForeignRows?: boolean
  /** Return an error for a matching request. */
  errorFor?: (url: URL, method: string) => { status: number; body: unknown } | null
  /** Usage headers per request. */
  usageFor?: (url: URL) => Record<string, string> | null
  othersVisible?: boolean
  token?: { appId?: string; type?: string; adsReadTargets?: string[] | 'all'; valid?: boolean }
  /** objectId → owning account digits (ownership probes). */
  owners?: Record<string, string>
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })

const WINDOW_ACCOUNT_SPEND: Record<string, number> = { today: 10, last_7d: 140, last_30d: 600, this_month: 300, maximum: 5000 }
/** Ad shares of the window spend. Their sum is 595/600 of the account, so the tree needs a remainder row. */
const AD_SHARE: [string, string, string, number, number][] = [
  // ad, adset, campaign, share of account spend, leads per $100
  [IDS.adA1a, IDS.adSetA1, IDS.campaignA, 200 / 600, 2],
  [IDS.adA1b, IDS.adSetA1, IDS.campaignA, 150 / 600, 1],
  [IDS.adA2a, IDS.adSetA2, IDS.campaignA, 100 / 600, 0],
  [IDS.adB1a, IDS.adSetB1, IDS.campaignB, 145 / 600, 3],
]

/** The archived ad spent a little; Meta returns it only with an effective_status filter. Sum stays under the account (remainder 3/600). */
export const ARCHIVED_SHARE: [string, string, string, number, number] = [IDS.adArchived, IDS.adSetB1, IDS.campaignB, 2 / 600, 0]

function insightRow(extra: Record<string, unknown>, spend: number, leads: number) {
  return {
    account_id: ALLOWED_DIGITS,
    spend: spend.toFixed(2),
    impressions: String(Math.round(spend * 100)),
    reach: String(Math.round(spend * 60)),
    clicks: String(Math.round(spend * 2)),
    inline_link_clicks: String(Math.round(spend * 1.5)),
    frequency: '1.667',
    // Fixed order: lead_grouped wins over lead.
    actions: [
      { action_type: 'lead', value: String(leads + 100) },
      { action_type: 'onsite_conversion.lead_grouped', value: String(leads) },
      { action_type: 'landing_page_view', value: String(Math.round(spend)) },
    ],
    ...extra,
  }
}

const foreignInsight = (extra: Record<string, unknown>) => ({ ...insightRow(extra, FOREIGN_SPEND, 7), account_id: FOREIGN_DIGITS })

function daysBetween(since: string, until: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(`${since}T00:00:00Z`); t <= Date.parse(`${until}T00:00:00Z`) && out.length < 400; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

export function fakeGraph(o: FakeGraphOptions = {}) {
  const calls: GraphCall[] = []

  function route(url: URL, method: string): { status: number; body: unknown; headers?: Record<string, string> } {
    const err = o.errorFor?.(url, method)
    if (err) return err
    const parts = url.pathname.split('/').filter(Boolean) // ['v25.0', ...]
    const path = parts.slice(1)
    const q = url.searchParams
    const foreign = Boolean(o.includeForeignRows)

    if (path[0] === 'debug_token') {
      const t = o.token ?? {}
      const targets = t.adsReadTargets ?? [ALLOWED_DIGITS]
      return {
        status: 200,
        body: {
          data: {
            app_id: t.appId ?? 'ads-app-1', type: t.type ?? 'SYSTEM_USER', is_valid: t.valid ?? true, expires_at: 0,
            scopes: ['ads_read', 'read_insights'],
            granular_scopes: [targets === 'all' ? { scope: 'ads_read' } : { scope: 'ads_read', target_ids: targets }],
          },
        },
      }
    }
    if (path[0] === 'me' && path[1] === 'adaccounts') {
      const data = [{ id: ALLOWED_ACCOUNT, account_id: ALLOWED_DIGITS }]
      if (o.othersVisible) data.push({ id: FOREIGN_ACCOUNT, account_id: FOREIGN_DIGITS })
      return { status: 200, body: { data } }
    }
    if (path[0]?.startsWith('act_')) {
      if (path[0] !== ALLOWED_ACCOUNT) return { status: 200, body: { id: path[0], account_id: path[0].slice(4), name: FOREIGN_NAMES.campaign } }
      if (path.length === 1) {
        return {
          status: 200,
          body: {
            id: ALLOWED_ACCOUNT, account_id: ALLOWED_DIGITS, name: 'SCS General 1', currency: 'USD', timezone_name: 'America/Los_Angeles',
            account_status: o.accountStatus?.() ?? 1, disable_reason: 0,
            balance: String(o.balanceCents?.() ?? 12345), amount_spent: String(o.amountSpentCents?.() ?? 987654), spend_cap: '0',
            funding_source_details: { display_string: 'Visa *0000', type: o.fundingType ?? 1 },
          },
        }
      }
      const edge = path[1]
      if (edge === 'campaigns') {
        const data: Record<string, unknown>[] = [
          { id: IDS.campaignA, account_id: ALLOWED_DIGITS, name: 'Campaign A', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_LEADS', daily_budget: '5000', created_time: '2026-09-01T10:00:00+0000' },
          { id: IDS.campaignB, account_id: ALLOWED_DIGITS, name: 'Campaign B', status: 'PAUSED', effective_status: 'PAUSED', objective: 'OUTCOME_LEADS', lifetime_budget: '100000', created_time: '2026-09-02T10:00:00+0000' },
        ]
        if (foreign) data.push({ id: IDS.foreignCampaign, account_id: FOREIGN_DIGITS, name: FOREIGN_NAMES.campaign, status: 'ACTIVE' })
        return { status: 200, body: { data } }
      }
      if (edge === 'adsets') {
        const data: Record<string, unknown>[] = [
          { id: IDS.adSetA1, account_id: ALLOWED_DIGITS, campaign_id: IDS.campaignA, name: 'Ad set A1', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '3000' },
          { id: IDS.adSetA2, account_id: ALLOWED_DIGITS, campaign_id: IDS.campaignA, name: 'Ad set A2', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '2000' },
          { id: IDS.adSetB1, account_id: ALLOWED_DIGITS, campaign_id: IDS.campaignB, name: 'Ad set B1', status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED' },
        ]
        if (foreign) data.push({ id: IDS.foreignAdSet, account_id: FOREIGN_DIGITS, campaign_id: IDS.foreignCampaign, name: FOREIGN_NAMES.adSet })
        return { status: 200, body: { data } }
      }
      if (edge === 'ads') {
        const creative = (title: string) => ({ id: '7000', thumbnail_url: 'https://example.com/t.jpg', object_story_spec: { link_data: { name: title, message: 'Body', link: 'https://example.com/x?utm=1', call_to_action: { type: 'LEARN_MORE' } } } })
        const data: Record<string, unknown>[] = [
          { id: IDS.adA1a, account_id: ALLOWED_DIGITS, campaign_id: IDS.campaignA, adset_id: IDS.adSetA1, name: 'Ad A1a', status: 'ACTIVE', effective_status: 'ACTIVE', creative: creative('Headline A1a') },
          { id: IDS.adA1b, account_id: ALLOWED_DIGITS, campaign_id: IDS.campaignA, adset_id: IDS.adSetA1, name: 'Ad A1b', status: 'ACTIVE', effective_status: 'ACTIVE', creative: creative('Headline A1b') },
          { id: IDS.adA2a, account_id: ALLOWED_DIGITS, campaign_id: IDS.campaignA, adset_id: IDS.adSetA2, name: 'Ad A2a', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { asset_feed_spec: { titles: [{ text: 'Adv+ title' }], bodies: [{ text: 'Adv+ body' }], call_to_action_types: ['SIGN_UP'], link_urls: [{ website_url: 'https://example.com/apply' }] } } },
          { id: IDS.adB1a, account_id: ALLOWED_DIGITS, campaign_id: IDS.campaignB, adset_id: IDS.adSetB1, name: 'Ad B1a', status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED', creative: creative('Headline B1a') },
          { id: IDS.adArchived, account_id: ALLOWED_DIGITS, campaign_id: IDS.campaignB, adset_id: IDS.adSetB1, name: 'Ad archived', status: 'ARCHIVED', effective_status: 'ARCHIVED', creative: creative('Old') },
        ]
        if (foreign) data.push({ id: IDS.foreignAd, account_id: FOREIGN_DIGITS, campaign_id: IDS.foreignCampaign, adset_id: IDS.foreignAdSet, name: FOREIGN_NAMES.ad })
        return { status: 200, body: { data } }
      }
      if (edge === 'insights') {
        const level = q.get('level') ?? 'account'
        const daily = q.get('time_increment') === '1'
        const hourly = q.get('breakdowns') === 'hourly_stats_aggregated_by_advertiser_time_zone'
        const range = q.get('time_range') ? (JSON.parse(q.get('time_range')!) as { since: string; until: string }) : null
        const preset = q.get('date_preset') ?? 'last_30d'
        if (hourly) {
          return { status: 200, body: { data: Array.from({ length: 24 }, (_, h) => ({ account_id: ALLOWED_DIGITS, spend: '1.00', hourly_stats_aggregated_by_advertiser_time_zone: `${String(h).padStart(2, '0')}:00:00 - ${String(h).padStart(2, '0')}:59:59` })) } }
        }
        if (daily && range) {
          const days = daysBetween(range.since, range.until)
          if (level === 'account') {
            const data: Record<string, unknown>[] = days.map((d) => insightRow({ date_start: d, date_stop: d }, 20, 2))
            if (foreign) data.push(foreignInsight({ date_start: days[0], date_stop: days[0] }))
            return { status: 200, body: { data } }
          }
          const data: Record<string, unknown>[] = days.flatMap((d) => [
            insightRow({ date_start: d, date_stop: d, campaign_id: IDS.campaignA }, 15, 2),
            insightRow({ date_start: d, date_stop: d, campaign_id: IDS.campaignB }, 5, 0),
          ])
          if (foreign) data.push(foreignInsight({ date_start: days[0], date_stop: days[0], campaign_id: IDS.foreignCampaign }))
          return { status: 200, body: { data } }
        }
        const total = WINDOW_ACCOUNT_SPEND[preset] ?? 600
        if (level === 'account') return { status: 200, body: { data: [insightRow({ date_start: '2026-09-01', date_stop: '2026-10-08' }, total, Math.round(total / 50))] } }
        if (level === 'ad') {
          // Like Meta: archived/deleted ads only come back when `filtering` asks for them.
          const filtering = q.get('filtering') ?? ''
          const shares = filtering.includes('ad.effective_status') && filtering.includes('ARCHIVED') ? [...AD_SHARE, ARCHIVED_SHARE] : AD_SHARE
          const data: Record<string, unknown>[] = shares.map(([ad, set, camp, share, lp100]) => {
            const spend = Math.round(total * share * 100) / 100
            return insightRow({ ad_id: ad, adset_id: set, campaign_id: camp }, spend, Math.round((spend * lp100) / 100))
          })
          if (foreign) data.push(foreignInsight({ ad_id: IDS.foreignAd, adset_id: IDS.foreignAdSet, campaign_id: IDS.foreignCampaign }))
          return { status: 200, body: { data } }
        }
        return { status: 200, body: { data: [] } }
      }
      return { status: 400, body: { error: { code: 100, message: 'unknown edge' } } }
    }
    if (path.length === 1 && /^\d+$/.test(path[0])) {
      if (q.get('fields') === 'account_id') {
        const owner = o.owners?.[path[0]]
        if (!owner) return { status: 400, body: { error: { code: 100, error_subcode: 33, message: 'does not exist' } } }
        return { status: 200, body: { id: path[0], account_id: owner } }
      }
      return { status: 200, body: { id: path[0], account_id: ALLOWED_DIGITS, name: 'object' } }
    }
    return { status: 404, body: { error: { code: 100, message: 'no route' } } }
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname !== 'graph.facebook.com') throw new Error(`unexpected network call to ${url.hostname}`)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const body = init?.body ? String(init.body) : null
    calls.push({ url, method, auth: headers.get('authorization'), body })
    const usage = o.usageFor?.(url) ?? {}
    // Batch: POST to the bare version path.
    if (method === 'POST' && url.pathname.split('/').filter(Boolean).length === 1) {
      const form = new URLSearchParams(body ?? '')
      const batch = JSON.parse(form.get('batch') ?? '[]') as { method: string; relative_url: string }[]
      const results = batch.map((b) => {
        const inner = new URL(`${url.origin}${url.pathname}/${b.relative_url}`)
        const r = route(inner, 'GET')
        return { code: r.status, body: JSON.stringify(r.body) }
      })
      return ok(results, usage)
    }
    const r = route(url, method)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...usage } })
  }

  return { fetchImpl, calls }
}
