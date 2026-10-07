/**
 * End to end through POST /api/meta/leads with signed sample webhook payloads
 * (HMAC with a TEST app secret) and a mocked Graph API. Nothing here reaches Meta:
 * global fetch is replaced, and any non-Graph URL fails the test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'

const TEST_SECRET = 'test-app-secret-not-real'
const ctxRef: { current: unknown } = { current: null }

vi.mock('@/lib/meta/webhook-context', () => ({
  resolveSigningContext: async () => ctxRef.current,
}))
// after() needs a live Next request scope; run the callback inline instead.
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => { void Promise.resolve().then(fn) },
}))

import { db } from '@/lib/db'
import { POST } from '@/app/api/meta/leads/route'
import { SCS_ENGLISH_PAGE_ID } from '@/lib/call-center/meta-route'

const run = `mwatt-${Date.now().toString(36)}`
const OTHER_PAGE = `page_${run}`

type GraphCall = { url: URL; method: string }
let graphCalls: GraphCall[] = []
let graphLeads: Record<string, unknown> = {}
let graphDown = false

function sign(raw: string, secret = TEST_SECRET) {
  return 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
}

function webhook(value: Record<string, unknown>, pageId = OTHER_PAGE) {
  return JSON.stringify({ object: 'page', entry: [{ id: pageId, time: 1, changes: [{ field: 'leadgen', value }] }] })
}

function post(raw: string, sig = sign(raw)) {
  return POST(new Request('http://localhost/api/meta/leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    body: raw,
  }))
}

function phoneFor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `+1702${String(2000000 + (h % 7999999)).padStart(7, '0')}`
}

function graphLead(id: string, over: { state?: string; zip?: string; name?: string; platform?: string } = {}) {
  return {
    id,
    created_time: '2026-10-07T16:00:00+0000',
    field_data: [
      { name: 'full_name', values: [over.name ?? 'STAGING TEST Person'] },
      { name: 'email', values: [`${id}@example.test`] },
      // Unique per lead: intake dedupes on phone, so a shared number would merge leads.
      { name: 'phone_number', values: [phoneFor(id)] },
      ...(over.state ? [{ name: 'state', values: [over.state] }] : []),
      ...(over.zip ? [{ name: 'zip_code', values: [over.zip] }] : []),
    ],
    ad_id: 'ad_1', ad_name: 'Video A', adset_id: 'as_1', adset_name: 'LV 35+',
    campaign_id: 'c_1', campaign_name: 'Q4 Solar Review', form_id: 'form_1',
    platform: over.platform ?? 'ig', is_organic: false,
  }
}

describe('Meta webhook → attribution + out-of-area', () => {
  let orgId: string
  const realFetch = globalThis.fetch

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: `Org ${run}`, slug: run } })
    orgId = org.id
    const pipeline = await db.pipeline.create({ data: { organizationId: orgId, name: 'P', isDefault: true } })
    await db.pipelineStage.create({ data: { pipelineId: pipeline.id, key: 'NEW_LEAD', name: 'New', category: 'INTAKE', position: 0 } })
    ctxRef.current = {
      orgId, live: true, secret: TEST_SECRET,
      creds: { appId: 'test-app', appSecret: TEST_SECRET, systemUserToken: 'test-su-token' },
    }
  })

  beforeEach(() => {
    graphCalls = []
    graphLeads = {}
    graphDown = false
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname !== 'graph.facebook.com') throw new Error(`unexpected network call to ${url.hostname}`)
      graphCalls.push({ url, method: init?.method ?? 'GET' })
      const id = url.pathname.split('/').pop()!
      if (graphDown) return new Response(JSON.stringify({ error: { message: 'boom', code: 2 } }), { status: 500 })
      const body = graphLeads[id]
      if (!body) return new Response(JSON.stringify({ error: { message: 'unknown lead', code: 100 } }), { status: 400 })
      return new Response(JSON.stringify(body), { status: 200 })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.META_FIXTURE_LEADS
    delete process.env.VERCEL_ENV
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    await db.organization.delete({ where: { id: orgId } })
  })

  it('saves ad / ad set / campaign / form / platform / organic onto the new contact', async () => {
    const id = `${run}-nv`
    graphLeads[id] = graphLead(id, { state: 'NV', zip: '89117' })
    const res = await post(webhook({ leadgen_id: id, page_id: OTHER_PAGE, form_id: 'form_1', ad_id: 'ad_1', adgroup_id: 'as_1' }))
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.results[0]).toMatchObject({ leadgenId: id, created: true })

    // One GET to Graph, asking for the attribution fields. Never a write.
    expect(graphCalls).toHaveLength(1)
    expect(graphCalls[0].method).toBe('GET')
    expect(graphCalls[0].url.searchParams.get('fields')).toContain('campaign_name')
    expect(graphCalls[0].url.searchParams.get('fields')).toContain('is_organic')

    const client = await db.client.findFirstOrThrow({ where: { organizationId: orgId, email: `${id}@example.test` } })
    expect(client.outOfArea).toBe(false)
    expect(client.utmSource).toBe('meta')
    expect(client.utmCampaign).toBe('Q4 Solar Review')
    expect(client.leadAttribution).toMatchObject({
      provider: 'meta', leadgenId: id, pageId: OTHER_PAGE,
      adId: 'ad_1', adName: 'Video A', adsetId: 'as_1', adsetName: 'LV 35+',
      campaignId: 'c_1', campaignName: 'Q4 Solar Review', formId: 'form_1',
      platform: 'ig', isOrganic: false, state: 'NV', outOfArea: false,
    })
  })

  it('keeps an out-of-state lead and flags it out_of_area', async () => {
    const id = `${run}-az`
    graphLeads[id] = graphLead(id, { state: 'Arizona', platform: 'fb' })
    const res = await post(webhook({ leadgen_id: id, page_id: OTHER_PAGE }))
    expect(res.status).toBe(200)
    const client = await db.client.findFirstOrThrow({ where: { organizationId: orgId, email: `${id}@example.test` } })
    expect(client.outOfArea).toBe(true)
    expect(client.deletedAt).toBeNull()
    expect(client.leadAttribution).toMatchObject({ state: 'AZ', outOfArea: true, platform: 'fb' })
  })

  it('flags from the ZIP when the form has no state', async () => {
    const id = `${run}-zip`
    graphLeads[id] = graphLead(id, { zip: '92101' })
    expect((await post(webhook({ leadgen_id: id }))).status).toBe(200)
    const client = await db.client.findFirstOrThrow({ where: { organizationId: orgId, email: `${id}@example.test` } })
    expect(client.outOfArea).toBe(true)
  })

  it('a redelivered webhook does not duplicate or overwrite attribution', async () => {
    const id = `${run}-nv`
    graphLeads[id] = { ...graphLead(id, { state: 'CA' }), campaign_name: 'Changed' }
    const res = await post(webhook({ leadgen_id: id }))
    expect((await res.json()).results[0].duplicate).toBe(true)
    const clients = await db.client.findMany({ where: { organizationId: orgId, email: `${id}@example.test` } })
    expect(clients).toHaveLength(1)
    expect(clients[0].outOfArea).toBe(false)
    expect((clients[0].leadAttribution as { campaignName: string }).campaignName).toBe('Q4 Solar Review')
  })

  it('English Page leads land on the Call Center desk with attribution + flag', async () => {
    const id = `${run}-en`
    graphLeads[id] = graphLead(id, { state: 'TX' })
    const res = await post(webhook({ leadgen_id: id, page_id: SCS_ENGLISH_PAGE_ID, ad_id: 'ad_1' }, SCS_ENGLISH_PAGE_ID))
    expect(res.status).toBe(200)
    const lead = await db.callCenterLead.findFirstOrThrow({ where: { organizationId: orgId, pageId: SCS_ENGLISH_PAGE_ID } })
    expect(lead.outOfArea).toBe(true)
    expect(lead.leadAttribution).toMatchObject({ campaignName: 'Q4 Solar Review', adId: 'ad_1', state: 'TX', platform: 'ig' })
    expect(await db.client.count({ where: { organizationId: orgId, email: `${id}@example.test` } })).toBe(0)
  })

  it('rejects a payload signed with the wrong secret (no Graph call, no contact)', async () => {
    const id = `${run}-forged`
    graphLeads[id] = graphLead(id)
    const raw = webhook({ leadgen_id: id })
    const res = await post(raw, sign(raw, 'not-the-secret'))
    expect(res.status).toBe(401)
    expect(graphCalls).toHaveLength(0)
    expect(await db.client.count({ where: { organizationId: orgId, email: `${id}@example.test` } })).toBe(0)
  })

  it('a failed Graph read returns 503 so Meta redelivers', async () => {
    graphDown = true
    const id = `${run}-down`
    const res = await post(webhook({ leadgen_id: id }))
    expect(res.status).toBe(503)
    expect(await db.client.count({ where: { organizationId: orgId, email: `${id}@example.test` } })).toBe(0)
  })

  it('fixture mode reads the signed mocked Graph lead and never calls Graph', async () => {
    process.env.META_FIXTURE_LEADS = 'true'
    const id = `${run}-fx`
    const raw = webhook({ leadgen_id: id, fixture_lead: graphLead(id, { state: 'NV', name: 'STAGING TEST Fixture' }) })
    const res = await post(raw)
    expect(res.status).toBe(200)
    expect(graphCalls).toHaveLength(0)
    const client = await db.client.findFirstOrThrow({ where: { organizationId: orgId, email: `${id}@example.test` } })
    expect(client.firstName).toBe('STAGING')
    expect(client.leadAttribution).toMatchObject({ campaignName: 'Q4 Solar Review', adsetName: 'LV 35+', platform: 'ig' })
  })

  it('fixture_lead is ignored in production: the real Graph read runs instead', async () => {
    process.env.META_FIXTURE_LEADS = 'true'
    process.env.VERCEL_ENV = 'production'
    const id = `${run}-prodfx`
    graphLeads[id] = graphLead(id, { state: 'NV', name: 'From Graph' })
    const raw = webhook({ leadgen_id: id, fixture_lead: graphLead(id, { name: 'From Fixture' }) })
    expect((await post(raw)).status).toBe(200)
    expect(graphCalls).toHaveLength(1)
    const client = await db.client.findFirstOrThrow({ where: { organizationId: orgId, email: `${id}@example.test` } })
    expect(client.firstName).toBe('From')
    expect(client.lastName).toBe('Graph')
  })

  it('fixture mode still requires a valid signature', async () => {
    process.env.META_FIXTURE_LEADS = 'true'
    const id = `${run}-fxforged`
    const raw = webhook({ leadgen_id: id, fixture_lead: graphLead(id) })
    expect((await post(raw, sign(raw, 'nope'))).status).toBe(401)
    expect(await db.client.count({ where: { organizationId: orgId, email: `${id}@example.test` } })).toBe(0)
  })
})
