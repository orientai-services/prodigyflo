/**
 * P0-A (docs/META_ADS_SCS.md §3.9) end to end through POST /api/meta/leads with
 * a mocked Graph that returns names. A lead whose ad belongs to the fake
 * foreign account must leave its names nowhere: no DB column, no intake
 * payload, no profile row. A lead from the approved account shows the SYNCED
 * names, never Graph's lead-time names.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'

const TEST_SECRET = 'test-app-secret-not-real-p0a'
const ctxRef: { current: unknown; orgId: string } = { current: null, orgId: '' }

vi.mock('@/lib/meta/webhook-context', () => ({
  resolveSigningContext: async () => ctxRef.current,
  resolveMetaOrg: async () => ({ id: ctxRef.orgId }),
}))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => { void Promise.resolve().then(fn) },
}))

import { db } from '@/lib/db'
import { POST } from '@/app/api/meta/leads/route'
import { syncAdsForOrg } from '@/lib/meta/ads/sync'
import { attributionRowsFor } from '@/lib/meta/ads/attribution-names'
import { fakeGraph } from './fixtures/meta-graph/fake-graph'
import { FOREIGN_DIGITS, FOREIGN_NAMES, IDS } from './fixtures/meta-graph/ids'
import { clearSharedRows, makeOrg, stubLiveEnv } from './fixtures/meta-graph/setup'

const run = `mp0a-${Date.now().toString(36)}`
const PAGE = `page_${run}`
let orgId: string
const graphLeads: Record<string, unknown> = {}

const sign = (raw: string) => 'sha256=' + createHmac('sha256', TEST_SECRET).update(raw).digest('hex')
const webhook = (value: Record<string, unknown>) => JSON.stringify({ object: 'page', entry: [{ id: PAGE, time: 1, changes: [{ field: 'leadgen', value }] }] })
const post = (raw: string) => POST(new Request('http://localhost/api/meta/leads', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) }, body: raw }))

function lead(id: string, ad: { ad: string; adset: string; campaign: string; names: [string, string, string] }, phone: string) {
  return {
    id, created_time: '2026-10-08T16:00:00+0000',
    field_data: [{ name: 'full_name', values: ['P0A Person'] }, { name: 'email', values: [`${id}@example.test`] }, { name: 'phone_number', values: [phone] }, { name: 'state', values: ['NV'] }],
    ad_id: ad.ad, ad_name: ad.names[2], adset_id: ad.adset, adset_name: ad.names[1], campaign_id: ad.campaign, campaign_name: ad.names[0],
    form_id: 'form_p0a', platform: 'fb', is_organic: false,
  }
}

beforeAll(async () => {
  await clearSharedRows()
  orgId = (await makeOrg(run)).id
  ctxRef.orgId = orgId
  ctxRef.current = { orgId, live: true, secret: TEST_SECRET, creds: { appId: 'intake-app', appSecret: TEST_SECRET, systemUserToken: 'intake-token' } }
  stubLiveEnv(orgId)
  await syncAdsForOrg(orgId, { fetchImpl: fakeGraph().fetchImpl, force: true })
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await db.organization.delete({ where: { id: orgId } })
  await clearSharedRows()
})

function stubLeadGraph() {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = new URL(String(input))
    if (url.hostname !== 'graph.facebook.com') throw new Error(`unexpected network call to ${url.hostname}`)
    const body = graphLeads[url.pathname.split('/').pop()!]
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response(JSON.stringify({ error: { code: 100 } }), { status: 400 })
  })
}

describe('P0-A: names are never stored; read-time names come from allowed rows only', () => {
  it('a foreign-account lead leaves its names nowhere', async () => {
    stubLiveEnv(orgId)
    stubLeadGraph()
    const id = `${run}-foreign`
    graphLeads[id] = lead(id, { ad: IDS.foreignAd, adset: IDS.foreignAdSet, campaign: IDS.foreignCampaign, names: [FOREIGN_NAMES.campaign, FOREIGN_NAMES.adSet, FOREIGN_NAMES.ad] }, '+17025550141')
    const res = await post(webhook({ leadgen_id: id, page_id: PAGE, ad_id: IDS.foreignAd, adgroup_id: IDS.foreignAdSet, form_id: 'form_p0a' }))
    expect(res.status).toBe(200)

    const client = await db.client.findFirstOrThrow({ where: { organizationId: orgId, email: `${id}@example.test` } })
    const subs = await db.intakeSubmission.findMany({ where: { organizationId: orgId, clientId: client.id } })
    const everything = JSON.stringify({ client, subs })
    for (const n of Object.values(FOREIGN_NAMES)) expect(everything).not.toContain(n)
    expect(client.utmCampaign).toBeNull()
    expect(client.campaignId).toBeNull()

    // Before the touch is checked it is NOT called outside: that isn't proven yet.
    const before = await attributionRowsFor(orgId, client.leadAttribution)
    expect(JSON.stringify(before)).not.toContain(IDS.foreignAd)
    expect(before.find((r) => r.label === 'Ad')?.value).toBe('Not matched to an ad yet')

    // The sync's ownership probe proves the ad is in another account.
    await syncAdsForOrg(orgId, { fetchImpl: fakeGraph({ owners: { [IDS.foreignAd]: FOREIGN_DIGITS } }).fetchImpl })
    const rows = await attributionRowsFor(orgId, client.leadAttribution)
    expect(JSON.stringify(rows)).not.toContain(IDS.foreignAd)
    expect(rows.find((r) => r.label === 'Ad')?.value).toBe('Outside the connected ad account')
    expect(rows.some((r) => r.label === 'Campaign' || r.label === 'Ad set')).toBe(false)
  })

  it('an approved-account lead shows the synced names, not Graph lead-time names', async () => {
    stubLiveEnv(orgId)
    stubLeadGraph()
    const id = `${run}-allowed`
    graphLeads[id] = lead(id, { ad: IDS.adA1a, adset: IDS.adSetA1, campaign: IDS.campaignA, names: ['Graph Camp Name', 'Graph Set Name', 'Graph Ad Name'] }, '+17025550142')
    const res = await post(webhook({ leadgen_id: id, page_id: PAGE, ad_id: IDS.adA1a, adgroup_id: IDS.adSetA1, form_id: 'form_p0a' }))
    expect(res.status).toBe(200)

    const client = await db.client.findFirstOrThrow({ where: { organizationId: orgId, email: `${id}@example.test` } })
    expect(JSON.stringify(client.leadAttribution)).not.toContain('Graph')
    expect(client.utmCampaign).toBe('Campaign A') // from the allowed local campaign
    const rows = Object.fromEntries((await attributionRowsFor(orgId, client.leadAttribution)).map((r) => [r.label, r.value]))
    expect(rows.Campaign).toBe(`Campaign A (${IDS.campaignA})`)
    expect(rows['Ad set']).toBe(`Ad set A1 (${IDS.adSetA1})`)
    expect(rows.Ad).toBe(`Ad A1a (${IDS.adA1a})`)
  })

  it('another workspace sees no names even for the approved account', async () => {
    stubLiveEnv(orgId)
    const other = await makeOrg(`${run}-other`)
    try {
      const raw = { provider: 'meta', leadgenId: 'x', adId: IDS.adA1a, adsetId: IDS.adSetA1, campaignId: IDS.campaignA }
      const rows = await attributionRowsFor(other.id, raw)
      expect(JSON.stringify(rows)).not.toContain('Campaign A')
      // No ads reporting there: no ad rows at all, and never a false "outside".
      expect(rows.some((r) => ['Campaign', 'Ad set', 'Ad'].includes(r.label))).toBe(false)
      expect(JSON.stringify(rows)).not.toContain(IDS.adA1a)
    } finally {
      await db.organization.delete({ where: { id: other.id } })
    }
  })
})
