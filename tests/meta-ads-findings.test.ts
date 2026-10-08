/**
 * Regression tests for the review findings on the Meta Ads (SCS General 1)
 * branch. DB-backed like tests/meta-ads-sync.test.ts; Graph is the fake one
 * (tests/fixtures/meta-graph). Nothing here reaches Meta.
 */
import { createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { getMetaAdsWriteProviderFor, ingestMetaLead } from '@/lib/meta'
import { metaCredentialsFor } from '@/lib/meta/provider'
import { processInbound } from '@/lib/intake/apply'
import { igniteLead } from '@/lib/meta/ignition'
import { auditRefusal, refFor, REFUSAL_ACTION } from '@/lib/meta/ads/allowlist'
import { syncAdsForOrg, readingsAgreeOnReset, shouldStopForUsage, usageBackoffMs } from '@/lib/meta/ads/sync'
import { getConnectionView, getFunnelView } from '@/lib/meta/ads/read'
import { ensureSampleAdsData, rematchLeadsCore } from '@/lib/meta/ads/manage'
import { dayInZone, zonedMidnight } from '@/lib/meta/ads/cycle'
import { scrubAttribution, countNamedAttributionRows } from '../scripts/meta-attribution-scrub'
import { fakeGraph } from './fixtures/meta-graph/fake-graph'
import { ALLOWED_ACCOUNT, ALLOWED_DIGITS, FOREIGN_NAMES, IDS } from './fixtures/meta-graph/ids'
import { clearSharedRows, makeAdmin, makeOrg, sessionFor, stubLiveEnv } from './fixtures/meta-graph/setup'

const run = `mfind-${Date.now().toString(36)}`
let orgA: string
let orgB: string

beforeAll(async () => {
  await clearSharedRows()
  orgA = (await makeOrg(`${run}-a`)).id
  orgB = (await makeOrg(`${run}-b`)).id
})

afterAll(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
  await clearSharedRows()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function resetAccount() {
  await db.metaAdAccount.deleteMany({ where: { organizationId: orgA } })
  await db.metaAccountSnapshot.deleteMany({ where: { organizationId: orgA } })
  await db.metaBillingEvent.deleteMany({ where: { organizationId: orgA } })
  await db.metaSpendCycle.deleteMany({ where: { organizationId: orgA } })
  await db.metaLeadTouch.deleteMany({ where: { organizationId: orgA } })
  await db.metaObjectAccount.deleteMany({ where: { objectId: { in: Object.values(IDS) } } })
}

describe('usage headers (graph-usage-reset-duration)', () => {
  beforeEach(async () => {
    stubLiveEnv(orgA)
    await resetAccount()
  })

  it('low usage with a reset_time_duration does not stop the sync', async () => {
    expect(shouldStopForUsage({ maxPct: 5, regainSeconds: 0, resetSeconds: 100 })).toBe(false)
    expect(shouldStopForUsage({ maxPct: 80, regainSeconds: 0, resetSeconds: 0 })).toBe(true)
    expect(shouldStopForUsage({ maxPct: 5, regainSeconds: 60, resetSeconds: 0 })).toBe(true)
    // Meta's example header on every ad-account call.
    const fake = fakeGraph({ usageFor: () => ({ 'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 5, reset_time_duration: 100 }) }) })
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true })
    expect('skipped' in r ? null : r.error).toBeUndefined()
    expect('skipped' in r ? null : r.full).toBe(true)
    const acct = await db.metaAdAccount.findFirstOrThrow({ where: { organizationId: orgA } })
    expect(acct.backoffUntil).toBeNull()
    expect(acct.lastFullSyncAt).not.toBeNull()
  })

  it('once a stop is decided, reset_time_duration can lengthen the back-off', () => {
    expect(usageBackoffMs({ maxPct: 90, regainSeconds: 0, resetSeconds: 3600 })).toBe(3_600_000)
    expect(usageBackoffMs({ maxPct: 90, regainSeconds: 0, resetSeconds: 10 })).toBe(15 * 60_000)
  })
})

describe('appsecret_proof on the first sync (graph-appsecret-proof-deadlock)', () => {
  beforeEach(async () => {
    stubLiveEnv(orgA)
    await resetAccount()
  })

  it('an app that requires the proof syncs with tokenAppId still unknown, and learns it', async () => {
    const fake = fakeGraph({
      errorFor: (u) =>
        u.pathname.includes('act_') && !u.searchParams.has('appsecret_proof')
          ? { status: 400, body: { error: { code: 100, message: 'API calls from the server require an appsecret_proof argument' } } }
          : null,
    })
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true })
    expect('skipped' in r ? null : r.error).toBeUndefined()
    const acct = await db.metaAdAccount.findFirstOrThrow({ where: { organizationId: orgA } })
    expect(acct.tokenAppId).toBe('ads-app-1')
    expect(acct.lastSnapshotAt).not.toBeNull()
  })
})

describe('spending-limit reset (graph-amount-spent-reset-stale-forever)', () => {
  beforeEach(async () => {
    stubLiveEnv(orgA)
    await resetAccount()
  })

  it('a single low reading is still a stale replica', () => {
    expect(readingsAgreeOnReset([{ stale: false, amountSpentCents: BigInt(800_000) }, { stale: false, amountSpentCents: BigInt(790_000) }], BigInt(1_200), BigInt(800_000))).toBe(false)
    expect(readingsAgreeOnReset([{ stale: true, amountSpentCents: BigInt(1_300) }, { stale: true, amountSpentCents: BigInt(1_200) }], BigInt(1_400), BigInt(800_000))).toBe(true)
    // Low readings that go DOWN don't agree.
    expect(readingsAgreeOnReset([{ stale: true, amountSpentCents: BigInt(1_100) }, { stale: true, amountSpentCents: BigInt(1_300) }], BigInt(1_400), BigInt(800_000))).toBe(false)
  })

  it('after a reset near zero and steady growth, the new baseline is accepted and status changes are seen again', async () => {
    let spent = 800_000
    let status = 1
    const fake = fakeGraph({ amountSpentCents: () => spent, balanceCents: () => 5_000, accountStatus: () => status })
    const t0 = Date.now()
    await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true, now: new Date(t0) })
    const results: string[] = []
    for (const [i, s] of [1_200, 1_300, 1_400].entries()) {
      spent = s
      const [r] = await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, now: new Date(t0 + (i + 1) * 600_000) })
      results.push('skipped' in r ? 'skipped' : r.snapshot)
    }
    expect(results).toEqual(['stale', 'stale', 'ok'])
    const acct = await db.metaAdAccount.findFirstOrThrow({ where: { organizationId: orgA } })
    expect(Number(acct.amountSpentCents)).toBe(1_400)
    expect(acct.pendingCharge).toBeNull()

    spent = 1_500
    status = 9
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, now: new Date(t0 + 4 * 600_000) })
    expect('skipped' in r ? null : r.snapshot).toBe('ok')
    const ev = await db.metaBillingEvent.findFirst({ where: { organizationId: orgA, kind: 'STATUS_CHANGE' } })
    expect([ev?.before, ev?.after]).toEqual(['Active', 'Grace period'])
  })
})

describe('archived and deleted ads keep their spend (graph-insights-exclude-archived-deleted)', () => {
  beforeEach(async () => {
    stubLiveEnv(orgA)
    await resetAccount()
  })

  it('an archived ad gets an AD summary and its spend counts for its ad set', async () => {
    const fake = fakeGraph()
    await syncAdsForOrg(orgA, { fetchImpl: fake.fetchImpl, force: true })
    const archived = await db.metaInsightSummary.findFirst({ where: { organizationId: orgA, level: 'AD', objectId: IDS.adArchived, window: 'LAST_30D' } })
    expect(archived).not.toBeNull()
    expect(Number(archived!.spend)).toBeGreaterThan(0)
    const insightCalls = fake.calls.filter((c) => c.url.pathname.endsWith('/insights') && c.url.searchParams.get('level') === 'ad')
    expect(insightCalls.length).toBeGreaterThan(0)
    expect(insightCalls.every((c) => (c.url.searchParams.get('filtering') ?? '').includes('ARCHIVED'))).toBe(true)
  })
})

describe('hourly cycle split (graph-hourly-catchall-approximate)', () => {
  beforeEach(async () => {
    stubLiveEnv(orgA)
    await resetAccount()
  })

  async function openCycle(startedAt: Date) {
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true, now: new Date(startedAt.getTime() - 60_000) })
    await db.metaSpendCycle.create({ data: { organizationId: orgA, adAccountId: ALLOWED_ACCOUNT, number: 1, lengthDays: 15, startedAt } })
  }
  const hourly = (u: URL) => u.searchParams.get('breakdowns') === 'hourly_stats_aggregated_by_advertiser_time_zone'

  it('a rate limit on the hourly call leaves the cycle exact and retries on the next run', async () => {
    const start = new Date(Date.now() - 3 * 3_600_000)
    await openCycle(start)
    const limited = fakeGraph({ errorFor: (u) => (hourly(u) ? { status: 400, body: { error: { code: 17, message: 'limit' } } } : null) })
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: limited.fetchImpl, force: true })
    expect('skipped' in r ? null : r.error?.kind).toBe('rate')
    let cycle = await db.metaSpendCycle.findFirstOrThrow({ where: { organizationId: orgA, number: 1 } })
    expect(cycle.spendApproximate).toBe(false)

    await db.metaAdAccount.updateMany({ where: { organizationId: orgA }, data: { backoffUntil: null } })
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true })
    cycle = await db.metaSpendCycle.findFirstOrThrow({ where: { organizationId: orgA, number: 1 } })
    expect(cycle.spendApproximate).toBe(false)
    const hourNow = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric' }).format(start))
    expect(Number(cycle.startDayExcludedSpend)).toBe(hourNow) // $1 per hour before the start hour
  })

  it('hourly failing transiently for the whole 48 h window marks the cycle approximate (cycle-hourly-never-marked-approximate)', async () => {
    const start = new Date(Date.now() - 50 * 3_600_000)
    await openCycle(start)
    const down = fakeGraph({ errorFor: (u) => (hourly(u) ? { status: 500, body: { error: { code: 2, message: 'Service temporarily unavailable' } } } : null) })
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: down.fetchImpl, force: true, now: new Date(start.getTime() + 3_600_000) })
    expect('skipped' in r ? null : r.error).toBeUndefined()
    let cycle = await db.metaSpendCycle.findFirstOrThrow({ where: { organizationId: orgA, number: 1 } })
    expect(cycle.spendApproximate).toBe(false) // still inside the window: retried next time
    expect(cycle.startDayExcludedAt).toBeNull()

    // Past 48 h the hourly call is no longer tried, and the cycle says "about".
    const later = fakeGraph()
    await syncAdsForOrg(orgA, { fetchImpl: later.fetchImpl, force: true })
    expect(later.calls.some((c) => hourly(c.url))).toBe(false)
    cycle = await db.metaSpendCycle.findFirstOrThrow({ where: { organizationId: orgA, number: 1 } })
    expect(cycle.spendApproximate).toBe(true)
  })

  it('a cycle whose start day was split inside the window stays exact after it', async () => {
    const start = new Date(Date.now() - 50 * 3_600_000)
    await openCycle(start)
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true, now: new Date(start.getTime() + 3_600_000) })
    expect((await db.metaSpendCycle.findFirstOrThrow({ where: { organizationId: orgA, number: 1 } })).startDayExcludedAt).not.toBeNull()
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true })
    expect((await db.metaSpendCycle.findFirstOrThrow({ where: { organizationId: orgA, number: 1 } })).spendApproximate).toBe(false)
  })

  it('a definite "unsupported" answer (code 100) marks the cycle approximate', async () => {
    await openCycle(new Date(Date.now() - 3 * 3_600_000))
    const unsupported = fakeGraph({ errorFor: (u) => (hourly(u) ? { status: 400, body: { error: { code: 100, message: 'breakdown not supported' } } } : null) })
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: unsupported.fetchImpl, force: true })
    expect('skipped' in r ? null : r.error).toBeUndefined()
    expect((await db.metaSpendCycle.findFirstOrThrow({ where: { organizationId: orgA, number: 1 } })).spendApproximate).toBe(true)
  })
})

describe('cycle switch day (graph-cycle-end-day-double-count)', () => {
  beforeEach(async () => {
    stubLiveEnv(orgA)
    await resetAccount()
  })

  it('a closed cycle and the next one never count the switch day twice', async () => {
    const tz = 'America/Los_Angeles'
    const now = new Date()
    const today = dayInZone(now, tz)
    // Switch at 14:00 local yesterday: $14 of that day (hourly $1) belongs to cycle 1.
    const yesterday = dayInZone(new Date(zonedMidnight(today, tz).getTime() - 3_600_000), tz)
    const switchAt = new Date(zonedMidnight(yesterday, tz).getTime() + 14 * 3_600_000)
    const switchDay = yesterday
    const firstStart = zonedMidnight(dayInZone(new Date(switchAt.getTime() - 3 * 86_400_000), tz), tz)
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true, now })
    await db.metaSpendCycle.create({ data: { organizationId: orgA, adAccountId: ALLOWED_ACCOUNT, number: 1, lengthDays: 15, startedAt: firstStart, endedAt: switchAt, finalAfter: new Date(now.getTime() + 86_400_000) } })
    await db.metaSpendCycle.create({ data: { organizationId: orgA, adAccountId: ALLOWED_ACCOUNT, number: 2, lengthDays: 15, startedAt: switchAt } })
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true, now })

    const [c1, c2] = await db.metaSpendCycle.findMany({ where: { organizationId: orgA }, orderBy: { number: 'asc' } })
    const daily = await db.metaInsightDaily.findMany({ where: { organizationId: orgA, level: 'ACCOUNT', date: { gte: new Date(`${dayInZone(firstStart, tz)}T00:00:00Z`) } } })
    const span = daily.filter((d) => d.date.toISOString().slice(0, 10) <= today).reduce((a, d) => a + Number(d.spend), 0)
    const c2Spend = daily
      .filter((d) => { const day = d.date.toISOString().slice(0, 10); return day >= switchDay && day <= today })
      .reduce((a, d) => a + Number(d.spend), 0) - Number(c2.startDayExcludedSpend)
    expect(Number(c2.startDayExcludedSpend)).toBeGreaterThan(0)
    expect(Math.round((Number(c1.closedSpend) + c2Spend) * 100) / 100).toBe(Math.round(span * 100) / 100)
  })
})

describe('ownership probes (graph-ownership-permission-cached-outside)', () => {
  beforeEach(async () => {
    stubLiveEnv(orgA)
    await resetAccount()
  })

  it('a permission error leaves the lead pending (not outside), and Re-match asks again', async () => {
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true })
    const newAd = '6300000777'
    await db.metaObjectAccount.deleteMany({ where: { objectId: newAd } })
    const leadgenId = `${run}-perm`
    await ingestMetaLead(orgA, {
      leadgenId, createdTime: new Date().toISOString(),
      fields: { full_name: 'Perm Person', email: `${leadgenId}@example.test`, phone_number: '+17025550191' },
      attribution: { adId: newAd, adName: null, adsetId: null, adsetName: null, campaignId: null, campaignName: null, formId: 'f', platform: 'fb', isOrganic: false },
    })
    const denied = fakeGraph({ errorFor: (u) => (u.pathname.endsWith(`/${newAd}`) ? { status: 400, body: { error: { code: 200, message: 'Permissions error' } } } : null) })
    await syncAdsForOrg(orgA, { fetchImpl: denied.fetchImpl })
    expect((await db.metaLeadTouch.findFirstOrThrow({ where: { organizationId: orgA, leadgenId } })).status).toBe('pending')
    expect((await db.metaObjectAccount.findUniqueOrThrow({ where: { objectId: newAd } })).reason).toBe('no_access')

    // Inside the retry window the ad is not probed again.
    const quiet = fakeGraph({ owners: { [newAd]: ALLOWED_DIGITS } })
    await syncAdsForOrg(orgA, { fetchImpl: quiet.fetchImpl })
    expect(quiet.calls.some((c) => c.url.pathname.endsWith(`/${newAd}`))).toBe(false)

    // Re-match forgets the tentative answer; the ad is in the approved account after all.
    vi.stubGlobal('fetch', quiet.fetchImpl)
    const adminId = await makeAdmin(orgA)
    await rematchLeadsCore(sessionFor(orgA, undefined, 'SUPER_ADMIN', adminId))
    expect(await db.metaObjectAccount.findUnique({ where: { objectId: newAd } })).toMatchObject({ reason: 'allowed', outside: false })
    expect((await db.metaLeadTouch.findFirstOrThrow({ where: { organizationId: orgA, leadgenId } })).status).toBe('matched')
    await db.metaObjectAccount.deleteMany({ where: { objectId: newAd } })
  })
})

describe('ownership probes honor Meta slow-downs (touches-probe-swallows-usage-stop)', () => {
  beforeEach(async () => {
    stubLiveEnv(orgA)
    await resetAccount()
  })

  // Each test gets its own ad ids, so leads left by another test can't add probes.
  const TAGS = { usage: 1, token: 2, blip: 3 } as const
  const adsFor = (tag: keyof typeof TAGS) => [1, 2, 3].map((i) => `63000009${TAGS[tag]}${i}`)
  const probeOf = (ads: string[]) => (u: URL) => u.searchParams.get('fields') === 'account_id' && ads.some((id) => u.pathname.endsWith(`/${id}`))

  async function leadsOnNewAds(tag: keyof typeof TAGS): Promise<string[]> {
    const ads = adsFor(tag)
    await db.metaObjectAccount.deleteMany({ where: { objectId: { in: ads } } })
    for (const [i, adId] of ads.entries()) {
      const leadgenId = `${run}-${tag}-${i}`
      await ingestMetaLead(orgA, {
        leadgenId, createdTime: new Date().toISOString(),
        fields: { full_name: `Probe ${tag} ${i}`, email: `${leadgenId}@example.test`, phone_number: `+17025554${TAGS[tag]}${String(i).padStart(2, '0')}` },
        attribution: { adId, adName: null, adsetId: null, adsetName: null, campaignId: null, campaignName: null, formId: 'f', platform: 'fb', isOrganic: false },
      })
    }
    return ads
  }

  it('usage over 75% on the first probe stops the run after one probe and records the back-off', async () => {
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true })
    const newAds = await leadsOnNewAds('usage')
    const isProbe = probeOf(newAds)
    const hot = fakeGraph({
      owners: Object.fromEntries(newAds.map((id) => [id, ALLOWED_DIGITS])),
      usageFor: (u) => (isProbe(u) ? { 'x-business-use-case-usage': JSON.stringify({ b: [{ call_count: 80, estimated_time_to_regain_access: 0 }] }) } : null),
    })
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: hot.fetchImpl })
    expect('skipped' in r ? null : r.error?.kind).toBe('rate')
    expect(hot.calls.filter((c) => isProbe(c.url)).length).toBe(1)
    const acct = await db.metaAdAccount.findFirstOrThrow({ where: { organizationId: orgA } })
    expect(acct.backoffUntil!.getTime()).toBeGreaterThan(Date.now())
    expect(acct.lastErrorKind).toBe('rate')
    expect(acct.lastUsagePct).toBeGreaterThanOrEqual(75)
    // The next run waits out the back-off instead of probing again.
    const later = fakeGraph({ owners: Object.fromEntries(newAds.map((id) => [id, ALLOWED_DIGITS])) })
    const [again] = await syncAdsForOrg(orgA, { fetchImpl: later.fetchImpl })
    expect(again).toMatchObject({ skipped: 'backoff' })
    expect(later.calls.length).toBe(0)
    await db.metaObjectAccount.deleteMany({ where: { objectId: { in: newAds } } })
  })

  it('a revoked token on a probe ends the run as a token error', async () => {
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true })
    const newAds = await leadsOnNewAds('token')
    const isProbe = probeOf(newAds)
    const revoked = fakeGraph({ errorFor: (u) => (isProbe(u) ? { status: 400, body: { error: { code: 190, error_subcode: 460 } } } : null) })
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: revoked.fetchImpl })
    expect('skipped' in r ? null : r.error?.kind).toBe('token')
    expect(revoked.calls.filter((c) => isProbe(c.url)).length).toBe(1)
    expect((await db.metaAdAccount.findFirstOrThrow({ where: { organizationId: orgA } })).tokenValid).toBe(false)
  })

  it('a temporary Meta problem on a probe keeps the lead pending and the run going', async () => {
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true })
    const newAds = await leadsOnNewAds('blip')
    const isProbe = probeOf(newAds)
    const flaky = fakeGraph({ errorFor: (u) => (isProbe(u) ? { status: 500, body: { error: { code: 2, message: 'Service temporarily unavailable' } } } : null) })
    const [r] = await syncAdsForOrg(orgA, { fetchImpl: flaky.fetchImpl })
    expect('skipped' in r ? null : r.error).toBeUndefined()
    expect(flaky.calls.filter((c) => isProbe(c.url)).length).toBe(newAds.length)
    const touches = await db.metaLeadTouch.findMany({ where: { organizationId: orgA, leadgenId: { startsWith: `${run}-blip-` } } })
    expect(touches.map((t) => t.status)).toEqual(newAds.map(() => 'pending'))
  })
})

describe('funnel window (graph-funnel-window-misaligned)', () => {
  beforeEach(async () => {
    stubLiveEnv(orgA)
    await resetAccount()
  })

  it("7d and 30d leave out today's leads, like Meta's last_7d / last_30d; all keeps them", async () => {
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true })
    const today = new Date()
    const yesterday = new Date(zonedMidnight(dayInZone(today, 'America/Los_Angeles'), 'America/Los_Angeles').getTime() - 3_600_000)
    for (const [id, at] of [['fw-today', today], ['fw-yday', yesterday]] as const) {
      await db.metaLeadTouch.create({ data: { organizationId: orgA, leadgenId: `${run}-${id}`, status: 'matched', adAccountId: ALLOWED_ACCOUNT, adId: IDS.adA1a, leadCreatedAt: at, clientId: null } })
    }
    const u = sessionFor(orgA)
    const leadsFor = async (range: '7d' | 'all') => (await getFunnelView(u, range)).rows.find((r) => r.adExternalId === IDS.adA1a)?.leads ?? 0
    expect(await leadsFor('7d')).toBe(1)
    expect(await leadsFor('all')).toBe(2)
  })
})

describe('token valid again after a fix (graph-token-valid-sticky)', () => {
  beforeEach(async () => {
    stubLiveEnv(orgA)
    await resetAccount()
  })

  it('a successful run after a 190 shows the token as valid without waiting a day', async () => {
    const t0 = Date.now()
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true, now: new Date(t0) })
    const revoked = fakeGraph({ errorFor: () => ({ status: 400, body: { error: { code: 190, error_subcode: 460 } } }) })
    await syncAdsForOrg(orgA, { fetchImpl: revoked.fetchImpl, now: new Date(t0 + 600_000) })
    expect((await db.metaAdAccount.findFirstOrThrow({ where: { organizationId: orgA } })).tokenValid).toBe(false)
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, now: new Date(t0 + 1_200_000) })
    expect((await getConnectionView(sessionFor(orgA))).token.valid).toBe(true)
  })
})

describe('writes use the ads credentials (regression-writes-use-lead-intake-creds)', () => {
  beforeEach(async () => {
    await resetAccount()
  })

  it('with only the ads set configured, writes go out with the ads token and the new campaign is visible', async () => {
    stubLiveEnv(orgA, { META_ADS_WRITES_ENABLED: 'true', META_APP_ID: '', META_APP_SECRET: '', META_SYSTEM_USER_TOKEN: '', META_PAGE_ACCESS_TOKEN: '', META_AD_ACCOUNT_ID: '' })
    await syncAdsForOrg(orgA, { fetchImpl: fakeGraph().fetchImpl, force: true })
    const provider = await getMetaAdsWriteProviderFor(orgA)
    expect(provider.kind).toBe('graph')

    const sent: { url: URL; auth: string | null }[] = []
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const body = new URLSearchParams(String(init?.body ?? ''))
      for (const [k, v] of body) url.searchParams.set(`body.${k}`, v)
      sent.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return new Response(JSON.stringify(url.pathname.endsWith('/campaigns') ? { id: '6100009001' } : { success: true }), { status: 200 })
    })
    const campaign = await db.campaign.findFirstOrThrow({ where: { organizationId: orgA, externalId: IDS.campaignA } })
    await provider.setCampaignStatus(orgA, campaign.id, 'PAUSED')
    const created = await provider.createCampaign(orgA, { name: 'New one', objective: 'LEADS', dailyBudget: 20, status: 'PAUSED' })
    // Token in the Authorization header only; the proof rides in the body.
    const proof = createHmac('sha256', 'test-ads-secret-not-real').update('TEST-ADS-TOKEN-not-real').digest('hex')
    expect(sent.length).toBe(2)
    expect(sent.every((s) => s.auth === 'Bearer TEST-ADS-TOKEN-not-real')).toBe(true)
    expect(sent.some((s) => s.url.searchParams.has('access_token') || s.url.searchParams.has('body.access_token'))).toBe(false)
    expect(sent.every((s) => s.url.searchParams.get('body.appsecret_proof') === proof)).toBe(true)
    expect(sent.some((s) => s.url.pathname.endsWith(`/${ALLOWED_ACCOUNT}/campaigns`))).toBe(true)
    expect((await db.campaign.findUniqueOrThrow({ where: { id: created.id } })).adAccountId).toBe(ALLOWED_ACCOUNT)
    await db.campaign.delete({ where: { id: created.id } })
  })

  it('a workspace that is not the bound one gets a provider that refuses every write', async () => {
    stubLiveEnv(orgA, { VERCEL_ENV: 'production' })
    const provider = await getMetaAdsWriteProviderFor(orgB)
    expect(provider.kind).toBe('disconnected')
    await expect(provider.setCampaignStatus(orgB, 'x', 'PAUSED')).rejects.toThrow(/isn't connected/)
  })
})

describe('sample mode fills itself (regression-mock-never-syncs)', () => {
  it('the first page view in sample mode syncs the sample account; later views do not', async () => {
    // No binding at all: development / preview sample mode.
    vi.stubEnv('META_ADS_ORG_ID', '')
    vi.stubEnv('META_ALLOWED_AD_ACCOUNTS', '')
    const u = sessionFor(orgB, ['connectors:read'])
    expect(await ensureSampleAdsData(u)).toBe(true)
    const row = await db.metaAdAccount.findFirstOrThrow({ where: { organizationId: orgB } })
    expect(row.lastFullSyncAt).not.toBeNull()
    expect(await ensureSampleAdsData(u)).toBe(false)
    await db.metaAdAccount.deleteMany({ where: { organizationId: orgB } })
  })

  it('never in production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('META_ADS_ORG_ID', '')
    vi.stubEnv('META_ALLOWED_AD_ACCOUNTS', '')
    expect(await ensureSampleAdsData(sessionFor(orgB, ['connectors:read']))).toBe(false)
    expect(await db.metaAdAccount.count({ where: { organizationId: orgB } })).toBe(0)
  })
})

describe('refusal audit rows stay in their own workspace (leak-4 / regression-refusal-audit-cross-tenant)', () => {
  it('an unbound workspace’s refusal is logged there, never in the bound workspace', async () => {
    stubLiveEnv(orgA)
    const ref = refFor(`act_${run.length}12345678`)
    await auditRefusal(orgB, ref, 'not_allowlisted', `test.${run}`)
    expect(await db.auditEvent.count({ where: { organizationId: orgB, action: REFUSAL_ACTION, entityId: ref } })).toBe(1)
    expect(await db.auditEvent.count({ where: { organizationId: orgA, action: REFUSAL_ACTION, entityId: ref } })).toBe(0)
  })

  it('an approved id used from an unbound workspace is unbound_org, logged in that workspace', async () => {
    stubLiveEnv(orgA, { META_AD_ACCOUNT_ID: ALLOWED_ACCOUNT, META_APP_ID: 'intake-app', META_APP_SECRET: 'x', META_SYSTEM_USER_TOKEN: 'y' })
    const creds = await metaCredentialsFor(orgB)
    expect(creds.adAccountId).toBeUndefined()
    const rows = await db.auditEvent.findMany({ where: { organizationId: orgB, action: REFUSAL_ACTION, summary: { startsWith: 'credentials.adAccountId' } } })
    expect(rows.map((r) => r.summary)).toContain('credentials.adAccountId (unbound_org)')
    expect(await db.auditEvent.count({ where: { organizationId: orgA, action: REFUSAL_ACTION, summary: { startsWith: 'credentials.adAccountId' } } })).toBe(0)
  })
})

describe('attribution scrub covers every Meta submission (leak-1, leak-2)', () => {
  it('finds foreign names on later submissions, client-less submissions, legacy links, notes and audit rows', async () => {
    const org = (await makeOrg(`${run}-scrub`)).id
    try {
      // First lead: a normal client, no campaign.
      const email = `${run}-scrub@example.test`
      const first = await ingestMetaLead(org, { leadgenId: `${run}-s1`, createdTime: new Date().toISOString(), fields: { full_name: 'Scrub Two', email, phone_number: '+17025550193' } })
      const clientId = first.submission.clientId!
      const source = await db.intakeSource.findFirstOrThrow({ where: { organizationId: org, kind: 'META_LEAD_ADS' } })

      // Second lead from the other account's ad, as main 0b03c61 ingested it:
      // utm_campaign = Graph's campaign name, matched to the existing client.
      const second = await processInbound(source, `leadgen:${run}-s2`, { full_name: 'Scrub Two', first_name: 'Scrub', last_name: 'Two', email, utm_source: 'meta', utm_campaign: FOREIGN_NAMES.campaign, leadgen_id: `${run}-s2` })
      expect(second.submission.clientId).toBe(clientId)
      expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).utmCampaign).toBe(FOREIGN_NAMES.campaign)

      // A Meta submission that never reached a client.
      const orphan = await db.intakeSubmission.create({
        data: { organizationId: org, sourceId: source.id, externalId: `leadgen:${run}-s3`, status: 'FAILED', rawPayload: { utm_campaign: FOREIGN_NAMES.adSet }, mappedPayload: { utmCampaign: FOREIGN_NAMES.adSet } },
      })

      // Legacy: a client linked (before the allowlist) to a hidden campaign, ignited with its name.
      const hidden = await db.campaign.create({ data: { organizationId: org, channel: 'meta', externalId: '6900000999', name: FOREIGN_NAMES.ad } })
      const legacy = await ingestMetaLead(org, { leadgenId: `${run}-s4`, createdTime: new Date().toISOString(), fields: { full_name: 'Legacy Person', email: `${run}-legacy@example.test`, phone_number: '+17025550194' } })
      const legacyId = legacy.submission.clientId!
      await db.client.update({ where: { id: legacyId }, data: { campaignId: hidden.id, utmCampaign: FOREIGN_NAMES.ad } })
      await igniteLead(org, legacyId, `${run}-s4`)

      // The connect gate stays closed while any of this is stored.
      expect(await countNamedAttributionRows()).toBeGreaterThan(0)
      const dry = await scrubAttribution()
      expect(dry.submissionsCleared).toBeGreaterThanOrEqual(2)
      expect(dry.notesCleared).toBeGreaterThanOrEqual(1)
      expect(dry.auditRowsCleared).toBeGreaterThanOrEqual(2)

      await scrubAttribution({ commit: true })
      const everything = JSON.stringify({
        subs: await db.intakeSubmission.findMany({ where: { organizationId: org } }),
        clients: await db.client.findMany({ where: { organizationId: org }, select: { utmCampaign: true, leadAttribution: true } }),
        notes: await db.note.findMany({ where: { clientId: { in: [clientId, legacyId] } } }),
        audits: await db.auditEvent.findMany({ where: { organizationId: org } }),
      })
      for (const n of Object.values(FOREIGN_NAMES)) expect(everything).not.toContain(n)
      expect((await db.intakeSubmission.findUniqueOrThrow({ where: { id: orphan.id } })).rawPayload).toEqual({})
      const note = await db.note.findFirstOrThrow({ where: { clientId: legacyId, pinned: true } })
      expect(note.body).toContain('This lead came in from Facebook / Instagram.')
      expect(await scrubAttribution()).toMatchObject({ submissionsCleared: 0, notesCleared: 0, auditRowsCleared: 0, clientUtmCleared: 0 })
    } finally {
      await db.organization.delete({ where: { id: org } })
    }
  })
})
