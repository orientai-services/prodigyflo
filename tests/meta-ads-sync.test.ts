/**
 * Meta Ads sync against a fake Graph (tests/fixtures/meta-graph). Nothing here
 * reaches Meta. DB-backed, like tests/meta.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { syncAdsForOrg, syncAllOrgs, assertWritableObject } from '@/lib/meta/ads/sync'
import { getAdsDashboard, getBillingView, getConnectionView, getCycleView, getFunnelView } from '@/lib/meta/ads/read'
import { GraphMetaAdsProvider } from '@/lib/meta/graph'
import { AdAccountNotAllowedError } from '@/lib/meta/ads/allowlist'
import { fakeGraph } from './fixtures/meta-graph/fake-graph'
import { ALLOWED_ACCOUNT, FOREIGN_DIGITS, FOREIGN_NAMES, IDS } from './fixtures/meta-graph/ids'
import { clearSharedRows, makeOrg, sessionFor, stubLiveEnv } from './fixtures/meta-graph/setup'

const run = `mads-${Date.now().toString(36)}`
let orgA: string
let orgB: string

beforeAll(async () => {
  await clearSharedRows()
  orgA = (await makeOrg(`${run}-a`)).id
  orgB = (await makeOrg(`${run}-b`)).id
})

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
  await clearSharedRows()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function resetAccount() {
  await db.metaAdAccount.deleteMany({ where: { organizationId: orgA } })
  await db.metaAccountSnapshot.deleteMany({ where: { organizationId: orgA } })
  await db.metaBillingEvent.deleteMany({ where: { organizationId: orgA } })
}

describe('separation: only the bound workspace', () => {
  beforeEach(() => stubLiveEnv(orgA))

  it('org B gets no Graph call, no rows, and not_connected from every view', async () => {
    const fake = fakeGraph()
    const r = await syncAdsForOrg(orgB, { fetchImpl: fake.fetchImpl, force: true })
    expect(r).toEqual([{ skipped: 'not_connected' }])
    expect(fake.calls).toHaveLength(0)
    for (const t of ['metaAdAccount', 'metaAd', 'metaInsightDaily', 'metaInsightSummary', 'metaAccountSnapshot', 'metaLeadTouch'] as const) {
      expect(await (db[t] as unknown as { count: (a: unknown) => Promise<number> }).count({ where: { organizationId: orgB } })).toBe(0)
    }
    const u = sessionFor(orgB)
    const dash = await getAdsDashboard(u, '30d')
    expect(dash.sync.mode).toBe('not_connected')
    expect(dash.account).toBeNull()
    expect(dash.tree).toEqual([])
    expect(await getBillingView(u)).toBeNull()
    expect((await getCycleView(u)).current).toBeNull()
    expect((await getFunnelView(u, '30d')).rows).toEqual([])
    const conn = await getConnectionView(u)
    expect(conn.mode).toBe('not_connected')
    expect(conn.boundHere).toBe(false)
    expect(conn.allowlist.accounts).toEqual([])
  })

  it('the cron syncs only the bound workspace', async () => {
    const fake = fakeGraph()
    const res = await syncAllOrgs({ fetchImpl: fake.fetchImpl, budgetMs: 60_000 })
    expect(res.adAccounts).toBe(1)
    expect(await db.metaAdAccount.count({ where: { organizationId: orgB } })).toBe(0)
    expect(await db.metaAdAccount.count({ where: { organizationId: orgA, adAccountId: ALLOWED_ACCOUNT } })).toBe(1)
  })
})

describe('full sync', () => {
  beforeEach(async () => {
    stubLiveEnv(orgA)
    await resetAccount()
  })

  it('writes adAccountId on everything and never stores foreign rows', async () => {
    const fake = fakeGraph({ includeForeignRows: true })
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true })
    expect('skipped' in r).toBe(false)
    if ('skipped' in r) return
    expect(r.error).toBeUndefined()
    expect(r.full).toBe(true)

    const campaigns = await db.campaign.findMany({ where: { organizationId: orgA, channel: 'meta' } })
    expect(campaigns.map((c) => c.externalId).sort()).toEqual([IDS.campaignA, IDS.campaignB])
    expect(campaigns.every((c) => c.adAccountId === ALLOWED_ACCOUNT)).toBe(true)
    expect(await db.adSet.count({ where: { organizationId: orgA, adAccountId: ALLOWED_ACCOUNT } })).toBe(3)
    const ads = await db.metaAd.findMany({ where: { organizationId: orgA } })
    expect(ads).toHaveLength(5)
    expect(ads.every((a) => a.adAccountId === ALLOWED_ACCOUNT)).toBe(true)
    expect(ads.find((a) => a.externalId === IDS.adA2a)?.headline).toBe('Adv+ title')
    for (const t of ['metaInsightDaily', 'metaInsightSummary', 'metaAccountSnapshot'] as const) {
      const rows = await (db[t] as unknown as { findMany: (a: unknown) => Promise<{ adAccountId: string }[]> }).findMany({ where: { organizationId: orgA } })
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((x) => x.adAccountId === ALLOWED_ACCOUNT)).toBe(true)
    }
    const all = JSON.stringify(await db.metaInsightSummary.findMany({ where: { organizationId: orgA } }))
    expect(all).not.toContain(FOREIGN_DIGITS)
    expect(await db.campaign.count({ where: { name: FOREIGN_NAMES.campaign } })).toBe(0)
    expect(await db.metaAd.count({ where: { name: FOREIGN_NAMES.ad } })).toBe(0)
    // Campaign daily stats feed the legacy consumers.
    expect(await db.campaignDailyStat.count({ where: { campaign: { organizationId: orgA, adAccountId: ALLOWED_ACCOUNT } } })).toBeGreaterThan(0)
    // Every dropped foreign row was audited, by hash only.
    const refusals = await db.auditEvent.findMany({ where: { organizationId: orgA, action: 'meta.ad_account.refused' } })
    expect(refusals.length).toBeGreaterThan(0)
    expect(JSON.stringify(refusals)).not.toContain(FOREIGN_DIGITS)
    // Token only in the header.
    expect(fake.calls.every((c) => !c.url.toString().includes('TEST-ADS-TOKEN'))).toBe(true)
  })

  it('the dashboard reads it back; the tree adds up to the account total', async () => {
    const fake = fakeGraph()
    await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true })
    const dash = await getAdsDashboard(sessionFor(orgA), '30d')
    expect(dash.sync.mode).toBe('live')
    expect(dash.account?.adAccountId).toBe(ALLOWED_ACCOUNT)
    expect(dash.account?.card).toBe('Visa *0000')
    expect(dash.totals.spend).toBe(600)
    const sum = dash.tree.reduce((a, n) => a + n.metrics.spend, 0)
    expect(Math.round(sum * 100) / 100).toBe(600)
    expect(dash.tree.some((n) => n.kind === 'remainder')).toBe(true)
    expect(dash.daily).toHaveLength(30)
    expect(dash.counts.ads).toBe(5)
    expect(dash.writesEnabled).toBe(false)
  })

  it('two parallel syncs: one emit, no duplicate campaigns, ads or billing rows', async () => {
    // Prime a pending payment: a big balance, then a drop.
    let balance = 50_000
    let spent = 1_000_000
    const fake = fakeGraph({ balanceCents: () => balance, amountSpentCents: () => spent })
    const t0 = Date.now()
    await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true, now: new Date(t0) })
    balance = 300; spent += 300
    await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, now: new Date(t0 + 600_000) })
    balance = 400; spent += 100
    await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, now: new Date(t0 + 1_200_000) })
    expect(await db.metaBillingEvent.count({ where: { organizationId: orgA, kind: 'PAYMENT' } })).toBe(0)

    balance = 500; spent += 100
    const now = new Date(t0 + 1_800_000)
    const [a, b] = await Promise.all([
      syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true, now }),
      syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true, now }),
    ])
    const skipped = [a[0], b[0]].filter((x) => 'skipped' in x)
    expect(skipped).toHaveLength(1)
    expect(await db.metaBillingEvent.count({ where: { organizationId: orgA, kind: 'PAYMENT' } })).toBe(1)
    const payment = await db.metaBillingEvent.findFirstOrThrow({ where: { organizationId: orgA, kind: 'PAYMENT' } })
    expect(Number(payment.amountCents)).toBe(49_700)
    for (const ext of [IDS.campaignA, IDS.campaignB]) {
      expect(await db.campaign.count({ where: { organizationId: orgA, externalId: ext } })).toBe(1)
    }
    expect(await db.metaAd.count({ where: { organizationId: orgA } })).toBe(5)
    const billing = await getBillingView(sessionFor(orgA))
    expect(billing?.ledger.filter((l) => l.kind === 'PAYMENT')).toHaveLength(1)
    expect(billing?.detector).toBe('on')
  })

  it('a stale replica reading is stored as stale and leaves the cached balance alone', async () => {
    let spent = 2_000_000
    const fake = fakeGraph({ balanceCents: () => 10_000, amountSpentCents: () => spent })
    const t0 = Date.now()
    await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true, now: new Date(t0) })
    spent = 5
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, now: new Date(t0 + 600_000) })
    expect('skipped' in r ? null : r.snapshot).toBe('stale')
    const acct = await db.metaAdAccount.findFirstOrThrow({ where: { organizationId: orgA } })
    expect(Number(acct.amountSpentCents)).toBe(2_000_000)
  })

  it('a status change writes a STATUS_CHANGE row and tells the Super Admins', async () => {
    let status = 1
    const fake = fakeGraph({ accountStatus: () => status })
    const t0 = Date.now()
    await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true, now: new Date(t0) })
    status = 9
    await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, now: new Date(t0 + 600_000) })
    const ev = await db.metaBillingEvent.findFirstOrThrow({ where: { organizationId: orgA, kind: 'STATUS_CHANGE' } })
    expect([ev.before, ev.after]).toEqual(['Active', 'Grace period'])
  })
})

describe('production and errors', () => {
  beforeEach(async () => {
    await resetAccount()
  })

  it('production with no credentials writes nothing and reads not_connected', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('META_ADS_ORG_ID', orgA)
    vi.stubEnv('META_ALLOWED_AD_ACCOUNTS', ALLOWED_ACCOUNT)
    vi.stubEnv('META_ADS_SYSTEM_USER_TOKEN', '')
    vi.stubEnv('META_ADS_APP_ID', '')
    vi.stubEnv('META_ADS_APP_SECRET', '')
    const fake = fakeGraph()
    expect(await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true })).toEqual([{ skipped: 'not_connected' }])
    expect(fake.calls).toHaveLength(0)
    expect(await db.metaAdAccount.count({ where: { organizationId: orgA } })).toBe(0)
    expect((await getAdsDashboard(sessionFor(orgA), '30d')).sync.mode).toBe('not_connected')
    expect(await syncAllOrgs({ fetchImpl: fake.fetchImpl })).toMatchObject({ adAccounts: 0 })
  })

  it('an incomplete env set is not_connected, never a mix and never mock', async () => {
    stubLiveEnv(orgA, { META_ADS_APP_SECRET: '' })
    const fake = fakeGraph()
    expect(await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl })).toEqual([{ skipped: 'not_connected' }])
    expect(fake.calls).toHaveLength(0)
  })

  it('a 190 leaves Connector.status alone and marks the token invalid', async () => {
    stubLiveEnv(orgA)
    const connector = await db.connector.upsert({
      where: { organizationId_kind: { organizationId: orgA, kind: 'META_ADS' } },
      create: { organizationId: orgA, kind: 'META_ADS', name: 'Meta Ads', status: 'CONNECTED' },
      update: { status: 'CONNECTED' },
    })
    const fake = fakeGraph({ errorFor: () => ({ status: 400, body: { error: { code: 190, error_subcode: 460, message: 'raw meta text' } } }) })
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true })
    expect('skipped' in r ? null : r.error?.kind).toBe('token')
    expect((await db.connector.findUniqueOrThrow({ where: { id: connector.id } })).status).toBe('CONNECTED')
    const acct = await db.metaAdAccount.findFirstOrThrow({ where: { organizationId: orgA } })
    expect(acct.tokenValid).toBe(false)
    expect(acct.lastError).toMatch(/signed out or revoked/)
    expect(acct.lastError).not.toContain('raw meta text')
    const log = await db.connectorLog.findFirstOrThrow({ where: { connectorId: connector.id, event: 'meta.ads.sync.error' } })
    expect(log.detail).toMatchObject({ kind: 'token', code: 190, subcode: 460 })
    const view = await getConnectionView(sessionFor(orgA))
    expect(view.errors[0].plain).toMatch(/revoked/)
    expect(view.token.valid).toBe(false)
  })

  it('rate back-off stops mid-sync and keeps what was written', async () => {
    stubLiveEnv(orgA)
    const fake = fakeGraph({ usageFor: (u) => (u.pathname.endsWith('/campaigns') ? { 'x-business-use-case-usage': JSON.stringify({ b: [{ call_count: 90, estimated_time_to_regain_access: 30 }] }) } : null) })
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true })
    expect('skipped' in r ? null : r.error?.kind).toBe('rate')
    expect(fake.calls.some((c) => c.url.pathname.endsWith('/adsets'))).toBe(false)
    const acct = await db.metaAdAccount.findFirstOrThrow({ where: { organizationId: orgA } })
    expect(acct.backoffUntil!.getTime()).toBeGreaterThanOrEqual(Date.now() + 29 * 60_000)
    expect(acct.lastSnapshotAt).not.toBeNull() // the snapshot before the stop was kept
    const again = await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl })
    expect(again).toEqual([{ skipped: 'backoff', adAccountId: ALLOWED_ACCOUNT }])
  })
})

describe('writes', () => {
  beforeAll(async () => {
    stubLiveEnv(orgA)
    await resetAccount()
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true })
    vi.unstubAllEnvs()
  })

  it('refused when writes are off', async () => {
    stubLiveEnv(orgA)
    await expect(assertWritableObject(orgA, IDS.campaignA)).rejects.toBeInstanceOf(AdAccountNotAllowedError)
  })

  it('allowed for a synced object of the approved account; refused for a foreign one', async () => {
    stubLiveEnv(orgA, { META_ADS_WRITES_ENABLED: 'true' })
    await expect(assertWritableObject(orgA, IDS.campaignA)).resolves.toBeUndefined()
    await expect(assertWritableObject(orgA, IDS.foreignCampaign)).rejects.toBeInstanceOf(AdAccountNotAllowedError)
    await expect(assertWritableObject(orgB, IDS.campaignA)).rejects.toBeInstanceOf(AdAccountNotAllowedError)
  })

  it('createAdAccount always throws', async () => {
    stubLiveEnv(orgA)
    const p = new GraphMetaAdsProvider({ appId: 'x', appSecret: 'y', systemUserToken: 'z', businessId: '5550001111' }, orgA)
    await expect(p.createAdAccount(orgA, { name: 'n', currency: 'USD', timezone: '1' })).rejects.toThrow(/turned off/)
  })
})
