import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { MockMetaAdsProvider } from '@/lib/meta/mock'
import { ensureMetaIntakeSource, ingestMetaLead } from '@/lib/meta'
import { metaVerifyToken } from '@/lib/meta/provider'

const run = `meta-${Date.now().toString(36)}`

describe('meta ads (mock provider)', () => {
  let orgId: string
  const provider = new MockMetaAdsProvider()

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: `Org ${run}`, slug: run } })
    orgId = org.id
    const pipeline = await db.pipeline.create({ data: { organizationId: orgId, name: 'P', isDefault: true } })
    await db.pipelineStage.create({
      data: { pipelineId: pipeline.id, key: 'NEW_LEAD', name: 'New', category: 'INTAKE', position: 0 },
    })
  })

  afterAll(async () => {
    await db.organization.delete({ where: { id: orgId } })
  })

  it('creates a campaign and accrues deterministic spend', async () => {
    const c = await provider.createCampaign(orgId, {
      name: 'Test LV leads', objective: 'LEADS', dailyBudget: 40, status: 'ACTIVE',
    })
    expect(c.externalId).toMatch(/^mock_/)

    const listed = await provider.listCampaigns(orgId)
    const mine = listed.find((x) => x.id === c.id)!
    expect(mine.spend).toBeGreaterThan(0)
    expect(mine.spend).toBeLessThanOrEqual(40) // one day, never above daily budget

    // determinism: a second read reports the same figures
    const again = (await provider.listCampaigns(orgId)).find((x) => x.id === c.id)!
    expect(again.spend).toBe(mine.spend)
  })

  it('paused campaigns accrue nothing', async () => {
    const c = await provider.createCampaign(orgId, {
      name: 'Paused', objective: 'LEADS', dailyBudget: 99, status: 'PAUSED',
    })
    const mine = (await provider.listCampaigns(orgId)).find((x) => x.id === c.id)!
    expect(mine.spend).toBe(0)
  })

  it('daily stats aggregate across campaigns', async () => {
    const stats = await provider.dailyStats(orgId, 7)
    expect(stats.length).toBeGreaterThan(0)
    for (const s of stats) expect(s.spend).toBeGreaterThanOrEqual(0)
  })

  it('ingest: a Meta lead becomes a CRM client, replays are idempotent', async () => {
    const lead = await provider.fetchLead(`lg_${run}_1`)
    const first = await ingestMetaLead(orgId, lead)
    expect(first.duplicate).toBe(false)
    expect(first.submission.status).toBe('APPLIED')
    expect(first.submission.clientId).toBeTruthy()

    // Meta redelivers webhooks — same leadgen id must not create a second lead.
    const replay = await ingestMetaLead(orgId, lead)
    expect(replay.duplicate).toBe(true)
    expect(replay.submission.id).toBe(first.submission.id)

    const clients = await db.client.count({ where: { organizationId: orgId, email: lead.fields.email } })
    expect(clients).toBe(1)
  })

  it('campaign attribution links the created client to the campaign via the ad set', async () => {
    const c = await provider.createCampaign(orgId, {
      name: 'Attrib', objective: 'LEADS', dailyBudget: 10, status: 'ACTIVE',
    })
    // Meta's leadgen webhook sends the ad SET id (adgroup_id), not a campaign id;
    // we resolve the campaign through the locally-synced ad set.
    const adSet = await db.adSet.create({
      data: { organizationId: orgId, campaignId: c.id, externalId: `as_${run}_2`, name: 'AS' },
    })
    const lead = await provider.fetchLead(`lg_${run}_2`)
    const r = await ingestMetaLead(orgId, lead, { adSetExternalId: adSet.externalId! })
    const client = await db.client.findUniqueOrThrow({ where: { id: r.submission.clientId! } })
    expect(client.campaignId).toBe(c.id)
    expect(client.utmSource).toBe('meta')
  })

  it('the meta intake source is created once and reused', async () => {
    const a = await ensureMetaIntakeSource(orgId)
    const b = await ensureMetaIntakeSource(orgId)
    expect(a.id).toBe(b.id)
    expect(a.kind).toBe('META_LEAD_ADS')
  })

  it('verify token is deterministic and non-trivial', () => {
    expect(metaVerifyToken()).toHaveLength(32)
    expect(metaVerifyToken()).toBe(metaVerifyToken())
  })
})
