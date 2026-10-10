/**
 * Leak canary (docs/META_ADS_SCS.md §3.10). Seeds a FAKE foreign ad account's
 * rows everywhere they could hide (every new Meta table, Campaign, AdSet,
 * CampaignDailyStat, lead attribution JSON), plus legacy NULL-account rows and
 * mock rows, then runs every surface that reads Meta data and asserts that no
 * foreign digit, name or spend comes out. Production-like env: mock is off.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { syncAdsForOrg } from '@/lib/meta/ads/sync'
import { getAdsDashboard, getBillingView, getConnectionView, getCycleView, getFunnelView } from '@/lib/meta/ads/read'
import { attributionRowsFor } from '@/lib/meta/ads/attribution-names'
import { mockAdAccountId } from '@/lib/meta/ads/allowlist'
import { getMarketingOverview, marketingRange } from '@/lib/marketing-metrics'
import { getCampaignPerformance } from '@/lib/analytics'
import { getAttributionReport } from '@/lib/revops'
import { campaignTrends, ingestMetaLead, monthSpend } from '@/lib/meta'
import { resolveTarget, runConsoleCommand } from '@/lib/meta/ops'
import { loadCaseFile } from '@/lib/daily-desk-case'
import { fakeGraph } from './fixtures/meta-graph/fake-graph'
import { ALLOWED_ACCOUNT, FOREIGN_ACCOUNT, FOREIGN_DIGITS, FOREIGN_NAMES, FOREIGN_SPEND, IDS } from './fixtures/meta-graph/ids'
import { clearSharedRows, makeOrg, sessionFor, stubLiveEnv } from './fixtures/meta-graph/setup'

// Session users here are synthetic (no User row), so audit rows can't reference them.
vi.mock('@/lib/audit', async (orig) => ({ ...(await orig<typeof import('@/lib/audit')>()), recordAudit: async () => {} }))

const run = `mcan-${Date.now().toString(36)}`
const LEGACY_NAME = 'ZZ Legacy Unclassified Secret'
const MOCK_NAME = 'ZZ Mock Row Secret'
let orgId: string
let clientId: string

const NEEDLES = [
  FOREIGN_DIGITS, FOREIGN_NAMES.campaign, FOREIGN_NAMES.adSet, FOREIGN_NAMES.ad,
  String(FOREIGN_SPEND), FOREIGN_SPEND.toLocaleString('en-US'), LEGACY_NAME, MOCK_NAME,
  IDS.foreignCampaign, IDS.foreignAdSet, IDS.foreignAd,
]

function assertClean(label: string, value: unknown) {
  const text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  for (const n of NEEDLES) expect(text.includes(n), `${label} leaked ${n}`).toBe(false)
}

beforeAll(async () => {
  await clearSharedRows()
  orgId = (await makeOrg(run)).id
  stubLiveEnv(orgId, { VERCEL_ENV: 'production' })

  // A real (fake-Graph) sync of the approved account, with foreign rows mixed into every answer.
  await syncAdsForOrg(orgId, { fetchImpl: fakeGraph({ includeForeignRows: true, owners: { [IDS.foreignAd]: FOREIGN_DIGITS } }).fetchImpl, force: true })

  // Foreign rows planted directly, as if a bug had written them.
  const fc = await db.campaign.create({ data: { organizationId: orgId, channel: 'meta', externalId: IDS.foreignCampaign, name: FOREIGN_NAMES.campaign, adAccountId: FOREIGN_ACCOUNT, spend: FOREIGN_SPEND } })
  await db.adSet.create({ data: { organizationId: orgId, campaignId: fc.id, externalId: IDS.foreignAdSet, name: FOREIGN_NAMES.adSet, adAccountId: FOREIGN_ACCOUNT, spend: FOREIGN_SPEND } })
  await db.campaignDailyStat.create({ data: { campaignId: fc.id, date: new Date(new Date().toISOString().slice(0, 10)), spend: FOREIGN_SPEND, impressions: 1, clicks: 1 } })
  await db.metaAdAccount.create({ data: { organizationId: orgId, adAccountId: FOREIGN_ACCOUNT, name: FOREIGN_NAMES.campaign, balanceCents: BigInt(876543) } })
  await db.metaAd.create({ data: { organizationId: orgId, adAccountId: FOREIGN_ACCOUNT, campaignId: fc.id, externalId: IDS.foreignAd, name: FOREIGN_NAMES.ad, status: 'ACTIVE' } })
  for (const window of ['TODAY', 'LAST_7D', 'LAST_30D', 'THIS_MONTH', 'MAXIMUM'] as const) {
    await db.metaInsightSummary.create({ data: { organizationId: orgId, adAccountId: FOREIGN_ACCOUNT, level: 'AD', objectId: `${IDS.foreignAd}`, window, spend: FOREIGN_SPEND, leads: 7 } })
  }
  await db.metaInsightSummary.deleteMany({ where: { organizationId: orgId, adAccountId: FOREIGN_ACCOUNT } }) // unique on (org, level, objectId, window): re-create per window with a distinct object
  for (const window of ['TODAY', 'LAST_7D', 'LAST_30D', 'THIS_MONTH', 'MAXIMUM'] as const) {
    await db.metaInsightSummary.create({ data: { organizationId: orgId, adAccountId: FOREIGN_ACCOUNT, level: 'ACCOUNT', objectId: FOREIGN_ACCOUNT, window, spend: FOREIGN_SPEND, leads: 7 } })
  }
  await db.metaInsightDaily.create({ data: { organizationId: orgId, adAccountId: FOREIGN_ACCOUNT, level: 'ACCOUNT', objectId: FOREIGN_ACCOUNT, date: new Date(new Date().toISOString().slice(0, 10)), spend: FOREIGN_SPEND } })
  await db.metaAccountSnapshot.create({ data: { organizationId: orgId, adAccountId: FOREIGN_ACCOUNT, balanceCents: BigInt(876543) } })
  await db.metaBillingEvent.create({ data: { organizationId: orgId, adAccountId: FOREIGN_ACCOUNT, kind: 'PAYMENT', occurredAt: new Date(), fromSnapshotId: 'foreign-snap', amountCents: BigInt(876543) } })
  await db.metaSpendCycle.create({ data: { organizationId: orgId, adAccountId: FOREIGN_ACCOUNT, number: 1, lengthDays: 15, startedAt: new Date(), closedSpend: FOREIGN_SPEND } })

  // Legacy NULL-account and mock rows.
  await db.campaign.create({ data: { organizationId: orgId, channel: 'meta', externalId: '6100000777', name: LEGACY_NAME, spend: 1234 } })
  await db.campaign.create({ data: { organizationId: orgId, channel: 'meta', externalId: 'mock_x1', name: MOCK_NAME, adAccountId: mockAdAccountId(orgId), spend: 4321 } })

  // A lead whose ad belongs to the foreign account, with foreign names in its stored JSON (pre-scrub data).
  const r = await ingestMetaLead(orgId, {
    leadgenId: `lg-${run}`,
    createdTime: new Date().toISOString(),
    fields: { full_name: 'Canary Lead', email: `${run}@example.test`, phone_number: '+17025550199' },
  }, { adExternalId: IDS.foreignAd, adSetExternalId: IDS.foreignAdSet })
  clientId = r.submission.clientId!
  if (!clientId) throw new Error(`no client: ${r.submission.status} ${r.submission.error}`)
  await db.client.update({
    where: { id: clientId },
    data: {
      leadAttribution: {
        provider: 'meta', leadgenId: `lg-${run}`, adId: IDS.foreignAd, adName: FOREIGN_NAMES.ad, adsetId: IDS.foreignAdSet, adsetName: FOREIGN_NAMES.adSet,
        campaignId: IDS.foreignCampaign, campaignName: FOREIGN_NAMES.campaign, formId: 'f1', platform: 'fb', isOrganic: false, capturedAt: new Date().toISOString(),
      },
    },
  })
  // Touches are rebuilt by the sync, whose ownership probes go to the fake Graph (never the network).
  await syncAdsForOrg(orgId, { fetchImpl: fakeGraph({ owners: { [IDS.foreignAd]: FOREIGN_DIGITS } }).fetchImpl, force: true })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.organization.delete({ where: { id: orgId } })
  await clearSharedRows()
})

describe('leak canary', () => {
  it('the foreign lead becomes an OUTSIDE touch with no ids', async () => {
    const touch = await db.metaLeadTouch.findFirstOrThrow({ where: { organizationId: orgId, leadgenId: `lg-${run}` } })
    expect(touch.status).toBe('outside')
    expect([touch.adId, touch.adSetId, touch.campaignId, touch.adAccountId]).toEqual([null, null, null, null])
  })

  it('read.ts views', async () => {
    const u = sessionFor(orgId)
    for (const w of ['today', '7d', '30d', 'month', 'max'] as const) assertClean(`dashboard ${w}`, await getAdsDashboard(u, w))
    assertClean('billing', await getBillingView(u))
    assertClean('cycle', await getCycleView(u))
    for (const r of ['7d', '30d', 'all'] as const) {
      const f = await getFunnelView(u, r)
      assertClean(`funnel ${r}`, f)
      if (r === 'all') expect(f.outside).toBe(1)
    }
    const conn = await getConnectionView(u)
    assertClean('connection', conn)
    expect(conn.allowlist.accounts.map((a) => a.id)).toEqual([ALLOWED_ACCOUNT])
    const dash = await getAdsDashboard(u, '30d')
    expect(dash.totals.spend).toBe(600)
  })

  it('legacy consumers', async () => {
    const u = sessionFor(orgId)
    assertClean('marketing overview', await getMarketingOverview(u, marketingRange('90')))
    assertClean('campaign performance', await getCampaignPerformance(u))
    assertClean('attribution report', await getAttributionReport(u))
    assertClean('month spend', await monthSpend(orgId))
    assertClean('campaign trends', [...(await campaignTrends(orgId, 30)).entries()])
    expect(await monthSpend(orgId)).toBeLessThan(FOREIGN_SPEND)
  })

  it('the fb> console and target resolution', async () => {
    const u = sessionFor(orgId)
    for (const ref of [IDS.foreignCampaign, IDS.foreignAdSet, 'ZZ Foreign', LEGACY_NAME, MOCK_NAME]) {
      const t = await resolveTarget(orgId, ref)
      expect('error' in t, ref).toBe(true)
    }
    assertClean('console list', await runConsoleCommand(u, { kind: 'list' }))
    assertClean('console spend', await runConsoleCommand(u, { kind: 'spend', days: 30 }))
    const ok = await resolveTarget(orgId, IDS.campaignA)
    expect('error' in ok).toBe(false)
  })

  it('profile attribution rows and the daily-desk case', async () => {
    const rows = await attributionRowsFor(orgId, (await db.client.findUniqueOrThrow({ where: { id: clientId } })).leadAttribution)
    assertClean('attribution rows', rows)
    expect(rows.find((r) => r.label === 'Ad')?.value).toBe('Outside the connected ad account')
    const file = await loadCaseFile(sessionFor(orgId), clientId)
    assertClean('case file attribution', file?.leadAttribution)
    expect(file?.leadAttribution?.find((r) => r.label === 'Ad')?.value).toBe('Outside the connected ad account')
  })
})
