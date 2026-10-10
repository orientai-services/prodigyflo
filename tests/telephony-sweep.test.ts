/**
 * runTelephonySweep (docs/TELEPHONY_LIVE.md §2.11): it runs even on the final
 * desk, reconciles stuck calls / lost recordings / stale texts from Twilio's
 * real state, gives up honestly ('unknown') after 4 hours, puts a timeout on
 * every fetch, respects its budget and never throws. Twilio is a stub.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/intake/scs-document-import', () => ({
  runPendingScsDocumentImports: async () => ({ skipped: 'test' }),
  runPendingScsDocumentExtractions: async () => ({ skipped: 'test' }),
}))
vi.mock('@/lib/property-records/jobs', () => ({ runPropertyRecordsJobs: async () => ({ skipped: 'test' }) }))

import { db } from '@/lib/db'
import { GET as runJobs } from '@/app/api/jobs/run/route'
import { runTelephonySweep } from '@/lib/telephony/sweep'
import { listMissed } from '@/lib/telephony/voice-calls'
import { ACCOUNT, makeOrg, makeUser, sid, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `tsweep-${Date.now().toString(36)}`
const NOW = new Date('2026-10-07T18:00:00.000Z')
const minutes = (m: number) => new Date(NOW.getTime() - m * 60_000)
let orgId = ''
let pipelineId = ''
let stageId = ''
let calls: { url: string; init: RequestInit }[] = []
let routes: Record<string, () => Response> = {}

function fetcher(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input)
  calls.push({ url, init: init ?? {} })
  for (const [needle, make] of Object.entries(routes)) if (url.includes(needle)) return Promise.resolve(make())
  return Promise.resolve(new Response(JSON.stringify({ message: 'not found' }), { status: 404 }))
}

beforeAll(async () => {
  const org = await makeOrg(run)
  orgId = org.orgId
  pipelineId = org.pipelineId
  stageId = org.intakeStageId
})

beforeEach(() => {
  stubTelephonyEnv(orgId, { TELEPHONY_PROVIDER: 'twilio' })
  calls = []
  routes = {}
  vi.stubGlobal('fetch', fetcher)
})

afterEach(() => vi.unstubAllGlobals())

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.telephonyAccountState.deleteMany({ where: { accountSid: ACCOUNT } })
  await db.organization.delete({ where: { id: orgId } })
})

describe('the sweep', () => {
  it('fetches the real status of a call still "active" after 15 minutes and finalizes it', async () => {
    const callSid = sid('CA', run, 'stuck')
    const vc = await db.voiceCall.create({
      data: { organizationId: orgId, callSid, accountSid: ACCOUNT, direction: 'INBOUND', status: 'ringing', stage: 'forward', startedAt: minutes(20) },
    })
    routes[`/Calls/${callSid}.json`] = () => new Response(JSON.stringify({ status: 'completed', duration: '40', end_time: 'Wed, 07 Oct 2026 17:45:00 +0000' }))
    const summary = await runTelephonySweep(NOW, { fetcher, organizationId: orgId })
    expect(summary.calls).toMatchObject({ checked: 1, resolved: 1 })
    const row = await db.voiceCall.findUniqueOrThrow({ where: { id: vc.id } })
    expect(row).toMatchObject({ status: 'completed', durationSeconds: 40, outcome: 'NO_ANSWER', needsAction: true })
  })

  it('after 4 hours with no answer from Twilio, the call is "unknown" — no outcome guessed', async () => {
    const vc = await db.voiceCall.create({
      data: { organizationId: orgId, callSid: sid('CA', run, 'lost'), accountSid: ACCOUNT, direction: 'OUTBOUND', status: 'in-progress', startedAt: minutes(5 * 60) },
    })
    routes[`/Calls/`] = () => new Response('boom', { status: 500 })
    await runTelephonySweep(NOW, { fetcher, organizationId: orgId })
    const row = await db.voiceCall.findUniqueOrThrow({ where: { id: vc.id } })
    expect(row.status).toBe('unknown')
    expect(row.outcome).toBeNull()
  })

  it('recovers a recording whose callback never came', async () => {
    const callSid = sid('CA', run, 'norec')
    const vc = await db.voiceCall.create({
      data: {
        organizationId: orgId,
        callSid,
        accountSid: ACCOUNT,
        direction: 'INBOUND',
        status: 'completed',
        outcome: 'CONNECTED',
        startedAt: minutes(15),
        endedAt: minutes(10),
        recordingExpected: true,
      },
    })
    routes[`/Calls/${callSid}/Recordings.json`] = () => new Response(JSON.stringify({ recordings: [{ sid: sid('RE', run, 'norec'), duration: '30' }] }))
    const summary = await runTelephonySweep(NOW, { fetcher, organizationId: orgId })
    expect(summary.recordings.recovered).toBe(1)
    expect(await db.voiceCall.findUniqueOrThrow({ where: { id: vc.id } })).toMatchObject({ recordingSid: sid('RE', run, 'norec'), recordingKind: 'call' })
  })

  it('moves a text still "Accepted by carrier" after 10 minutes to Twilio’s real answer', async () => {
    const client = await db.client.create({
      data: { organizationId: orgId, pipelineId, currentStageId: stageId, firstName: 'S', lastName: 'W', email: `sw.${run}@example.test`, phone: testNumber(run, 1) },
    })
    const ref = sid('SM', run, 'stale')
    const comm = await db.communication.create({
      data: { clientId: client.id, channel: 'SMS', direction: 'OUTBOUND', status: 'SENT', externalRef: ref, occurredAt: minutes(30), message: { create: {} } },
    })
    routes[`/Messages/${ref}.json`] = () => new Response(JSON.stringify({ status: 'undelivered', error_code: 30034 }))
    await runTelephonySweep(NOW, { fetcher, organizationId: orgId })
    const row = await db.communication.findUniqueOrThrow({ where: { id: comm.id }, include: { message: true } })
    expect(row.status).toBe('FAILED')
    expect(row.message?.failureCode).toBe('30034: texting registration (A2P) pending')
  })

  it('puts a timeout on every Twilio fetch', async () => {
    await db.voiceCall.create({
      data: { organizationId: orgId, callSid: sid('CA', run, 'to'), accountSid: ACCOUNT, direction: 'INBOUND', status: 'ringing', startedAt: minutes(30) },
    })
    await runTelephonySweep(NOW, { fetcher, organizationId: orgId })
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('respects its budget and never throws', async () => {
    const none = await runTelephonySweep(NOW, { fetcher, organizationId: orgId, budgetMs: 0 })
    expect(none.budgetExhausted).toBe(true)
    expect(calls).toHaveLength(0)
    const boom = async () => {
      throw new Error('network down')
    }
    await db.voiceCall.create({
      data: { organizationId: orgId, callSid: sid('CA', run, 'boom'), accountSid: ACCOUNT, direction: 'INBOUND', status: 'ringing', startedAt: minutes(30) },
    })
    await expect(runTelephonySweep(NOW, { fetcher: boom as unknown as typeof fetch, organizationId: orgId })).resolves.toMatchObject({ mode: 'twilio' })
  })

  // compliance-sweep-unknown-skips-missed-queue
  it('an inbound call given up as "unknown" still lands in the missed list and its lead goes MISSED', async () => {
    const lead = await db.callCenterLead.create({ data: { organizationId: orgId, source: 'INBOUND', language: 'EN', status: 'INBOUND' } })
    const vc = await db.voiceCall.create({
      data: {
        organizationId: orgId,
        callSid: sid('CA', run, 'lost-in'),
        accountSid: ACCOUNT,
        direction: 'INBOUND',
        status: 'ringing',
        stage: 'browser',
        startedAt: minutes(5 * 60),
        callCenterLeadId: lead.id,
      },
    })
    routes[`/Calls/`] = () => new Response('boom', { status: 500 })
    await runTelephonySweep(NOW, { fetcher, organizationId: orgId })
    const row = await db.voiceCall.findUniqueOrThrow({ where: { id: vc.id } })
    expect(row).toMatchObject({ status: 'unknown', outcome: null, needsAction: true })
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('MISSED')
    expect(await db.callCenterEvent.count({ where: { leadId: lead.id, type: 'CALL', voiceCallId: vc.id } })).toBe(1)
    const manager = await makeUser(orgId, run, 'Sweep Manager', 'SUPER_ADMIN', { permissions: ['telephony:manage'] })
    expect((await listMissed(manager.actor)).some((m) => m.id === vc.id)).toBe(true)
  })

  // regression-sms-sweep-starvation
  it('texts Twilio never resolves go to the back of the queue, so a newer one still gets reconciled', async () => {
    const client = await db.client.create({
      data: { organizationId: orgId, pipelineId, currentStageId: stageId, firstName: 'Q', lastName: 'Ueue', email: `queue.${run}@example.test`, phone: testNumber(run, 2) },
    })
    for (let i = 0; i < 26; i += 1) {
      await db.communication.create({
        data: { clientId: client.id, channel: 'SMS', direction: 'OUTBOUND', status: 'SENT', externalRef: sid('SM', run, `old-${i}`), occurredAt: minutes(120 + i), message: { create: {} } },
      })
    }
    const newer = sid('SM', run, 'newer')
    const comm = await db.communication.create({
      data: { clientId: client.id, channel: 'SMS', direction: 'OUTBOUND', status: 'SENT', externalRef: newer, occurredAt: minutes(30), message: { create: {} } },
    })
    // Every old text 404s at Twilio; only the newer one has an answer.
    routes[`/Messages/${newer}.json`] = () => new Response(JSON.stringify({ status: 'undelivered', error_code: 30034 }))
    await runTelephonySweep(NOW, { fetcher, organizationId: orgId })
    await runTelephonySweep(NOW, { fetcher, organizationId: orgId })
    expect((await db.communication.findUniqueOrThrow({ where: { id: comm.id } })).status).toBe('FAILED')
  })

  it('runs from the job runner even under PRODIGYFLO_FINAL_DESK', async () => {
    vi.stubEnv('PRODIGYFLO_FINAL_DESK', 'true')
    vi.stubEnv('JOBS_TOKEN', 'test-jobs-token')
    vi.stubEnv('TELEPHONY_PROVIDER', 'mock')
    const res = await runJobs(new Request('http://localhost/api/jobs/run', { headers: { authorization: 'Bearer test-jobs-token' } }) as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.legacyAutomation).toEqual({ status: 'DISABLED_FOR_FINAL_DESK' })
    expect(body.telephonySweep).toMatchObject({ mode: 'mock' })
  })
})
