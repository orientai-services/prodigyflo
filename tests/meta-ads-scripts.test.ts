/**
 * scripts/meta-attribution-scrub.ts and scripts/meta-ads-classify-legacy.ts:
 * dry run by default, counts only, idempotent. Graph is the fake one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { ingestMetaLead } from '@/lib/meta'
import { scrubAttribution } from '../scripts/meta-attribution-scrub'
import { classifyLegacy } from '../scripts/meta-ads-classify-legacy'
import { fakeGraph } from './fixtures/meta-graph/fake-graph'
import { ALLOWED_ACCOUNT, ALLOWED_DIGITS, FOREIGN_DIGITS, FOREIGN_NAMES, IDS } from './fixtures/meta-graph/ids'
import { clearSharedRows, makeOrg } from './fixtures/meta-graph/setup'

const run = `mscr-${Date.now().toString(36)}`
let orgId: string
let clientId: string
let ccId: string

beforeAll(async () => {
  await clearSharedRows()
  orgId = (await makeOrg(run)).id
  const r = await ingestMetaLead(orgId, { leadgenId: `lg-${run}`, createdTime: new Date().toISOString(), fields: { full_name: 'Scrub Person', email: `${run}@example.test`, phone_number: '+17025550177' } })
  clientId = r.submission.clientId!
  const named = {
    provider: 'meta', leadgenId: `lg-${run}`, adId: IDS.foreignAd, adName: FOREIGN_NAMES.ad, adsetId: IDS.foreignAdSet, adsetName: FOREIGN_NAMES.adSet,
    campaignId: IDS.foreignCampaign, campaignName: FOREIGN_NAMES.campaign, formId: 'f', platform: 'fb', isOrganic: false, capturedAt: new Date().toISOString(),
  }
  await db.client.update({ where: { id: clientId }, data: { leadAttribution: named, utmCampaign: FOREIGN_NAMES.campaign } })
  await db.intakeSubmission.update({ where: { id: r.submission.id }, data: { rawPayload: { utm_campaign: FOREIGN_NAMES.campaign, first_name: 'Scrub' }, mappedPayload: { utmCampaign: FOREIGN_NAMES.campaign, firstName: 'Scrub' } } })
  ccId = (await db.callCenterLead.create({ data: { organizationId: orgId, source: 'FORM', language: 'EN', leadAttribution: { ...named, leadgenId: `lg-${run}-cc` } } })).id

  // Legacy rows for the classifier: one in the approved account, one foreign, one mock.
  await db.campaign.create({ data: { organizationId: orgId, channel: 'meta', externalId: IDS.campaignA, name: 'Legacy allowed' } })
  await db.campaign.create({ data: { organizationId: orgId, channel: 'meta', externalId: IDS.foreignCampaign, name: FOREIGN_NAMES.campaign } })
  await db.campaign.create({ data: { organizationId: orgId, channel: 'meta', externalId: 'mock_abc', name: 'Legacy mock' } })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.organization.delete({ where: { id: orgId } })
  await clearSharedRows()
})

describe('attribution scrub', () => {
  it('dry run counts and changes nothing', async () => {
    const lines: string[] = []
    const c = await scrubAttribution({ log: (l) => lines.push(l) })
    expect(c.clientsNamed).toBeGreaterThanOrEqual(1)
    expect(c.callCenterNamed).toBeGreaterThanOrEqual(1)
    expect(c.named).toBeGreaterThanOrEqual(2)
    expect(lines.join('\n')).not.toContain(FOREIGN_NAMES.campaign)
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
    expect((client.leadAttribution as { campaignName: string }).campaignName).toBe(FOREIGN_NAMES.campaign)
  })

  it('--commit nulls names (ids stay), clears utm_campaign everywhere, and is idempotent', async () => {
    await scrubAttribution({ commit: true })
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
    expect(client.leadAttribution).toMatchObject({ adId: IDS.foreignAd, adName: null, adsetName: null, campaignName: null })
    expect(client.utmCampaign).toBeNull()
    const subs = await db.intakeSubmission.findMany({ where: { clientId } })
    expect(JSON.stringify(subs)).not.toContain(FOREIGN_NAMES.campaign)
    expect(JSON.stringify(subs)).toContain('Scrub')
    const cc = await db.callCenterLead.findUniqueOrThrow({ where: { id: ccId } })
    expect(JSON.stringify(cc.leadAttribution)).not.toContain(FOREIGN_NAMES.ad)
    const again = await scrubAttribution({ commit: false })
    expect(again.named).toBe(0)
  })
})

describe('classify legacy', () => {
  it('refuses without a live binding', async () => {
    vi.stubEnv('META_ADS_ORG_ID', '')
    expect(await classifyLegacy({ env: { ...process.env, META_ADS_ORG_ID: '' } })).toHaveProperty('refused')
    vi.unstubAllEnvs()
  })

  it('dry run counts only; --commit sets the approved account on allowed rows and leaves the rest hidden', async () => {
    const env = { NODE_ENV: 'test', META_ADS_ORG_ID: orgId, META_ALLOWED_AD_ACCOUNTS: ALLOWED_ACCOUNT, META_ADS_APP_ID: 'ads-app-1', META_ADS_APP_SECRET: 's', META_ADS_SYSTEM_USER_TOKEN: 'TEST-ADS-TOKEN-not-real' }
    const owners = { [IDS.campaignA]: ALLOWED_DIGITS, [IDS.foreignCampaign]: FOREIGN_DIGITS }
    const lines: string[] = []
    const dry = await classifyLegacy({ env, fetchImpl: fakeGraph({ owners }).fetchImpl, log: (l) => lines.push(l) })
    expect(dry).toMatchObject({ campaigns: { checked: 2, allowed: 1, hidden: 1, skippedMock: 1 } })
    expect(lines.join('\n')).not.toMatch(/Legacy|ZZ|\d{8,}/)
    expect(await db.campaign.count({ where: { organizationId: orgId, adAccountId: { not: null } } })).toBe(0)

    await classifyLegacy({ env, fetchImpl: fakeGraph({ owners }).fetchImpl, commit: true })
    const rows = await db.campaign.findMany({ where: { organizationId: orgId }, select: { externalId: true, adAccountId: true } })
    expect(rows.find((r) => r.externalId === IDS.campaignA)?.adAccountId).toBe(ALLOWED_ACCOUNT)
    expect(rows.find((r) => r.externalId === IDS.foreignCampaign)?.adAccountId).toBeNull()
    expect(rows.find((r) => r.externalId === 'mock_abc')?.adAccountId).toBeNull()
  })
})
