/**
 * Dialer power-up, Lane C (docs/DIALER_POWER.md) through the real route
 * handlers and the local test database: press 1 for a callback, voicemail
 * transcription, missed-call dispositions and same-caller clearing, the
 * automatic clear on an answered call back, the nav count, and speed-to-lead.
 * Signed with a TEST token; nothing reaches Twilio.
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
import { POST as voice } from '@/app/api/telephony/voice/route'
import { POST as voiceDial } from '@/app/api/telephony/voice/dial/route'
import { POST as voiceCallback } from '@/app/api/telephony/voice/callback/route'
import { POST as voiceRecording } from '@/app/api/telephony/voice/recording/route'
import { POST as voiceStatus } from '@/app/api/telephony/voice/status/route'
import { POST as voiceTranscription } from '@/app/api/telephony/voice/transcription/route'
import { saveTelephonySettings } from '@/lib/telephony/settings'
import { runSpeedToLead } from '@/lib/telephony/speed-to-lead'
import { finalizeCall, listMissed, markHandled, pendingMissedCount, remoteParty } from '@/lib/telephony/voice-calls'
import { ACCOUNT, makeLine, makeOrg, makeUser, sid, signedPost, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `tdp-${Date.now().toString(36)}`
let n = 0
const callSid = () => sid('CA', run, n++)

async function drain() {
  while (afterQueue.length) await afterQueue.shift()!()
}

type Org = Awaited<ReturnType<typeof makeOrg>>
type User = Awaited<ReturnType<typeof makeUser>>
let A: Org
let owner: User
let rep: User
let idleRep: User

const FORWARD_LINE = testNumber(run, 1)
const VM_LINE = testNumber(run, 2)
const FORWARD_TO = testNumber(run, 3)

const params = (cs: string, to: string, from: string, extra: Record<string, string> = {}) => ({
  CallSid: cs,
  AccountSid: ACCOUNT,
  From: from,
  To: to,
  CallStatus: 'ringing',
  ...extra,
})

const xml = { 'Content-Type': 'text/xml; charset=utf-8' }

async function ring(cs: string, to: string, from: string) {
  const res = await voice(signedPost('/api/telephony/voice', params(cs, to, from)))
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe(xml['Content-Type'])
  return res.text()
}

async function dialNoAnswer(cs: string, to: string, from: string) {
  const res = await voiceDial(
    signedPost(`/api/telephony/voice/dial?callSid=${cs}&stage=forward&i=0`, params(cs, to, from, { DialCallStatus: 'no-answer', DialCallDuration: '0' })),
  )
  expect(res.status).toBe(200)
  return res.text()
}

async function press(cs: string, to: string, from: string, digits: string, token?: string | null) {
  return voiceCallback(signedPost(`/api/telephony/voice/callback?callSid=${cs}`, params(cs, to, from, { Digits: digits, CallStatus: 'in-progress' }), token))
}

async function hangUp(cs: string, to: string, from: string) {
  const res = await voiceStatus(signedPost('/api/telephony/voice/status', params(cs, to, from, { CallStatus: 'completed', CallDuration: '40' })))
  expect(res.status).toBe(204)
  await drain()
}

async function leaveVoicemail(cs: string, to: string, from: string, recordingSid: string) {
  const res = await voiceRecording(
    signedPost(
      `/api/telephony/voice/recording?callSid=${cs}&kind=voicemail`,
      params(cs, to, from, { RecordingSid: recordingSid, RecordingDuration: '12', RecordingStatus: 'completed' }),
    ),
  )
  expect(res.status).toBe(200)
  await drain()
}

function transcribe(cs: string, to: string, from: string, extra: Record<string, string>, token?: string | null) {
  return voiceTranscription(
    signedPost(`/api/telephony/voice/transcription?callSid=${cs}`, params(cs, to, from, { TranscriptionStatus: 'completed', ...extra }), token),
  )
}

/** An unanswered inbound call written straight into the ledger. */
async function missedRow(from: string, startedAt: Date, extra: Record<string, unknown> = {}) {
  return db.voiceCall.create({
    data: {
      organizationId: A.orgId,
      callSid: callSid(),
      accountSid: ACCOUNT,
      direction: 'INBOUND',
      status: 'completed',
      outcome: 'NO_ANSWER',
      stage: 'hung-up',
      needsAction: true,
      startedAt,
      endedAt: startedAt,
      ...remoteParty(from),
      ...extra,
    },
  })
}

beforeAll(async () => {
  A = await makeOrg(run, 'A')
  stubTelephonyEnv(A.orgId)
  owner = await makeUser(A.orgId, run, 'Owner', 'SUPER_ADMIN')
  rep = await makeUser(A.orgId, run, 'Rep', 'CLOSER')
  idleRep = await makeUser(A.orgId, run, 'Idle Rep', 'CLOSER')
  await makeLine(A.orgId, FORWARD_LINE, { routing: 'FORWARD', forwardTo: FORWARD_TO, friendlyName: 'Forward line' })
  await makeLine(A.orgId, VM_LINE, { routing: 'VOICEMAIL_ONLY', isPrimary: false, friendlyName: 'Voicemail line', recordCalls: true })
})

beforeEach(async () => {
  afterQueue.length = 0
  stubTelephonyEnv(A.orgId)
  await db.voiceCall.updateMany({ where: { organizationId: A.orgId, needsAction: true }, data: { needsAction: false, handledAt: new Date() } })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.telephonyAccountState.deleteMany({ where: { accountSid: ACCOUNT } })
  await db.organization.deleteMany({ where: { id: A.orgId } })
})

describe('press 1 for a callback', () => {
  it('is offered after the ring stage fails, never on a VOICEMAIL_ONLY first answer', async () => {
    const from = testNumber(run, 10)
    const cs = callSid()
    const first = await ring(cs, FORWARD_LINE, from)
    expect(first).not.toContain('<Gather')
    const after = await dialNoAnswer(cs, FORWARD_LINE, from)
    expect(after).toContain('<Gather input="dtmf" numDigits="1" timeout="5"')
    expect(after).toContain(`/api/telephony/voice/callback?callSid=${cs}`)
    // Silence falls through to the voicemail in the same answer.
    expect(after.indexOf('<Record')).toBeGreaterThan(after.indexOf('</Gather>'))

    const vm = await ring(callSid(), VM_LINE, testNumber(run, 11))
    expect(vm).not.toContain('<Gather')
    expect(vm).toContain('<Record')
  })

  it('1 → callback requested, confirmed, hung up; sorted first on Missed; the trail says so', async () => {
    const early = await missedRow(testNumber(run, 12), new Date(Date.now() - 60_000))
    const from = testNumber(run, 13)
    const cs = callSid()
    await ring(cs, FORWARD_LINE, from)
    await drain()
    await dialNoAnswer(cs, FORWARD_LINE, from)
    const res = await press(cs, FORWARD_LINE, from, '1')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('We will call you back')
    expect(body).toContain('<Hangup/>')
    expect(body).not.toContain('<Record')
    // A replayed Gather changes nothing.
    expect((await press(cs, FORWARD_LINE, from, '1')).status).toBe(200)
    await hangUp(cs, FORWARD_LINE, from)

    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc).toMatchObject({ callbackRequested: true, needsAction: true, handledAt: null, stage: 'callback', outcome: 'NO_ANSWER' })

    const missed = await listMissed(owner.actor)
    expect(missed[0]).toMatchObject({ id: vc.id, callbackRequested: true })
    expect(missed.findIndex((m) => m.id === early.id)).toBeGreaterThan(0)

    const trail = await db.callCenterEvent.findFirstOrThrow({ where: { voiceCallId: vc.id, type: 'CALL' } })
    expect(trail.body).toContain('Asked for a callback')
  })

  it('any other key goes to voicemail exactly as if they waited', async () => {
    const from = testNumber(run, 14)
    const cs = callSid()
    await ring(cs, FORWARD_LINE, from)
    await drain()
    await dialNoAnswer(cs, FORWARD_LINE, from)
    const res = await press(cs, FORWARD_LINE, from, '2')
    const body = await res.text()
    expect(body).toContain('<Record')
    expect(body).toContain(`/api/telephony/voice/recording?callSid=${cs}&amp;kind=voicemail`)
    expect(body).not.toContain('<Gather')
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc.callbackRequested).toBe(false)
  })

  it('refuses an unsigned or wrongly signed key press with a bare 403', async () => {
    const from = testNumber(run, 15)
    const cs = callSid()
    await ring(cs, FORWARD_LINE, from)
    await drain()
    const unsigned = await press(cs, FORWARD_LINE, from, '1', null)
    expect(unsigned.status).toBe(403)
    expect(await unsigned.text()).toBe('')
    const forged = await press(cs, FORWARD_LINE, from, '1', 'not-the-token')
    expect(forged.status).toBe(403)
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc.callbackRequested).toBe(false)
  })
})

describe('voicemail transcription', () => {
  it('is on by default, stored once, shown on Missed; off when the account turns it off', async () => {
    const from = testNumber(run, 20)
    const cs = callSid()
    const answer = await ring(cs, VM_LINE, from)
    expect(answer).toContain('transcribe="true"')
    expect(answer).toContain(`transcribeCallback="https://www.prodigyflo.ai/api/telephony/voice/transcription?callSid=${cs}"`)
    await drain()
    const rec = sid('RE', run, 'vm1')
    await leaveVoicemail(cs, VM_LINE, from, rec)

    const bad = await transcribe(cs, VM_LINE, from, { TranscriptionText: 'forged', RecordingSid: rec }, null)
    expect(bad.status).toBe(403)

    const ok = await transcribe(cs, VM_LINE, from, { TranscriptionText: '  Hi,   this is Dana.\n Please call me back. ', RecordingSid: rec })
    expect(ok.status).toBe(204)
    // A replay, or a different text for the same call, never replaces the first.
    await transcribe(cs, VM_LINE, from, { TranscriptionText: 'Something else', RecordingSid: rec })
    // A transcription of some other recording is ignored.
    await transcribe(cs, VM_LINE, from, { TranscriptionText: 'Other', RecordingSid: sid('RE', run, 'other') })
    await hangUp(cs, VM_LINE, from)

    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc.transcript).toBe('Hi, this is Dana. Please call me back.')
    const row = (await listMissed(owner.actor)).find((m) => m.id === vc.id)
    expect(row).toMatchObject({ reason: 'voicemail', transcript: 'Hi, this is Dana. Please call me back.' })

    await saveTelephonySettings(A.orgId, { transcribeVoicemail: false })
    try {
      const off = await ring(callSid(), VM_LINE, testNumber(run, 21))
      expect(off).toContain('transcribe="false"')
      expect(off).not.toContain('transcribeCallback')
    } finally {
      await saveTelephonySettings(A.orgId, { transcribeVoicemail: true })
    }
  })

  it('a failed transcription stores nothing', async () => {
    const from = testNumber(run, 22)
    const cs = callSid()
    await ring(cs, VM_LINE, from)
    await drain()
    await leaveVoicemail(cs, VM_LINE, from, sid('RE', run, 'vm2'))
    const res = await transcribe(cs, VM_LINE, from, { TranscriptionStatus: 'failed', TranscriptionText: '' })
    expect(res.status).toBe(204)
    expect((await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })).transcript).toBeNull()
  })
})

describe('missed-call dispositions', () => {
  it('closes the call and every earlier one from the same number, never a later one or another caller', async () => {
    const caller = testNumber(run, 30)
    const t0 = Date.now() - 3 * 60 * 60_000
    const first = await missedRow(caller, new Date(t0))
    const second = await missedRow(caller, new Date(t0 + 60 * 60_000))
    const later = await missedRow(caller, new Date(t0 + 2 * 60 * 60_000))
    const stranger = await missedRow(testNumber(run, 31), new Date(t0))

    expect(await pendingMissedCount(owner.actor)).toBe(4)
    const res = await markHandled(owner.actor, second.id, { disposition: 'spam', note: ' robocall ' })
    expect(res).toEqual({ ok: true, cleared: 1 })

    const rows = await db.voiceCall.findMany({ where: { id: { in: [first.id, second.id, later.id, stranger.id] } } })
    const by = new Map(rows.map((r) => [r.id, r]))
    expect(by.get(second.id)).toMatchObject({ handledDisposition: 'spam', handledNote: 'robocall', needsAction: false, handledById: owner.id })
    expect(by.get(first.id)).toMatchObject({ handledDisposition: 'spam', needsAction: false })
    expect(by.get(later.id)).toMatchObject({ needsAction: true, handledAt: null })
    expect(by.get(stranger.id)).toMatchObject({ needsAction: true, handledAt: null })
    expect(await pendingMissedCount(owner.actor)).toBe(2)
  })

  it('defaults to handled, accepts the old note-only shape, refuses an unknown disposition', async () => {
    const a = await missedRow(testNumber(run, 32), new Date())
    expect(await markHandled(owner.actor, a.id, 'left a message')).toMatchObject({ ok: true })
    expect(await db.voiceCall.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ handledDisposition: 'handled', handledNote: 'left a message' })

    const b = await missedRow(testNumber(run, 33), new Date())
    const bad = await markHandled(owner.actor, b.id, { disposition: 'deleted' as never })
    expect(bad.ok).toBe(false)
    expect((await db.voiceCall.findUniqueOrThrow({ where: { id: b.id } })).needsAction).toBe(true)
  })

  it('a rep who cannot see the call cannot close it, and the nav count is theirs only', async () => {
    const hidden = await missedRow(testNumber(run, 34), new Date())
    expect(await pendingMissedCount(rep.actor)).toBe(0)
    expect(await markHandled(rep.actor, hidden.id, { disposition: 'handled' })).toMatchObject({ ok: false })
  })
})

describe('an answered call back clears the caller’s missed calls', () => {
  async function outbound(to: string, talkSeconds: number, outcome: 'CONNECTED' | 'NO_ANSWER' = 'CONNECTED') {
    return db.voiceCall.create({
      data: {
        organizationId: A.orgId,
        callSid: callSid(),
        accountSid: ACCOUNT,
        direction: 'OUTBOUND',
        status: 'completed',
        outcome,
        talkSeconds,
        userId: rep.id,
        startedAt: new Date(),
        endedAt: new Date(),
        ...remoteParty(to),
      },
    })
  }

  it('20 s or more → called_back; shorter, unanswered, or another number → nothing', async () => {
    const caller = testNumber(run, 40)
    const missed = await missedRow(caller, new Date(Date.now() - 30 * 60_000))
    const other = await missedRow(testNumber(run, 41), new Date(Date.now() - 30 * 60_000))

    await finalizeCall((await outbound(caller, 19)).id)
    await finalizeCall((await outbound(caller, 60, 'NO_ANSWER')).id)
    expect((await db.voiceCall.findUniqueOrThrow({ where: { id: missed.id } })).needsAction).toBe(true)

    const good = await outbound(caller, 20)
    await finalizeCall(good.id)
    await finalizeCall(good.id) // idempotent
    expect(await db.voiceCall.findUniqueOrThrow({ where: { id: missed.id } })).toMatchObject({
      needsAction: false,
      handledDisposition: 'called_back',
      handledNote: 'called back',
      handledById: rep.id,
    })
    expect((await db.voiceCall.findUniqueOrThrow({ where: { id: other.id } })).needsAction).toBe(true)
  })
})

describe('speed-to-lead', () => {
  // 2026-10-09 10:00 PDT, inside the 9–20 clock.
  const pt = (hhmm: string, day = 9) => new Date(`2026-10-${String(day).padStart(2, '0')}T${hhmm}:00-07:00`)

  async function formLead(createdAt: Date, extra: Record<string, unknown> = {}) {
    return db.callCenterLead.create({
      data: { organizationId: A.orgId, source: 'FORM', language: 'EN', status: 'WAITING', phoneLast4: '4321', createdAt, ...extra },
    })
  }

  async function present(userId: string) {
    await db.voicePresence.upsert({
      where: { userId_organizationId: { userId, organizationId: A.orgId } },
      create: { userId, organizationId: A.orgId, identity: `pf_${A.orgId}_${userId}`, state: 'ready', lastSeenAt: pt('10:00') },
      update: { state: 'ready', lastSeenAt: pt('10:00') },
    })
  }

  const notes = (leadId: string) => db.notification.findMany({ where: { organizationId: A.orgId, href: `/call-center?lead=${leadId}` } })

  beforeEach(async () => {
    await db.callCenterLead.deleteMany({ where: { organizationId: A.orgId, source: 'FORM' } })
    await db.voicePresence.deleteMany({ where: { organizationId: A.orgId } })
  })

  it('alerts present reps and managers at 5 min, super admins at 15, each once', async () => {
    await present(rep.id)
    const lead = await formLead(pt('09:50'))

    expect(await runSpeedToLead(pt('09:54'), { organizationId: A.orgId })).toMatchObject({ alerted: 0, escalated: 0 })
    expect(await notes(lead.id)).toHaveLength(0)

    const first = await runSpeedToLead(pt('09:55'), { organizationId: A.orgId })
    expect(first).toMatchObject({ alerted: 1, escalated: 0 })
    const fiveMin = await notes(lead.id)
    // The present rep and the super admin (telephony:manage); not the idle rep.
    expect(new Set(fiveMin.map((n) => n.userId))).toEqual(new Set([rep.id, owner.id]))
    expect(fiveMin[0]).toMatchObject({ kind: 'SLA_WARNING' })
    expect(fiveMin[0].body).toContain('•••-•••-4321')
    expect(fiveMin.some((n) => n.userId === idleRep.id)).toBe(false)

    expect(await runSpeedToLead(pt('09:58'), { organizationId: A.orgId })).toMatchObject({ alerted: 0, escalated: 0 })
    const esc = await runSpeedToLead(pt('10:05'), { organizationId: A.orgId })
    expect(esc).toMatchObject({ alerted: 0, escalated: 1 })
    expect(await runSpeedToLead(pt('10:10'), { organizationId: A.orgId })).toMatchObject({ alerted: 0, escalated: 0 })
    const all = await notes(lead.id)
    expect(all).toHaveLength(3)
    expect(all.filter((n) => n.title.includes('15')).map((n) => n.userId)).toEqual([owner.id])
    const row = await db.callCenterLead.findUniqueOrThrow({ where: { id: lead.id } })
    expect(row.speedAlertedAt).toEqual(pt('09:55'))
    expect(row.speedEscalatedAt).toEqual(pt('10:05'))
  })

  it('an overnight lead waits for 9:00; nobody is paged at night', async () => {
    const lead = await formLead(pt('23:10', 8))
    expect(await runSpeedToLead(pt('23:40', 8), { organizationId: A.orgId })).toMatchObject({ checked: 0, alerted: 0 })
    expect(await runSpeedToLead(pt('09:04'), { organizationId: A.orgId })).toMatchObject({ alerted: 0 })
    expect(await runSpeedToLead(pt('09:05'), { organizationId: A.orgId })).toMatchObject({ alerted: 1 })
    expect(await notes(lead.id)).toHaveLength(1) // the super admin; no rep is present
  })

  it('a lead someone touched (a try, a call or outcome on the trail, DNC, inbound) never alerts', async () => {
    await formLead(pt('09:00'), { tries: 1 })
    await formLead(pt('09:00'), { doNotCallAt: pt('09:01') })
    await formLead(pt('09:00'), { events: { create: { type: 'OUTCOME', body: '{}', createdAt: pt('09:02') } } })
    await formLead(pt('09:00'), { events: { create: { type: 'CALL', body: '{}', createdAt: pt('09:02') } } })
    await db.callCenterLead.create({ data: { organizationId: A.orgId, source: 'INBOUND', language: 'EN', status: 'INBOUND', createdAt: pt('09:00') } })
    const res = await runSpeedToLead(pt('10:00'), { organizationId: A.orgId })
    expect(res).toMatchObject({ checked: 0, alerted: 0, escalated: 0 })
  })
})
