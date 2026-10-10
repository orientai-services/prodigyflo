/**
 * Facebook lead intake → compliant dialing (docs/TELEPHONY_LIVE.md §2.13,
 * §2.14), on top of Dakota's Meta intake: the phone hash, consent ONLY for
 * forms on the account's consentForms list, never for a preview fixture, the
 * callee state from leadAttribution.state, and the backfill script. Nothing
 * reaches Meta or Twilio.
 */
import { createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_SECRET = 'test-app-secret-not-real'
const ctxRef = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/meta/webhook-context', () => ({ resolveSigningContext: async () => ctxRef.current }))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    void Promise.resolve().then(fn)
  },
}))

import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { POST as metaLeads } from '@/app/api/meta/leads/route'
import { ingestCallCenterMetaLead } from '@/lib/call-center/meta-ingest'
import { SCS_ENGLISH_PAGE_ID, callCenterLeadId } from '@/lib/call-center/meta-route'
import { phoneHash } from '@/lib/telephony/compliance-core'
import { backfillLeadPhoneHashes } from '@/lib/telephony/backfill'
import { resolveDialTarget } from '@/lib/telephony/targets'
import { calleeZones } from '@/lib/telephony/timezones'
import { makeOrg, makeUser, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `tmeta-${Date.now().toString(36)}`
let orgId = ''
let rep: Awaited<ReturnType<typeof makeUser>>

function lead(id: string, phone: string, extra: Record<string, string> = {}, formId = 'form_consent') {
  return {
    leadgenId: id,
    createdTime: '2026-10-07T16:00:00+0000',
    fields: { full_name: 'Pat Example', phone_number: phone, email: `${id}@example.test`, ...extra },
    attribution: {
      adId: 'ad_1', adName: 'A', adsetId: 'as_1', adsetName: 'S', campaignId: 'c_1', campaignName: 'C',
      formId, platform: 'fb', isOrganic: false,
    },
  }
}

beforeAll(async () => {
  orgId = (await makeOrg(run)).orgId
  stubTelephonyEnv(orgId)
  rep = await makeUser(orgId, run, 'Rep', 'CLOSER')
  await db.organization.update({ where: { id: orgId }, data: { settings: { telephony: { consentForms: { form_consent: 'v2026-10-01' } } } } })
})

beforeEach(() => stubTelephonyEnv(orgId))
afterEach(() => {
  delete process.env.META_FIXTURE_LEADS
  vi.unstubAllGlobals()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.organization.delete({ where: { id: orgId } })
})

describe('a Facebook lead becomes dialable', () => {
  it('a form on the consent list: hash + consent keyed by the form', async () => {
    const phone = testNumber(run, 1)
    const { leadId } = await ingestCallCenterMetaLead({ organizationId: orgId, lead: lead(`${run}-1`, phone, { state: 'NV' }), pageId: SCS_ENGLISH_PAGE_ID, formId: 'form_consent' })
    const row = await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId } })
    expect(row.phoneHash).toBe(phoneHash(phone))
    expect(row).toMatchObject({ consentSource: 'lead_form', consentFormId: 'form_consent', consentTextVersion: 'v2026-10-01' })
    expect(row.consentAt).not.toBeNull()
    // Dakota's attribution is untouched.
    expect(row.leadAttribution).toMatchObject({ provider: 'meta', formId: 'form_consent', state: 'NV', outOfArea: false })
    expect(row.outOfArea).toBe(false)
  })

  it('a form NOT on the list gets the hash but no consent', async () => {
    const { leadId } = await ingestCallCenterMetaLead({
      organizationId: orgId,
      lead: lead(`${run}-2`, testNumber(run, 2), {}, 'form_other'),
      pageId: SCS_ENGLISH_PAGE_ID,
      formId: 'form_other',
    })
    const row = await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId } })
    expect(row.phoneHash).toBeTruthy()
    expect(row.consentAt).toBeNull()
    expect(row.consentSource).toBeNull()
  })

  it('a lead the webhook took in fixture mode never gets consent', async () => {
    process.env.META_FIXTURE_LEADS = 'true'
    // Fixture mode refuses production hosts (src/lib/meta/fixture.ts), so this test runs as local dev.
    vi.stubEnv('APP_URL', 'http://localhost:3300')
    ctxRef.current = { orgId, live: true, secret: TEST_SECRET, creds: { appId: 'test', appSecret: TEST_SECRET, systemUserToken: 'x' } }
    vi.stubGlobal('fetch', async () => {
      throw new Error('no network in this test')
    })
    const id = `${run}-fx`
    const raw = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: SCS_ENGLISH_PAGE_ID,
          time: 1,
          changes: [
            {
              field: 'leadgen',
              value: {
                leadgen_id: id,
                page_id: SCS_ENGLISH_PAGE_ID,
                form_id: 'form_consent',
                fixture_lead: {
                  id,
                  created_time: '2026-10-07T16:00:00+0000',
                  field_data: [
                    { name: 'full_name', values: ['STAGING TEST'] },
                    { name: 'phone_number', values: [testNumber(run, 3)] },
                  ],
                  form_id: 'form_consent',
                  platform: 'fb',
                },
              },
            },
          ],
        },
      ],
    })
    const sig = 'sha256=' + createHmac('sha256', TEST_SECRET).update(raw).digest('hex')
    const res = await metaLeads(new Request('http://localhost/api/meta/leads', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw }))
    expect(res.status).toBe(200)
    const row = await db.callCenterLead.findUniqueOrThrow({ where: { id: callCenterLeadId(orgId, id) } })
    expect(row.phoneHash).toBeTruthy()
    expect(row.consentAt).toBeNull()
  })

  it('the callee zone comes from leadAttribution.state, alongside the area code', async () => {
    const phone = testNumber(run, 4)
    const { leadId } = await ingestCallCenterMetaLead({ organizationId: orgId, lead: lead(`${run}-4`, phone, { state: 'Texas' }), pageId: SCS_ENGLISH_PAGE_ID, formId: 'form_consent' })
    await db.callCenterLead.update({ where: { id: leadId }, data: { lockedBy: rep.id } })
    const resolved = await resolveDialTarget(rep.actor, { kind: 'lead', id: leadId })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.target.zoneHints.states).toEqual(['TX'])
    expect(resolved.target.zoneHints.outOfArea).toBe(true)
    expect(calleeZones(resolved.target.zoneHints).zones).toEqual(['America/Chicago', 'America/Denver', 'America/Los_Angeles'])
    expect(resolved.target.purpose).toBe('marketing')
  })

  it('a 10-digit form phone hashes the same as the +1 an inbound call carries', async () => {
    const e164 = testNumber(run, 5)
    const { leadId } = await ingestCallCenterMetaLead({ organizationId: orgId, lead: lead(`${run}-5`, e164.slice(2)), pageId: SCS_ENGLISH_PAGE_ID, formId: 'form_consent' })
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId } })).phoneHash).toBe(phoneHash(e164))
  })
})

describe('the phone-hash backfill', () => {
  it('dry run writes nothing; execute hashes bare-digit phones; a second run is a no-op', async () => {
    const tenDigits = testNumber(run, 6).slice(2)
    const row = await db.callCenterLead.create({
      data: { organizationId: orgId, source: 'FORM', language: 'EN', phoneLast4: tenDigits.slice(-4), phoneSecret: encryptSecret(tenDigits) as never },
    })
    const bad = await db.callCenterLead.create({
      data: { organizationId: orgId, source: 'FORM', language: 'EN', phoneSecret: encryptSecret('12') as never },
    })

    const dry = await backfillLeadPhoneHashes({ execute: false, organizationId: orgId })
    expect(dry).toMatchObject({ dryRun: true, hashed: 1, unnormalizable: 1 })
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: row.id } })).phoneHash).toBeNull()

    const done = await backfillLeadPhoneHashes({ execute: true, organizationId: orgId })
    expect(done).toMatchObject({ dryRun: false, hashed: 1, unnormalizable: 1 })
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: row.id } })).phoneHash).toBe(phoneHash(`+1${tenDigits}`))
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: bad.id } })).phoneHash).toBeNull()

    const again = await backfillLeadPhoneHashes({ execute: true, organizationId: orgId })
    expect(again.hashed).toBe(0)
    // Counts only: nothing in the report is a number.
    expect(JSON.stringify(again)).not.toMatch(/\d{7,}/)
  })
})
