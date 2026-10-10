import { describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { AdAccountNotAllowedError } from './allowlist'
import { classifyGraphError, createGraphClient, graphBase, MetaGraphError, parseUsageHeaders, type Route } from './graph-client'
import { ALLOWED_ACCOUNT, ALLOWED_DIGITS, FOREIGN_ACCOUNT, FOREIGN_DIGITS, IDS } from '../../../../tests/fixtures/meta-graph/ids'
import { fakeGraph } from '../../../../tests/fixtures/meta-graph/fake-graph'

const ORG = 'org_bound_gc'
const TOKEN = 'TEST-TOKEN-never-real-0001'
const SECRET = 'test-app-secret-0001'
const ENV = { NODE_ENV: 'test', META_ADS_ORG_ID: ORG, META_ALLOWED_AD_ACCOUNTS: ALLOWED_ACCOUNT }

function make(over: Partial<Parameters<typeof createGraphClient>[0]> = {}, fake = fakeGraph()) {
  const fetchSpy = vi.fn(fake.fetchImpl)
  const refusals: string[] = []
  const usage: number[] = []
  const client = createGraphClient({
    orgId: ORG, token: TOKEN, appId: 'ads-app-1', appSecret: SECRET, env: ENV, fetchImpl: fetchSpy as typeof fetch,
    objectAllowed: async (id) => ([IDS.campaignA, IDS.adSetA1, IDS.adA1a] as string[]).includes(id),
    onRefusal: (ref) => { refusals.push(ref) },
    onUsage: (u) => { usage.push(u.maxPct) },
    ...over,
  })
  return { client, fetchSpy, calls: fake.calls, refusals, usage }
}

async function refusedBeforeFetch(route: Route | Route[], kind: 'get' | 'pages' | 'batch' = 'get') {
  const { client, fetchSpy } = make()
  const p = kind === 'batch' ? client.batch(route as Route[]) : kind === 'pages' ? client.getAllPages(route as Route) : client.get(route as Route)
  await expect(p).rejects.toBeInstanceOf(AdAccountNotAllowedError)
  expect(fetchSpy).not.toHaveBeenCalled()
}

describe('graphBase', () => {
  it('defaults to v25.0 and validates the override', () => {
    expect(graphBase({})).toBe('https://graph.facebook.com/v25.0')
    expect(graphBase({ META_GRAPH_VERSION: 'v26.0' })).toBe('https://graph.facebook.com/v26.0')
    expect(graphBase({ META_GRAPH_VERSION: 'v26.0/../me' })).toBe('https://graph.facebook.com/v25.0')
  })
})

describe('route table: every bypass is refused before fetch', () => {
  it('/{campaign_id}/insights for an unknown or foreign id', async () => {
    await refusedBeforeFetch({ r: 'objectInsights', objectId: '6100009999', params: { level: 'campaign' } })
    await refusedBeforeFetch({ r: 'objectInsights', objectId: IDS.foreignCampaign, params: { level: 'campaign' } })
  })
  it('/{adset_id}/ads', async () => {
    await refusedBeforeFetch({ r: 'object', objectId: `${IDS.adSetA1}/ads`, fields: 'ad' })
    await refusedBeforeFetch({ r: 'edge', account: IDS.adSetA1, edge: 'ads' })
  })
  it('/{ad_id}?fields=… other than account_id', async () => {
    await refusedBeforeFetch({ r: 'object', objectId: IDS.foreignAd, fields: 'ad' })
    await refusedBeforeFetch({ r: 'object', objectId: IDS.adA1a, fields: 'name,account_id{name}' as never })
  })
  it('ids=1,2,3', async () => {
    await refusedBeforeFetch({ r: 'object', objectId: '6100000001,6100000002', fields: 'campaign' })
    await refusedBeforeFetch({ r: 'ownership', objectId: '?ids=6100000001,6100000002' })
    await refusedBeforeFetch({ r: 'ownership', objectId: '6100000001&ids=6900000001' })
  })
  it('a batch relative_url with an object id outside the allowlist', async () => {
    await refusedBeforeFetch([{ r: 'object', objectId: IDS.foreignCampaign, fields: 'campaign' }], 'batch')
    // paged edges are never batched
    await refusedBeforeFetch([{ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'ads' }], 'batch')
  })
  it('me?fields=adaccounts{…}', async () => {
    await refusedBeforeFetch({ r: 'object', objectId: 'me', fields: 'campaign' })
    await refusedBeforeFetch({ r: 'object', objectId: 'me?fields=adaccounts{name}', fields: 'campaign' })
  })
  it('{business}?fields=owned_ad_accounts{…}', async () => {
    await refusedBeforeFetch({ r: 'object', objectId: '5550001111', fields: 'campaign' })
    await refusedBeforeFetch({ r: 'object', objectId: IDS.campaignA, fields: 'owned_ad_accounts{id}' as never })
  })
  it('{business}/client_ad_accounts', async () => {
    await refusedBeforeFetch({ r: 'edge', account: '5550001111', edge: 'client_ad_accounts' as never })
    await refusedBeforeFetch({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'client_ad_accounts' as never })
  })
  it('URL-encoded act%5F for a foreign account', async () => {
    await refusedBeforeFetch({ r: 'account', account: 'act%5F999000111222333', fields: 'snapshot' })
    await refusedBeforeFetch({ r: 'edge', account: 'act%255F999000111222333', edge: 'campaigns' })
    await refusedBeforeFetch({ r: 'edge', account: FOREIGN_ACCOUNT, edge: 'insights', params: { level: 'ad' } })
  })
  it('a version prefix inside a batch relative_url', async () => {
    await refusedBeforeFetch([{ r: 'object', objectId: `v19.0/${IDS.campaignA}`, fields: 'campaign' }], 'batch')
    await refusedBeforeFetch([{ r: 'ownership', objectId: `/v19.0/${IDS.campaignA}` }], 'batch')
  })
  it('bad insight params and an unknown route', async () => {
    await refusedBeforeFetch({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'insights', params: { level: 'business' as never } })
    await refusedBeforeFetch({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'insights', params: { level: 'ad', timeRange: { since: '2026-01-01&x=1', until: '2026-01-02' } } })
    await refusedBeforeFetch({ r: 'nope' } as never)
  })
  it('writes are refused while META_ADS_WRITES_ENABLED is off, and for objects without a local allowed row', async () => {
    const { client, fetchSpy } = make()
    await expect(client.post({ r: 'write', objectId: IDS.campaignA, form: { status: 'PAUSED' } })).rejects.toBeInstanceOf(AdAccountNotAllowedError)
    const on = make({ writesEnabled: true })
    await expect(on.client.post({ r: 'write', objectId: IDS.foreignCampaign, form: { status: 'PAUSED' } })).rejects.toBeInstanceOf(AdAccountNotAllowedError)
    await expect(on.client.post({ r: 'write', objectId: IDS.campaignA, form: { name: 'x' } })).rejects.toBeInstanceOf(AdAccountNotAllowedError)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(on.fetchSpy).not.toHaveBeenCalled()
  })
  it('a client for any workspace other than the bound one sends nothing', async () => {
    const { client, fetchSpy } = make({ orgId: 'org_other' })
    await expect(client.get({ r: 'account', account: ALLOWED_ACCOUNT, fields: 'snapshot' })).rejects.toBeInstanceOf(AdAccountNotAllowedError)
    await expect(client.get({ r: 'myAccounts' })).rejects.toBeInstanceOf(AdAccountNotAllowedError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('allowed routes', () => {
  it('an encoded allowed id is normalized, and fields come from the fixed table', async () => {
    const { client, calls } = make()
    await client.get({ r: 'account', account: 'act%5F1742876583597558', fields: 'snapshot' })
    expect(calls[0].url.pathname).toBe(`/v25.0/${ALLOWED_ACCOUNT}`)
    expect(calls[0].url.searchParams.get('fields')).toContain('funding_source_details')
  })
  it('ownership sends only fields=account_id and returns no account id', async () => {
    const fake = fakeGraph({ owners: { [IDS.foreignAd]: FOREIGN_DIGITS, [IDS.adA1a]: ALLOWED_DIGITS } })
    const { client, calls } = make({}, fake)
    const foreign = await client.get<{ allowed: boolean }>({ r: 'ownership', objectId: IDS.foreignAd })
    const mine = await client.get<{ allowed: boolean }>({ r: 'ownership', objectId: IDS.adA1a })
    expect(foreign.body).toEqual({ allowed: false, present: true })
    expect(mine.body).toEqual({ allowed: true, present: true })
    expect(JSON.stringify(foreign.body)).not.toContain(FOREIGN_DIGITS)
    for (const c of calls) expect([...c.url.searchParams.keys()].filter((k) => k !== 'appsecret_proof')).toEqual(['fields'])
    expect(calls.every((c) => c.url.searchParams.get('fields') === 'account_id')).toBe(true)
  })
  it('a response row with a foreign account_id is dropped and audited once', async () => {
    const { client, refusals } = make({}, fakeGraph({ includeForeignRows: true }))
    const r = await client.getAllPages<{ id: string; account_id: string; name: string }>({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'campaigns' })
    expect(r.data.map((x) => x.id)).toEqual([IDS.campaignA, IDS.campaignB])
    expect(JSON.stringify(r.data)).not.toContain(FOREIGN_DIGITS)
    await client.getAllPages({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'campaigns' })
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).not.toMatch(/\d/)
  })
  it('myAccounts returns no foreign ids', async () => {
    const { client, calls } = make({}, fakeGraph({ othersVisible: true }))
    const { body } = await client.get<{ allowedVisible: string[]; othersVisible: boolean }>({ r: 'myAccounts' })
    expect(body).toEqual({ allowedVisible: [ALLOWED_ACCOUNT], othersVisible: true })
    expect(JSON.stringify(body)).not.toContain(FOREIGN_DIGITS)
    expect(calls[0].url.searchParams.get('fields')).toBe('id,account_id')
  })
  it('debug_token reports only a count of foreign targets', async () => {
    const { client, calls } = make({}, fakeGraph({ token: { adsReadTargets: [ALLOWED_DIGITS, FOREIGN_DIGITS] } }))
    const { body } = await client.get<{ adsRead: { allowed: string[]; others: number } }>({ r: 'debugToken' })
    expect(body.adsRead).toEqual({ allowed: [ALLOWED_ACCOUNT], others: 1 })
    expect(JSON.stringify(body)).not.toContain(FOREIGN_DIGITS)
    // The token is never in a URL; debug_token carries it in the POST body only.
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url.toString()).not.toContain(TOKEN)
    expect(calls[0].url.searchParams.has('appsecret_proof')).toBe(false)
  })
  it('debug_token without target ids: "unreported" for a system user, "all" for anyone else', async () => {
    const su = make({}, fakeGraph({ token: { adsReadTargets: 'all', type: 'SYSTEM_USER' } }))
    expect((await su.client.get<{ adsRead: unknown }>({ r: 'debugToken' })).body.adsRead).toEqual({ unreported: true })
    const user = make({}, fakeGraph({ token: { adsReadTargets: 'all', type: 'USER' } }))
    expect((await user.client.get<{ adsRead: unknown }>({ r: 'debugToken' })).body.adsRead).toEqual({ all: true })
  })
})

describe('token and proof', () => {
  it('the token travels in the Authorization header only', async () => {
    const { client, calls } = make()
    await client.get({ r: 'account', account: ALLOWED_ACCOUNT, fields: 'snapshot' })
    await client.getAllPages({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'ads' })
    await client.batch([{ r: 'account', account: ALLOWED_ACCOUNT, fields: 'snapshot' }])
    for (const c of calls) {
      expect(c.auth).toBe(`Bearer ${TOKEN}`)
      expect(c.url.toString()).not.toContain(TOKEN)
      expect(c.url.searchParams.has('access_token')).toBe(false)
      expect(c.body ?? '').not.toContain(TOKEN)
    }
  })
  it('appsecret_proof is sent by default (tokenAppId unknown or matching), not for a known other app', async () => {
    const proof = createHmac('sha256', SECRET).update(TOKEN).digest('hex')
    // Regression: with "Require App Secret" on, a first sync (tokenAppId still
    // null) must already carry the proof, or nothing ever succeeds.
    const none = make({ tokenAppId: null })
    await none.client.get({ r: 'account', account: ALLOWED_ACCOUNT, fields: 'snapshot' })
    expect(none.calls[0].url.searchParams.get('appsecret_proof')).toBe(proof)
    const other = make({ tokenAppId: 'some-other-app' })
    await other.client.get({ r: 'account', account: ALLOWED_ACCOUNT, fields: 'snapshot' })
    expect(other.calls[0].url.searchParams.has('appsecret_proof')).toBe(false)
    const match = make({ tokenAppId: 'ads-app-1' })
    await match.client.get({ r: 'account', account: ALLOWED_ACCOUNT, fields: 'snapshot' })
    expect(match.calls[0].url.searchParams.get('appsecret_proof')).toBe(proof)
    const noSecret = make({ appSecret: undefined, tokenAppId: null })
    await noSecret.client.get({ r: 'account', account: ALLOWED_ACCOUNT, fields: 'snapshot' })
    expect(noSecret.calls[0].url.searchParams.has('appsecret_proof')).toBe(false)
  })
  it('an app that requires the proof works on the first run, debug_token included (proof in the POST body)', async () => {
    const proof = createHmac('sha256', SECRET).update(TOKEN).digest('hex')
    const requireProof = (u: URL, method: string) => {
      void method
      return u.pathname === `/v25.0/${ALLOWED_ACCOUNT}` && !u.searchParams.has('appsecret_proof')
        ? { status: 400, body: { error: { code: 100, message: 'API calls from the server require an appsecret_proof argument' } } }
        : null
    }
    const { client, calls } = make({ tokenAppId: null }, fakeGraph({ errorFor: requireProof }))
    await expect(client.get({ r: 'account', account: ALLOWED_ACCOUNT, fields: 'snapshot' })).resolves.toBeTruthy()
    await client.get({ r: 'debugToken' })
    const dbg = calls.find((c) => c.method === 'POST')!
    expect(new URLSearchParams(dbg.body ?? '').get('appsecret_proof')).toBe(proof)
    expect(dbg.url.searchParams.has('appsecret_proof')).toBe(false)
  })
  it('"Invalid appsecret_proof" is retried once without the proof, then the client stops sending it', async () => {
    const badProof = (u: URL) =>
      u.searchParams.has('appsecret_proof')
        ? { status: 400, body: { error: { code: 100, message: 'Invalid appsecret_proof provided in the API argument' } } }
        : null
    const { client, calls } = make({ tokenAppId: null }, fakeGraph({ errorFor: badProof }))
    await client.get({ r: 'account', account: ALLOWED_ACCOUNT, fields: 'snapshot' })
    await client.getAllPages({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'campaigns' })
    expect(calls.map((c) => c.url.searchParams.has('appsecret_proof'))).toEqual([true, false, false])
  })
  it('a missing proof and a mismatched proof get different plain-English messages', () => {
    const missing = classifyGraphError(400, { code: 100, message: 'API calls from the server require an appsecret_proof argument' })
    const invalid = classifyGraphError(400, { code: 100, message: 'Invalid appsecret_proof provided in the API argument' })
    expect(missing.kind).toBe('config')
    expect(invalid.kind).toBe('config')
    expect(missing.plain).toMatch(/requires the app secret/)
    expect(invalid.plain).toMatch(/same Meta app/)
  })
  it('errors contain no token, proof, URL or Meta message', async () => {
    const fake = fakeGraph({ errorFor: () => ({ status: 400, body: { error: { code: 190, error_subcode: 463, message: `Session expired for ${TOKEN} at https://graph.facebook.com/x` } } }) })
    const { client } = make({ tokenAppId: 'ads-app-1' }, fake)
    const err = await client.get({ r: 'account', account: ALLOWED_ACCOUNT, fields: 'snapshot' }).catch((e) => e)
    expect(err).toBeInstanceOf(MetaGraphError)
    const text = `${err.message} ${err.plain} ${JSON.stringify(err)}`
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(createHmac('sha256', SECRET).update(TOKEN).digest('hex'))
    expect(text).not.toContain('graph.facebook.com')
    expect(text).not.toContain('Session expired')
    expect(err.kind).toBe('token')
  })
})

describe('paging', () => {
  it('limit 500, cursor paging outside any batch, truncated surfaced', async () => {
    let page = 0
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      void input
      page++
      const data = [{ id: String(6100000000 + page), account_id: ALLOWED_DIGITS }]
      return new Response(JSON.stringify({ data, paging: { cursors: { after: `CUR${page}` }, next: `https://graph.facebook.com/v25.0/next?after=CUR${page}&access_token=leak` } }), { status: 200, headers: { 'x-app-usage': '{"call_count":5}' } })
    })
    const { client } = make({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await client.getAllPages({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'campaigns' }, 3)
    expect(r.data).toHaveLength(3)
    expect(r.truncated).toBe(true)
    const urls = fetchImpl.mock.calls.map((c) => new URL(String(c[0])))
    expect(urls.every((u) => u.searchParams.get('limit') === '500')).toBe(true)
    expect(urls[0].searchParams.has('after')).toBe(false)
    expect(urls[1].searchParams.get('after')).toBe('CUR1')
    // We rebuild from the cursor; Meta's `next` URL (and anything in it) is never followed.
    expect(urls.every((u) => !u.toString().includes('leak') && u.pathname === `/v25.0/${ALLOWED_ACCOUNT}/campaigns`)).toBe(true)
  })
  it('stops cleanly on the last page', async () => {
    const { client } = make()
    const r = await client.getAllPages({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'adsets' })
    expect(r.truncated).toBe(false)
  })
  it('insight calls ask for conversion-time leads', async () => {
    const { client, calls } = make()
    await client.getAllPages({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'insights', params: { level: 'ad', datePreset: 'last_7d' } })
    const q = calls[0].url.searchParams
    expect(q.get('action_report_time')).toBe('conversion')
    expect(q.get('use_unified_attribution_setting')).toBe('true')
    expect(q.get('level')).toBe('ad')
    expect(q.get('fields')).toContain('account_id')
  })
  it('ad, ad set and campaign insights ask for archived and deleted objects; account level has no filter', async () => {
    const { client, calls } = make()
    for (const level of ['ad', 'adset', 'campaign', 'account'] as const) {
      await client.getAllPages({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'insights', params: { level, datePreset: 'maximum' } })
    }
    const filters = calls.map((c) => c.url.searchParams.get('filtering'))
    for (const [i, level] of (['ad', 'adset', 'campaign'] as const).entries()) {
      const f = JSON.parse(filters[i]!) as { field: string; operator: string; value: string[] }[]
      expect(f).toHaveLength(1)
      expect(f[0].field).toBe(`${level}.effective_status`)
      expect(f[0].operator).toBe('IN')
      expect(f[0].value).toEqual(expect.arrayContaining(['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED']))
    }
    expect(filters[3]).toBeNull()
  })
  it('hourly insights ask for spend only (no reach or frequency)', async () => {
    const { client, calls } = make()
    await client.getAllPages({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'insights', params: { level: 'account', timeRange: { since: '2026-10-01', until: '2026-10-01' }, hourly: true } })
    expect(calls[0].url.searchParams.get('fields')).toBe('account_id,spend')
    expect(calls[0].url.searchParams.get('breakdowns')).toBe('hourly_stats_aggregated_by_advertiser_time_zone')
  })
})

describe('usage headers', () => {
  it('parses all three headers', () => {
    const h = new Headers({
      'x-business-use-case-usage': JSON.stringify({ '123': [{ type: 'ads_insights', call_count: 12, total_cputime: 40, total_time: 30, estimated_time_to_regain_access: 2 }] }),
      'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 55.4, reset_time_duration: 30 }),
      'x-app-usage': JSON.stringify({ call_count: 3, total_cputime: 1, total_time: 2 }),
    })
    // reset_time_duration is kept apart: it is a decay time, not a block.
    expect(parseUsageHeaders(h)).toEqual({ maxPct: 55, regainSeconds: 120, resetSeconds: 30 })
    expect(parseUsageHeaders(new Headers())).toBeNull()
    expect(parseUsageHeaders(new Headers({ 'x-app-usage': 'not json' }))).toBeNull()
  })
  it('low usage with a reset_time_duration is not a throttle', () => {
    // Meta's own example: {acc_id_util_pct: 9.67, reset_time_duration: 100}.
    const u = parseUsageHeaders(new Headers({ 'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 5, reset_time_duration: 100 }) }))!
    expect(u).toEqual({ maxPct: 5, regainSeconds: 0, resetSeconds: 100 })
  })
  it('is checked after every response, errors included', async () => {
    let n = 0
    const fake = fakeGraph({
      usageFor: () => ({ 'x-app-usage': JSON.stringify({ call_count: ++n * 10 }) }),
      errorFor: (u) => (u.pathname.endsWith('/adsets') ? { status: 500, body: { error: { code: 2, message: 'x' } } } : null),
    })
    const { client, usage } = make({}, fake)
    await client.get({ r: 'account', account: ALLOWED_ACCOUNT, fields: 'snapshot' })
    await client.getAllPages({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'campaigns' })
    await client.getAllPages({ r: 'edge', account: ALLOWED_ACCOUNT, edge: 'adsets' }).catch(() => null)
    expect(usage).toEqual([10, 20, 30])
  })
})

describe('classifyGraphError', () => {
  const cases: [number, { code?: number; error_subcode?: number; message?: string }, string, RegExp?][] = [
    [400, { code: 190, error_subcode: 463 }, 'token', /expired/],
    [400, { code: 190, error_subcode: 460 }, 'token', /signed out or revoked/],
    [400, { code: 190, error_subcode: 467 }, 'token', /signed out or revoked/],
    [400, { code: 190, error_subcode: 458 }, 'token', /removed from the system user/],
    [400, { code: 190 }, 'token', /no longer valid/],
    [400, { code: 102 }, 'token'],
    [400, { code: 100, message: 'Invalid appsecret_proof provided in the API argument' }, 'config', /same Meta app/],
    [500, { code: 1 }, 'transient'],
    [500, { code: 2 }, 'transient'],
    [502, {}, 'transient'],
    [400, { code: 368 }, 'blocked'],
    [400, { code: 4 }, 'rate'],
    [400, { code: 17 }, 'rate'],
    [400, { code: 32 }, 'rate'],
    [400, { code: 613 }, 'rate'],
    [400, { code: 80004 }, 'rate'],
    [429, {}, 'rate'],
    [400, { code: 10 }, 'permission', /View performance/],
    [400, { code: 200 }, 'permission'],
    [403, {}, 'permission'],
    [400, { code: 100, error_subcode: 33 }, 'not_found'],
    [400, { code: 999 }, 'other'],
  ]
  it.each(cases)('HTTP %s %j → %s', (status, err, kind, copy) => {
    const r = classifyGraphError(status, err)
    expect(r.kind).toBe(kind)
    if (copy) expect(r.plain).toMatch(copy)
  })
})
