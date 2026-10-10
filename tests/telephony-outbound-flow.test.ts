/**
 * Browser calls (P0b) through the TwiML App webhook and its callbacks
 * (docs/TELEPHONY_LIVE.md §2.3, §2.4, §2.7, §2.8). The server decides
 * everything: scope, caller ID, consent, hours (override token single-use),
 * and the one-call-at-a-time rule under the account lock. Signed with a TEST
 * token; the clock is pinned; nothing reaches Twilio.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const afterQueue = vi.hoisted(() => [] as (() => unknown)[])
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    afterQueue.push(fn)
  },
}))

import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { POST as clientVoice } from '@/app/api/telephony/client/voice/route'
import { POST as clientDial } from '@/app/api/telephony/client/dial/route'
import { POST as clientStatus } from '@/app/api/telephony/client/status/route'
import { POST as clientWhisper } from '@/app/api/telephony/client/whisper/route'
import { signOverride } from '@/lib/telephony/compliance-core'
import { NOT_YOUR_LINE, NO_CALLBACK_LINE } from '@/lib/telephony/lines'
import { LIMITED_BUSY } from '@/lib/telephony/outbound-voice'
import { ACCOUNT, makeLine, makeOrg, makeUser, sid, signedPost, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `tout-${Date.now().toString(36)}`
const APP_SID = `AP${'7'.repeat(32)}`
let n = 0
const callSid = () => sid('CA', run, n++)

// Wednesday 2026-10-07, 11:00 am Pacific; 8:40 pm Pacific the same day.
const NOON = new Date('2026-10-07T18:00:00.000Z')
const EVENING = new Date('2026-10-08T03:40:00.000Z')

async function drain() {
  while (afterQueue.length) await afterQueue.shift()!()
}

type User = Awaited<ReturnType<typeof makeUser>>
let orgId = ''
let manager: User
let rep: User
let rep2: User
let mainLine = ''
let rep2Line = ''
let vmLine = ''
let clientId = ''
let outOfScopeId = ''
let suppressedId = ''
let noConsentId = ''
let otherLeadId = ''
let myLeadId = ''

const CLIENT_PHONE = testNumber(run, 10)
const SUPPRESSED_PHONE = testNumber(run, 11)
const NO_CONSENT_PHONE = testNumber(run, 12)
const LEAD_PHONE = testNumber(run, 13)

function voiceReq(user: User, target: string, line: string, extra: Record<string, string> = {}) {
  return signedPost('/api/telephony/client/voice', {
    CallSid: extra.CallSid ?? callSid(),
    AccountSid: ACCOUNT,
    ApplicationSid: APP_SID,
    From: `client:pf_${orgId}_${user.id}`,
    To: '',
    target,
    line,
    ...extra,
  })
}

async function place(user: User, target: string, line: string, extra: Record<string, string> = {}) {
  const res = await clientVoice(voiceReq(user, target, line, extra))
  expect(res.status).toBe(200)
  return res.text()
}

async function client(name: string, phone: string, ownerId: string, opts: { consent?: boolean } = {}) {
  const row = await db.client.create({
    data: {
      organizationId: orgId,
      pipelineId: (await db.pipeline.findFirstOrThrow({ where: { organizationId: orgId } })).id,
      currentStageId: (await db.pipelineStage.findFirstOrThrow({ where: { pipeline: { organizationId: orgId }, category: 'INTAKE' } })).id,
      firstName: name,
      lastName: 'Test',
      email: `${name.toLowerCase()}.${run}@example.test`,
      phone,
      ownerId,
    },
  })
  if (opts.consent !== false) {
    await db.consent.create({
      data: { clientId: row.id, type: 'TCPA_CONTACT', granted: true, textVersion: 'v1', text: 'ok', purpose: 'test', grantedAt: new Date('2026-09-01T00:00:00Z') },
    })
  }
  return row.id
}

beforeAll(async () => {
  const org = await makeOrg(run)
  orgId = org.orgId
  stubTelephonyEnv(orgId)
  manager = await makeUser(orgId, run, 'Manager', 'SUPER_ADMIN')
  rep = await makeUser(orgId, run, 'Rep', 'CLOSER')
  rep2 = await makeUser(orgId, run, 'Rep Two', 'CLOSER')
  mainLine = (await makeLine(orgId, testNumber(run, 1), { routing: 'FORWARD', forwardTo: testNumber(run, 2), isPrimary: true })).id
  rep2Line = (await makeLine(orgId, testNumber(run, 3), { routing: 'FORWARD', forwardTo: testNumber(run, 4), isPrimary: false, assignedUserId: rep2.id, friendlyName: 'Rep Two line' })).id
  vmLine = (await makeLine(orgId, testNumber(run, 5), { routing: 'VOICEMAIL_ONLY', isPrimary: false, friendlyName: 'Voicemail only' })).id

  clientId = await client('Casey', CLIENT_PHONE, rep.id)
  outOfScopeId = await client('Other', testNumber(run, 14), rep2.id)
  suppressedId = await client('Sup', SUPPRESSED_PHONE, rep.id)
  noConsentId = await client('Nocon', NO_CONSENT_PHONE, rep.id, { consent: false })
  const { phoneHash } = await import('@/lib/telephony/compliance-core')
  await db.callCenterSuppression.create({
    data: { organizationId: orgId, numberHash: phoneHash(SUPPRESSED_PHONE), reason: 'test', last4: SUPPRESSED_PHONE.slice(-4), callBlockedAt: new Date(), callBlockedSource: 'manual' },
  })
  const lead = (lockedBy: string) =>
    db.callCenterLead.create({
      data: {
        organizationId: orgId,
        source: 'FORM',
        language: 'EN',
        status: 'WAITING',
        lockedBy,
        phoneLast4: LEAD_PHONE.slice(-4),
        phoneSecret: encryptSecret(LEAD_PHONE) as never,
        consentAt: new Date('2026-10-01T00:00:00Z'),
        consentSource: 'lead_form',
        consentFormId: 'f1',
      },
    })
  otherLeadId = (await lead(rep2.id)).id
  myLeadId = (await lead(rep.id)).id
})

beforeEach(async () => {
  afterQueue.length = 0
  stubTelephonyEnv(orgId, {
    VOICE_BROWSER_ENABLED: 'true',
    TWILIO_TWIML_APP_SID: APP_SID,
    TWILIO_API_KEY_SID: `SK${'1'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: 'test-only-key-secret',
  })
  vi.useFakeTimers({ toFake: ['Date'], now: NOON })
  await db.telephonyAccountState.deleteMany({ where: { accountSid: ACCOUNT } })
  await db.voiceCall.updateMany({ where: { accountSid: ACCOUNT, status: { in: ['initiated', 'ringing', 'in-progress'] } }, data: { status: 'completed' } })
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.telephonyAccountState.deleteMany({ where: { accountSid: ACCOUNT } })
  await db.organization.delete({ where: { id: orgId } })
})

describe('placing a call', () => {
  it('a client in scope: honest caller ID, the server’s number, a Communication + Call', async () => {
    const cs = callSid()
    const twiml = await place(rep, `client:${clientId}`, mainLine, { CallSid: cs })
    expect(twiml).toContain(`callerId="${testNumber(run, 1)}"`)
    expect(twiml).toContain(`>${CLIENT_PHONE}</Number>`)
    expect(twiml).toContain('/api/telephony/client/dial?vc=')
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc).toMatchObject({ direction: 'OUTBOUND', clientId, userId: rep.id, lineE164: testNumber(run, 1), purpose: 'marketing' })
    expect(vc.basis).toContain('Consent on file')
    const comm = await db.communication.findUniqueOrThrow({ where: { id: vc.communicationId! }, include: { call: true } })
    expect(comm).toMatchObject({ channel: 'CALL', direction: 'OUTBOUND', status: 'SENT', clientId })
    expect(comm.call?.toMasked).toContain(CLIENT_PHONE.slice(-4))
  })

  it('a replayed webhook returns the same TwiML and no second row', async () => {
    const cs = callSid()
    const first = await place(rep, `client:${clientId}`, mainLine, { CallSid: cs })
    const again = await place(rep, `client:${clientId}`, mainLine, { CallSid: cs })
    expect(again).toBe(first)
    expect(await db.voiceCall.count({ where: { callSid: cs } })).toBe(1)
  })

  it('refuses a client out of the rep’s scope', async () => {
    expect(await place(rep, `client:${outOfScopeId}`, mainLine)).toContain('That contact isn&apos;t in your list.')
  })

  it('refuses a lead another rep holds', async () => {
    expect(await place(rep, `lead:${otherLeadId}`, mainLine)).toContain('Another rep has this lead.')
  })

  it('refuses a number on the do-not-call list', async () => {
    expect(await place(rep, `client:${suppressedId}`, mainLine)).toContain('This number is on the do-not-call list.')
  })

  it('refuses with no consent on file', async () => {
    expect(await place(rep, `client:${noConsentId}`, mainLine)).toContain('No consent on file for this number.')
  })

  it('refuses a rep using another rep’s line, and a voicemail-only line as caller ID', async () => {
    expect(await place(rep, `client:${clientId}`, rep2Line)).toContain(NOT_YOUR_LINE.replace("'", '&apos;'))
    expect(await place(manager, `client:${clientId}`, vmLine)).toContain(NO_CALLBACK_LINE.replace("'", '&apos;'))
  })

  it('the browser never chooses the number: a forged "To" is ignored', async () => {
    const twiml = await place(rep, `client:${clientId}`, mainLine, { To: '+15005550006' })
    expect(twiml).not.toContain('+15005550006')
  })
})

describe('calling hours and the override', () => {
  it('a rep outside the window is refused in plain words', async () => {
    vi.setSystemTime(EVENING)
    expect(await place(rep, `client:${clientId}`, mainLine)).toContain('It&apos;s 8:40 pm for them.')
  })

  it('a manager with a valid override token gets through; the token can’t be reused', async () => {
    vi.setSystemTime(EVENING)
    const token = signOverride(
      { orgId, userId: manager.id, target: `client:${clientId}`, lineId: mainLine, code: 'OUTSIDE_HOURS' },
      EVENING,
    )!
    const cs = callSid()
    const twiml = await place(manager, `client:${clientId}`, mainLine, { CallSid: cs, override: token })
    expect(twiml).toContain('<Dial')
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc.overrideNonce).toMatch(/^[0-9a-f]{32}$/)
    expect(vc.basis).toContain('hours override')

    const reused = await place(manager, `client:${clientId}`, mainLine, { override: token })
    expect(reused).toContain('That override was already used.')
  })

  it('an override is ignored for a rep, and when it was minted for someone else', async () => {
    vi.setSystemTime(EVENING)
    const forManager = signOverride({ orgId, userId: manager.id, target: `client:${clientId}`, lineId: mainLine, code: 'OUTSIDE_HOURS' }, EVENING)!
    expect(await place(rep, `client:${clientId}`, mainLine, { override: forManager })).toContain('8:40 pm')
    const forRep = signOverride({ orgId, userId: rep.id, target: `client:${clientId}`, lineId: mainLine, code: 'OUTSIDE_HOURS' }, EVENING)!
    expect(await place(rep, `client:${clientId}`, mainLine, { override: forRep })).toContain('8:40 pm')
  })
})

describe('one call at a time', () => {
  beforeEach(async () => {
    await db.telephonyAccountState.create({ data: { accountSid: ACCOUNT, voiceLimitedMode: 'on' } })
  })

  it('refuses while another outbound call is up', async () => {
    await db.voiceCall.create({ data: { organizationId: orgId, callSid: callSid(), accountSid: ACCOUNT, direction: 'OUTBOUND', status: 'in-progress' } })
    expect(await place(rep, `client:${clientId}`, mainLine)).toContain(LIMITED_BUSY)
  })

  it('refuses while an inbound call is bridged', async () => {
    await db.voiceCall.create({
      data: { organizationId: orgId, callSid: callSid(), accountSid: ACCOUNT, direction: 'INBOUND', status: 'in-progress', stage: 'bridged' },
    })
    expect(await place(rep, `client:${clientId}`, mainLine)).toContain(LIMITED_BUSY)
  })

  it('two reps dialling at once: exactly one passes', async () => {
    const [a, b] = await Promise.all([
      clientVoice(voiceReq(rep, `client:${clientId}`, mainLine)).then((r) => r.text()),
      clientVoice(voiceReq(manager, `client:${clientId}`, mainLine)).then((r) => r.text()),
    ])
    const dialled = [a, b].filter((x) => x.includes('<Dial')).length
    const busy = [a, b].filter((x) => x.includes('one call at a time')).length
    expect(dialled).toBe(1)
    expect(busy).toBe(1)
  })
})

describe('after the call', () => {
  it('a 25 s connected call finalizes on the parent status and is a first contact', async () => {
    const cs = callSid()
    await place(rep, `client:${clientId}`, mainLine, { CallSid: cs })
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    const base = { CallSid: cs, AccountSid: ACCOUNT }
    expect((await clientStatus(signedPost(`/api/telephony/client/status?vc=${vc.id}`, { ...base, CallSid: sid('CA', run, 'kid'), CallStatus: 'in-progress' }))).status).toBe(204)
    const res = await clientDial(signedPost(`/api/telephony/client/dial?vc=${vc.id}`, { ...base, DialCallStatus: 'completed', DialCallDuration: '25' }))
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
    expect((await clientStatus(signedPost('/api/telephony/client/status?parent=1', { ...base, CallStatus: 'completed', CallDuration: '31' }))).status).toBe(204)
    await drain()
    const done = await db.voiceCall.findUniqueOrThrow({ where: { id: vc.id } })
    expect(done).toMatchObject({ status: 'completed', outcome: 'CONNECTED', talkSeconds: 25, durationSeconds: 31 })
    expect(done.endedAt).not.toBeNull()
    expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).firstContactAt).not.toBeNull()
    expect(await db.call.findFirstOrThrow({ where: { communicationId: done.communicationId! } })).toMatchObject({ outcome: 'CONNECTED', durationSeconds: 25 })
  })

  it('a lost dial result: the browser leg ending is NOT a connected call (5a, outbound)', async () => {
    const cs = callSid()
    await place(rep, `client:${clientId}`, mainLine, { CallSid: cs })
    await clientStatus(signedPost('/api/telephony/client/status?parent=1', { CallSid: cs, AccountSid: ACCOUNT, CallStatus: 'completed', CallDuration: '12' }))
    await drain()
    expect(await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })).toMatchObject({ status: 'completed', outcome: 'NO_ANSWER' })
  })

  it('10004 is explained out loud and starts the 24-hour limit', async () => {
    const cs = callSid()
    await place(rep, `client:${clientId}`, mainLine, { CallSid: cs })
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    const res = await clientDial(
      signedPost(`/api/telephony/client/dial?vc=${vc.id}`, { CallSid: cs, AccountSid: ACCOUNT, DialCallStatus: 'failed', ErrorCode: '10004' }),
    )
    expect(await res.text()).toContain('one call at a time')
    await drain()
    const state = await db.telephonyAccountState.findUniqueOrThrow({ where: { accountSid: ACCOUNT } })
    expect(state.voiceLimitedSeenAt).not.toBeNull()
  })

  it('the whisper says the notice and records that it was sent to the call', async () => {
    const cs = callSid()
    await place(rep, `client:${clientId}`, mainLine, { CallSid: cs })
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    const res = await clientWhisper(signedPost(`/api/telephony/client/whisper?vc=${vc.id}`, { CallSid: sid('CA', run, 'w'), AccountSid: ACCOUNT }))
    expect(await res.text()).toContain('This call may be recorded')
    expect((await db.voiceCall.findUniqueOrThrow({ where: { id: vc.id } })).disclosureServedAt).not.toBeNull()
  })

  it('a call to my own lead writes a real CALL event with the tries rule', async () => {
    const cs = callSid()
    await place(rep, `lead:${myLeadId}`, mainLine, { CallSid: cs })
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc.callCenterLeadId).toBe(myLeadId)
    await clientDial(signedPost(`/api/telephony/client/dial?vc=${vc.id}`, { CallSid: cs, AccountSid: ACCOUNT, DialCallStatus: 'no-answer' }))
    await clientStatus(signedPost('/api/telephony/client/status?parent=1', { CallSid: cs, AccountSid: ACCOUNT, CallStatus: 'completed', CallDuration: '20' }))
    await drain()
    const lead = await db.callCenterLead.findUniqueOrThrow({ where: { id: myLeadId } })
    expect(lead.tries).toBe(1)
    expect(lead.nextAttemptAt).not.toBeNull()
    const event = await db.callCenterEvent.findFirstOrThrow({ where: { leadId: myLeadId, type: 'CALL' } })
    expect(JSON.parse(event.body)).toMatchObject({ label: 'Call', detail: 'No answer', voiceCallId: vc.id })
  })
})

describe('with the flag off', () => {
  it('the TwiML App route says browser calling is off and places nothing', async () => {
    vi.stubEnv('VOICE_BROWSER_ENABLED', '')
    const cs = callSid()
    const twiml = await place(rep, `client:${clientId}`, mainLine, { CallSid: cs })
    expect(twiml).toContain('switched on yet')
    expect(await db.voiceCall.count({ where: { callSid: cs } })).toBe(0)
  })
})
