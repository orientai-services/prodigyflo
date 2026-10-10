/**
 * An inbound call end to end through the real route handlers (§2.5, §2.12):
 * browser stage, TEAM in turn, voicemail, hang-ups, unknown callers becoming
 * leads, the one-call-at-a-time rule, org isolation, and the recording link
 * never being stored. Signed with a TEST token; nothing reaches Twilio.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const afterQueue = vi.hoisted(() => [] as (() => unknown)[])
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    afterQueue.push(fn)
  },
}))

import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { POST as voice } from '@/app/api/telephony/voice/route'
import { POST as voiceDial } from '@/app/api/telephony/voice/dial/route'
import { POST as voiceRecording } from '@/app/api/telephony/voice/recording/route'
import { POST as voiceStatus } from '@/app/api/telephony/voice/status/route'
import { backfillLeadPhoneHashes } from '@/lib/telephony/backfill'
import { listMissed } from '@/lib/telephony/voice-calls'
import { ACCOUNT, makeLine, makeOrg, makeUser, sid, signedPost, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `tin-${Date.now().toString(36)}`
let n = 0
const callSid = () => sid('CA', run, n++)

async function drain() {
  while (afterQueue.length) await afterQueue.shift()!()
}

type Org = Awaited<ReturnType<typeof makeOrg>>
let A: Org
let B: Org
let owner: Awaited<ReturnType<typeof makeUser>>
let repA: Awaited<ReturnType<typeof makeUser>>
let repB: Awaited<ReturnType<typeof makeUser>>
let mate1: Awaited<ReturnType<typeof makeUser>>
let mate2: Awaited<ReturnType<typeof makeUser>>


const FORWARD_LINE = testNumber(run, 1)
const TEAM_LINE = testNumber(run, 2)
const VM_LINE = testNumber(run, 3)
const B_LINE = testNumber(run, 4)
const FORWARD_TO = testNumber(run, 5)
const MATE1 = testNumber(run, 6)
const MATE2 = testNumber(run, 7)
const CLIENT_PHONE = testNumber(run, 8)

const params = (cs: string, to: string, from: string, extra: Record<string, string> = {}) => ({
  CallSid: cs,
  AccountSid: ACCOUNT,
  From: from,
  To: to,
  CallStatus: 'ringing',
  ...extra,
})

async function ring(cs: string, to: string, from: string, extra: Record<string, string> = {}) {
  const res = await voice(signedPost('/api/telephony/voice', params(cs, to, from, extra)))
  expect(res.status).toBe(200)
  return res.text()
}

async function dial(cs: string, to: string, from: string, stage: string, i: number, dialStatus: string, duration = '0') {
  const res = await voiceDial(
    signedPost(`/api/telephony/voice/dial?callSid=${cs}&stage=${stage}&i=${i}`, params(cs, to, from, { DialCallStatus: dialStatus, DialCallDuration: duration })),
  )
  expect(res.status).toBe(200)
  return res.text()
}

async function parentStatus(cs: string, to: string, from: string, status: string, duration = '30') {
  const res = await voiceStatus(signedPost('/api/telephony/voice/status', params(cs, to, from, { CallStatus: status, CallDuration: duration })))
  expect(res.status).toBe(204)
  await drain()
}

async function voicemail(cs: string, to: string, from: string, recordingSid: string, seconds = '14') {
  const res = await voiceRecording(
    signedPost(
      `/api/telephony/voice/recording?callSid=${cs}&kind=voicemail`,
      params(cs, to, from, { RecordingSid: recordingSid, RecordingDuration: seconds, RecordingUrl: `https://api.twilio.com/x/${recordingSid}` }),
    ),
  )
  expect(res.status).toBe(200)
  await drain()
}

async function present(userId: string, orgId: string) {
  await db.voicePresence.upsert({
    where: { userId_organizationId: { userId, organizationId: orgId } },
    create: { userId, organizationId: orgId, identity: `pf_${orgId}_${userId}`, state: 'ready', lastSeenAt: new Date() },
    update: { state: 'ready', lastSeenAt: new Date() },
  })
}

beforeAll(async () => {
  A = await makeOrg(run, 'A')
  B = await makeOrg(run, 'B')
  stubTelephonyEnv(A.orgId)
  owner = await makeUser(A.orgId, run, 'Owner', 'SUPER_ADMIN')
  repA = await makeUser(A.orgId, run, 'Rep A', 'CLOSER')
  repB = await makeUser(A.orgId, run, 'Rep B', 'CLOSER')
  mate1 = await makeUser(A.orgId, run, 'Mate One', 'CLOSER', { phone: MATE1 })
  mate2 = await makeUser(A.orgId, run, 'Mate Two', 'CLOSER', { phone: MATE2 })
  await makeUser(B.orgId, run, 'B Rep', 'CLOSER')
  await makeLine(A.orgId, FORWARD_LINE, { routing: 'FORWARD', forwardTo: FORWARD_TO, friendlyName: 'Forward line' })
  await makeLine(A.orgId, TEAM_LINE, { routing: 'TEAM', teamUserIds: [mate1.id, mate2.id], isPrimary: false, friendlyName: 'Team line' })
  await makeLine(A.orgId, VM_LINE, { routing: 'VOICEMAIL_ONLY', isPrimary: false, friendlyName: 'Voicemail line', recordCalls: true })
  await makeLine(B.orgId, B_LINE, { routing: 'FORWARD', forwardTo: FORWARD_TO, friendlyName: 'B line' })
  await db.client.create({
    data: {
      organizationId: A.orgId,
      pipelineId: A.pipelineId,
      currentStageId: A.fulfillmentStageId,
      firstName: 'Casey',
      lastName: 'Client',
      email: `casey.${run}@example.test`,
      phone: CLIENT_PHONE,
      ownerId: repA.id,
    },
  })
})

beforeEach(async () => {
  afterQueue.length = 0
  stubTelephonyEnv(A.orgId)
  await db.voicePresence.deleteMany({ where: { organizationId: { in: [A.orgId, B.orgId] } } })
  await db.telephonyAccountState.deleteMany({ where: { accountSid: ACCOUNT } })
  await db.voiceCall.updateMany({ where: { accountSid: ACCOUNT, status: { in: ['initiated', 'ringing', 'in-progress'] } }, data: { status: 'completed' } })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.telephonyAccountState.deleteMany({ where: { accountSid: ACCOUNT } })
  await db.organization.deleteMany({ where: { id: { in: [A.orgId, B.orgId] } } })
})

describe('the browser stage (P0b, flag on)', () => {
  it('rings present browsers first; the answer records who picked up; a 45 s talk is a first contact', async () => {
    vi.stubEnv('VOICE_BROWSER_ENABLED', 'true')
    await present(repA.id, A.orgId)
    await present(repB.id, A.orgId)
    const cs = callSid()
    const twiml = await ring(cs, FORWARD_LINE, CLIENT_PHONE)
    expect(twiml).toContain(`<Identity>pf_${A.orgId}_${repA.id}</Identity>`)
    expect(twiml).toContain(`<Identity>pf_${A.orgId}_${repB.id}</Identity>`)
    // The client's owner rings first, and the banner gets the client's name.
    expect(twiml.indexOf(repA.id)).toBeLessThan(twiml.indexOf(repB.id))
    expect(twiml).toContain('<Parameter name="pfCaller" value="Casey Client"/>')
    expect(twiml).toContain('stage=browser')
    await drain()

    await voiceStatus(
      signedPost(
        `/api/telephony/voice/status?callSid=${cs}&leg=child&stage=browser`,
        params(sid('CA', run, 'child'), `client:pf_${A.orgId}_${repB.id}`, CLIENT_PHONE, { CallStatus: 'in-progress', ParentCallSid: cs }),
      ),
    )
    expect(await dial(cs, FORWARD_LINE, CLIENT_PHONE, 'browser', 0, 'completed', '45')).not.toContain('<Dial')
    await parentStatus(cs, FORWARD_LINE, CLIENT_PHONE, 'completed', '50')

    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc).toMatchObject({ outcome: 'CONNECTED', answeredBy: `browser:${repB.id}`, userId: repB.id, talkSeconds: 45, needsAction: false })
    const client = await db.client.findFirstOrThrow({ where: { organizationId: A.orgId, phone: CLIENT_PHONE } })
    expect(client.firstContactAt).not.toBeNull()
    const call = await db.call.findFirstOrThrow({ where: { communication: { externalRef: cs } } })
    expect(call).toMatchObject({ outcome: 'CONNECTED', durationSeconds: 45 })
  })

  it('a user present in org A is never offered org B’s call', async () => {
    vi.stubEnv('VOICE_BROWSER_ENABLED', 'true')
    await present(repA.id, A.orgId)
    // repA also tries to look present in B: presence is per org, membership is re-checked.
    await present(repA.id, B.orgId)
    const twiml = await ring(callSid(), B_LINE, testNumber(run, 90))
    expect(twiml).not.toContain(repA.id)
    expect(twiml).not.toContain('<Client')
  })

  it('with the flag off there is no browser stage at all', async () => {
    vi.stubEnv('VOICE_BROWSER_ENABLED', '')
    await present(repA.id, A.orgId)
    const twiml = await ring(callSid(), FORWARD_LINE, testNumber(run, 91))
    expect(twiml).not.toContain('<Client')
    expect(twiml).toContain(`<Number`)
  })
})

describe('TEAM rings in turn, then voicemail', () => {
  it('teammate 1 → teammate 2 → voicemail; completed afterwards keeps VOICEMAIL (5a)', async () => {
    const cs = callSid()
    const from = testNumber(run, 20)
    const first = await ring(cs, TEAM_LINE, from)
    expect(first).toContain(`>${MATE1}</Number>`)
    expect(first).not.toContain(MATE2)
    expect(first).toContain('stage=team&amp;i=0')
    await drain()

    const second = await dial(cs, TEAM_LINE, from, 'team', 0, 'no-answer')
    expect(second).toContain(`>${MATE2}</Number>`)
    expect(second).not.toContain(MATE1)
    expect(second).toContain('i=1')

    const third = await dial(cs, TEAM_LINE, from, 'team', 1, 'no-answer')
    expect(third).toContain('<Record')
    expect(third).not.toContain('<Dial')

    await voicemail(cs, TEAM_LINE, from, sid('RE', run, 'team'))
    await parentStatus(cs, TEAM_LINE, from, 'completed', '40')
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc.outcome).toBe('VOICEMAIL')
    expect(vc.needsAction).toBe(true)
    expect(vc.recordingKind).toBe('voicemail')
  })

  it('a teammate who answers is recorded as the one who answered', async () => {
    const cs = callSid()
    const from = testNumber(run, 21)
    await ring(cs, TEAM_LINE, from)
    await drain()
    await dial(cs, TEAM_LINE, from, 'team', 0, 'no-answer')
    await dial(cs, TEAM_LINE, from, 'team', 1, 'completed', '33')
    await parentStatus(cs, TEAM_LINE, from, 'completed')
    expect(await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })).toMatchObject({ outcome: 'CONNECTED', answeredBy: `team:${mate2.id}` })
  })
})

describe('missed calls', () => {
  it('a caller who hangs up while it rings is a missed call, and it waits in the list', async () => {
    const cs = callSid()
    const from = testNumber(run, 30)
    await ring(cs, FORWARD_LINE, from)
    await drain()
    await parentStatus(cs, FORWARD_LINE, from, 'completed', '6')
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc).toMatchObject({ outcome: 'NO_ANSWER', needsAction: true, stage: 'hung-up' })
    const list = await listMissed(owner.actor)
    const row = list.find((m) => m.id === vc.id)
    expect(row).toMatchObject({ reason: 'hung-up', lineLabel: 'Forward line', target: { kind: 'missed', id: vc.id } })
    expect(row?.caller).toBe(`•••-•••-${from.slice(-4)}`)
    // A rep who neither answered nor holds the lead does not see it.
    expect((await listMissed(repB.actor)).some((m) => m.id === vc.id)).toBe(false)
  })
})

describe('unknown callers become leads (5c)', () => {
  it('keeps the voicemail on the VoiceCall and creates an INBOUND lead with inquiry consent', async () => {
    const cs = callSid()
    const from = testNumber(run, 40)
    await ring(cs, VM_LINE, from, { StirVerstat: 'TN-Validation-Passed-A' })
    await drain()
    await voicemail(cs, VM_LINE, from, sid('RE', run, 'unknown'), '21')
    await parentStatus(cs, VM_LINE, from, 'completed')

    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc.stirVerstat).toBe('TN-Validation-Passed-A')
    expect(vc.recordingSid).toBe(sid('RE', run, 'unknown'))
    expect(vc.remoteLast4).toBe(from.slice(-4))
    expect(vc.remoteHash).toMatch(/^[0-9a-f]{64}$/)
    const lead = await db.callCenterLead.findUniqueOrThrow({ where: { id: vc.callCenterLeadId! } })
    expect(lead).toMatchObject({ source: 'INBOUND', status: 'MISSED', consentSource: 'inbound_inquiry', phoneLast4: from.slice(-4) })
    expect(lead.phoneHash).toBe(vc.remoteHash)
    const events = await db.callCenterEvent.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: 'asc' } })
    expect(events.map((e) => e.type)).toEqual(['INBOUND', 'CALL'])
    expect(JSON.parse(events[1].body)).toMatchObject({ label: 'Voicemail', voiceCallId: vc.id })
    expect(events[1].voiceCallId).toBe(vc.id)
    const note = await db.notification.findFirst({ where: { organizationId: A.orgId, href: `/call-center?missed=${vc.id}` } })
    expect(note).not.toBeNull()
  })

  // sec-3: caller ID is spoofable, and a ring proves nothing.
  it('a caller ID the carrier did not vouch for gets a lead but no consent, even after a voicemail', async () => {
    const cs = callSid()
    const from = testNumber(run, 42)
    await ring(cs, VM_LINE, from, { StirVerstat: 'TN-Validation-Passed-C' })
    await drain()
    await voicemail(cs, VM_LINE, from, sid('RE', run, 'unattested'), '21')
    await parentStatus(cs, VM_LINE, from, 'completed')
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    const lead = await db.callCenterLead.findUniqueOrThrow({ where: { id: vc.callCenterLeadId! } })
    expect(lead).toMatchObject({ source: 'INBOUND', consentAt: null, consentSource: null })
  })

  it('a verified caller who hangs up during the greeting gets no consent', async () => {
    const cs = callSid()
    const from = testNumber(run, 43)
    await ring(cs, VM_LINE, from, { StirVerstat: 'TN-Validation-Passed-A' })
    await drain()
    // No consent while it rings…
    const ringing = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(await db.callCenterLead.findUniqueOrThrow({ where: { id: ringing.callCenterLeadId! } })).toMatchObject({ consentSource: null })
    // …nor after a one-second hang-up.
    await parentStatus(cs, VM_LINE, from, 'completed', '1')
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc).toMatchObject({ stage: 'hung-up', needsAction: true })
    expect(await db.callCenterLead.findUniqueOrThrow({ where: { id: vc.callCenterLeadId! } })).toMatchObject({ consentAt: null, consentSource: null })
  })

  it('a spoofed call from a number that already has a lead does not grant that lead consent', async () => {
    const from = testNumber(run, 44)
    const first = callSid()
    await ring(first, VM_LINE, from)
    await drain()
    await parentStatus(first, VM_LINE, from, 'completed', '2')
    const leadId = (await db.voiceCall.findUniqueOrThrow({ where: { callSid: first } })).callCenterLeadId!
    const second = callSid()
    await ring(second, VM_LINE, from, { StirVerstat: 'No-TN-Validation' })
    await drain()
    await voicemail(second, VM_LINE, from, sid('RE', run, 'spoofed'), '30')
    await parentStatus(second, VM_LINE, from, 'completed')
    expect((await db.voiceCall.findUniqueOrThrow({ where: { callSid: second } })).callCenterLeadId).toBe(leadId)
    expect(await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId } })).toMatchObject({ consentAt: null, consentSource: null })
  })

  it('reuses an existing Facebook lead with a 10-digit stored phone once its hash is backfilled', async () => {
    const tenDigits = testNumber(run, 41).slice(2) // "725…" — how older code stored it
    const lead = await db.callCenterLead.create({
      data: {
        organizationId: A.orgId,
        source: 'FORM',
        language: 'EN',
        status: 'WAITING',
        phoneLast4: tenDigits.slice(-4),
        phoneSecret: encryptSecret(tenDigits) as never,
        consentAt: new Date(),
        consentSource: 'lead_form',
        consentFormId: 'form1',
      },
    })
    expect((await backfillLeadPhoneHashes({ execute: true, organizationId: A.orgId })).hashed).toBeGreaterThan(0)
    const cs = callSid()
    await ring(cs, VM_LINE, `+1${tenDigits}`)
    await drain()
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc.callCenterLeadId).toBe(lead.id)
    // Form consent is never replaced by "they called us".
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: lead.id } })).consentSource).toBe('lead_form')
  })
})

describe('one call at a time (voice limited)', () => {
  it('rings exactly one browser while limited', async () => {
    vi.stubEnv('VOICE_BROWSER_ENABLED', 'true')
    await db.telephonyAccountState.create({ data: { accountSid: ACCOUNT, voiceLimitedMode: 'on' } })
    await present(repA.id, A.orgId)
    await present(repB.id, A.orgId)
    const twiml = await ring(callSid(), FORWARD_LINE, testNumber(run, 50))
    expect(twiml.match(/<Client/g)).toHaveLength(1)
  })

  it('goes straight to voicemail when another bridged call holds the leg, and writes the row inline', async () => {
    await db.telephonyAccountState.create({ data: { accountSid: ACCOUNT, voiceLimitedMode: 'on' } })
    await db.voiceCall.create({
      data: { organizationId: A.orgId, callSid: callSid(), accountSid: ACCOUNT, direction: 'OUTBOUND', status: 'in-progress', stage: 'bridged' },
    })
    const cs = callSid()
    const twiml = await ring(cs, FORWARD_LINE, testNumber(run, 51))
    expect(twiml).toContain('<Record')
    expect(twiml).not.toContain('<Dial')
    // Inline, before after(): the next caller's decision depends on it.
    expect(await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })).toMatchObject({ stage: 'voicemail' })
  })

  it('an inbound call that is only greeting or in voicemail does not count as a leg', async () => {
    await db.telephonyAccountState.create({ data: { accountSid: ACCOUNT, voiceLimitedMode: 'on' } })
    await db.voiceCall.create({
      data: { organizationId: A.orgId, callSid: callSid(), accountSid: ACCOUNT, direction: 'INBOUND', status: 'in-progress', stage: 'voicemail' },
    })
    const twiml = await ring(callSid(), FORWARD_LINE, testNumber(run, 52))
    expect(twiml).toContain(`>${FORWARD_TO}</Number>`)
  })
})

describe('recordings are stored by SID only', () => {
  it('a matched client’s voicemail links to the internal path, never Twilio’s URL', async () => {
    const cs = callSid()
    await ring(cs, VM_LINE, CLIENT_PHONE)
    await drain()
    await voicemail(cs, VM_LINE, CLIENT_PHONE, sid('RE', run, 'client'))
    await parentStatus(cs, VM_LINE, CLIENT_PHONE, 'completed')
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    const call = await db.call.findFirstOrThrow({ where: { communicationId: vc.communicationId! } })
    expect(call.recordingRef).toBe(`/api/voice/recordings/${vc.id}`)
    expect(call.voicemailLeft).toBe(true)
    expect(call.outcome).toBe('VOICEMAIL')
    const everything = JSON.stringify([vc, call])
    expect(everything).not.toContain('api.twilio.com')
  })
})
