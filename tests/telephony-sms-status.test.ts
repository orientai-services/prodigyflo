/**
 * Honest texting (docs/TELEPHONY_LIVE.md §2.9, §2.10): delivery status only
 * moves forward and only on the carrier's word; 30034 is stored and labelled
 * as blocked; STOP / START / revocation words; the do-not-contact list and
 * calling hours on sends (with the reply window); per-org Messaging Service;
 * automation defers instead of failing. Nothing reaches Twilio.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/lib/db'
import { POST as inboundSms } from '@/app/api/telephony/sms/route'
import { POST as smsStatus } from '@/app/api/telephony/sms/status/route'
import { runDueWork } from '@/lib/automation/engine'
import { sendMessage } from '@/lib/messaging/send'
import { TwilioSmsProvider } from '@/lib/messaging/twilio'
import { smsStatusLabel } from '@/lib/telephony/carrier-errors'
import { phoneHash } from '@/lib/telephony/compliance-core'
import { blockNumber } from '@/lib/telephony/suppressions'
import { ACCOUNT, makeLine, makeOrg, makeUser, sid, signedPost, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `tsms-${Date.now().toString(36)}`
type User = Awaited<ReturnType<typeof makeUser>>
let orgId = ''
let pipelineId = ''
let intakeStageId = ''
let admin: User
const LINE = testNumber(run, 1)
let n = 0

// Wednesday 2026-10-07, 11:00 am Pacific / 9:30 pm Pacific.
const NOON = new Date('2026-10-07T18:00:00.000Z')
const NIGHT = new Date('2026-10-08T04:30:00.000Z')

async function makeClient(phone: string, consent = true) {
  const c = await db.client.create({
    data: {
      organizationId: orgId,
      pipelineId,
      currentStageId: intakeStageId,
      firstName: `Cli${n++}`,
      lastName: 'Ent',
      email: `c${n}.${run}@example.test`,
      phone,
      ownerId: admin.id,
    },
  })
  if (consent) {
    await db.consent.create({
      data: { clientId: c.id, type: 'TCPA_CONTACT', granted: true, textVersion: 'v1', text: 'ok', purpose: 't', grantedAt: new Date('2026-09-01T00:00:00Z') },
    })
  }
  return c
}

async function sentText(clientId: string, ref: string) {
  return db.communication.create({
    data: { clientId, channel: 'SMS', direction: 'OUTBOUND', status: 'SENT', body: 'hi', externalRef: ref, message: { create: { toMasked: '•••' } } },
    select: { id: true },
  })
}

function inbound(from: string, body: string) {
  return inboundSms(signedPost('/api/telephony/sms', { MessageSid: sid('SM', run, `in${n++}`), AccountSid: ACCOUNT, From: from, To: LINE, Body: body, NumMedia: '0' }))
}

beforeAll(async () => {
  const org = await makeOrg(run)
  orgId = org.orgId
  pipelineId = org.pipelineId
  intakeStageId = org.intakeStageId
  stubTelephonyEnv(orgId)
  admin = await makeUser(orgId, run, 'Admin', 'SUPER_ADMIN', { permissions: ['users:manage', 'communications:send', 'clients:read_all'] })
  await makeLine(orgId, LINE, { routing: 'FORWARD', forwardTo: testNumber(run, 2) })
})

beforeEach(() => stubTelephonyEnv(orgId))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.organization.delete({ where: { id: orgId } })
})

describe('delivery status', () => {
  it('delivered moves SENT → DELIVERED, and a later failure cannot move it back', async () => {
    const c = await makeClient(testNumber(run, 10))
    const ref = sid('SM', run, 'd1')
    const comm = await sentText(c.id, ref)
    const post = (status: string, code?: string) =>
      smsStatus(signedPost('/api/telephony/sms/status', { MessageSid: ref, MessageStatus: status, AccountSid: ACCOUNT, From: LINE, To: c.phone, ...(code ? { ErrorCode: code } : {}) }))
    expect((await post('sent')).status).toBe(204)
    let row = await db.communication.findUniqueOrThrow({ where: { id: comm.id }, include: { message: true } })
    expect(row.status).toBe('SENT')
    expect(row.message?.providerStatus).toBe('sent')
    expect(smsStatusLabel(row.status, row.message?.failureCode)).toBe('Accepted by carrier')
    await post('delivered')
    await post('failed', '30003')
    row = await db.communication.findUniqueOrThrow({ where: { id: comm.id }, include: { message: true } })
    expect(row.status).toBe('DELIVERED')
    expect(row.message?.deliveredAt).not.toBeNull()
  })

  it('30034 is stored and labelled honestly — never "Sent"', async () => {
    const c = await makeClient(testNumber(run, 11))
    const ref = sid('SM', run, 'a2p')
    const comm = await sentText(c.id, ref)
    await smsStatus(signedPost('/api/telephony/sms/status', { MessageSid: ref, MessageStatus: 'undelivered', ErrorCode: '30034', AccountSid: ACCOUNT, From: LINE, To: c.phone }))
    const row = await db.communication.findUniqueOrThrow({ where: { id: comm.id }, include: { message: true } })
    expect(row.status).toBe('FAILED')
    expect(row.message?.failureCode).toBe('30034: texting registration (A2P) pending')
    expect(smsStatusLabel(row.status, row.message?.failureCode)).toBe('Blocked: texting registration (A2P) pending')
  })
})

describe('STOP, START and revocation words', () => {
  it('STOP from a matched client blocks texts and voids lead form consent for that number', async () => {
    const phone = testNumber(run, 20)
    await makeClient(phone)
    const lead = await db.callCenterLead.create({
      data: { organizationId: orgId, source: 'FORM', language: 'EN', phoneHash: phoneHash(phone), consentAt: new Date(), consentSource: 'lead_form' },
    })
    expect((await inbound(phone, 'STOP')).status).toBe(200)
    const row = await db.callCenterSuppression.findUniqueOrThrow({ where: { organizationId_numberHash: { organizationId: orgId, numberHash: phoneHash(phone) } } })
    expect(row).toMatchObject({ smsBlockedSource: 'sms_stop', callBlockedAt: null, last4: phone.slice(-4) })
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: lead.id } })).consentRevokedAt).not.toBeNull()
  })

  it('STOP from an unknown number still blocks texts in the line’s organization (Spanish too)', async () => {
    const phone = testNumber(run, 21)
    await inbound(phone, 'Baja')
    const row = await db.callCenterSuppression.findUnique({ where: { organizationId_numberHash: { organizationId: orgId, numberHash: phoneHash(phone) } } })
    expect(row?.smsBlockedSource).toBe('sms_stop')
  })

  it('a number with a STOP and a "Do not call" keeps both; START lifts only the STOP', async () => {
    const phone = testNumber(run, 22)
    await blockNumber({ organizationId: orgId, numberHash: phoneHash(phone), last4: phone.slice(-4), call: 'call_center', reason: 'DNC' })
    await inbound(phone, 'STOP')
    let row = await db.callCenterSuppression.findUniqueOrThrow({ where: { organizationId_numberHash: { organizationId: orgId, numberHash: phoneHash(phone) } } })
    expect(row).toMatchObject({ smsBlockedSource: 'sms_stop', callBlockedSource: 'call_center' })
    await inbound(phone, 'START')
    row = await db.callCenterSuppression.findUniqueOrThrow({ where: { id: row.id } })
    expect(row.smsBlockedAt).toBeNull()
    expect(row.callBlockedSource).toBe('call_center')
    expect(row.removedAt).toBeNull()
  })

  it('START after a STOP-only block leaves no block at all (not a legacy "block both")', async () => {
    const phone = testNumber(run, 23)
    await inbound(phone, 'STOP')
    await inbound(phone, 'unstop')
    const row = await db.callCenterSuppression.findUniqueOrThrow({ where: { organizationId_numberHash: { organizationId: orgId, numberHash: phoneHash(phone) } } })
    expect(row.smsBlockedAt).toBeNull()
    expect(row.removedAt).not.toBeNull()
  })

  it('"please stop texting me" holds texts for review and tells the admins', async () => {
    const phone = testNumber(run, 24)
    await inbound(phone, 'please stop texting me')
    const row = await db.callCenterSuppression.findUniqueOrThrow({ where: { organizationId_numberHash: { organizationId: orgId, numberHash: phoneHash(phone) } } })
    expect(row.smsBlockedSource).toBe('sms_stop_review')
    const note = await db.notification.findFirst({ where: { organizationId: orgId, title: 'Possible opt-out' }, orderBy: { createdAt: 'desc' } })
    expect(note?.body).toContain("Possible opt-out: 'please stop texting me'. Confirm or lift.")
  })

  it('a STOP never counts as an inquiry; a normal text from an inquiry lead refreshes it', async () => {
    const phone = testNumber(run, 25)
    const old = new Date('2026-09-01T00:00:00Z')
    const lead = await db.callCenterLead.create({
      data: { organizationId: orgId, source: 'INBOUND', language: 'EN', phoneHash: phoneHash(phone), consentAt: old, consentSource: 'inbound_inquiry' },
    })
    await inbound(phone, 'hello, still interested')
    const refreshed = await db.callCenterLead.findUniqueOrThrow({ where: { id: lead.id } })
    expect(refreshed.consentAt!.getTime()).toBeGreaterThan(old.getTime())
    await inbound(phone, 'STOP')
    const after = await db.callCenterLead.findUniqueOrThrow({ where: { id: lead.id } })
    expect(after.consentRevokedAt).not.toBeNull()
    expect(after.consentAt!.getTime()).toBe(refreshed.consentAt!.getTime())
  })

  it('a picture with no words is kept as "[Media message]"', async () => {
    const phone = testNumber(run, 26)
    const c = await makeClient(phone)
    await inboundSms(signedPost('/api/telephony/sms', { MessageSid: sid('SM', run, 'mms'), AccountSid: ACCOUNT, From: phone, To: LINE, Body: '', NumMedia: '1' }))
    const comm = await db.communication.findFirstOrThrow({ where: { clientId: c.id, direction: 'INBOUND' } })
    expect(comm.body).toBe('[Media message]')
  })
})

describe('sending a text', () => {
  it('refuses a number on the list for texts', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON })
    const phone = testNumber(run, 30)
    const c = await makeClient(phone)
    await blockNumber({ organizationId: orgId, numberHash: phoneHash(phone), last4: phone.slice(-4), sms: 'manual', reason: 'asked' })
    const out = await sendMessage(admin.actor, { clientId: c.id, channel: 'SMS', body: 'hi' })
    expect(out).toMatchObject({ ok: false, code: 'SUPPRESSED' })
    expect(await db.communication.count({ where: { clientId: c.id } })).toBe(0)
  })

  it('refuses outside their hours, with when it can go', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NIGHT })
    const c = await makeClient(testNumber(run, 31))
    const out = await sendMessage(admin.actor, { clientId: c.id, channel: 'SMS', body: 'hi' })
    expect(out).toMatchObject({ ok: false, code: 'OUTSIDE_HOURS' })
    if (!out.ok) {
      expect(out.error).toBe("It's 9:30 pm for them. Texts can go out after 8:00 am their time.")
      expect(out.retryAt).toBe('2026-10-08T15:00:00.000Z')
    }
  })

  it('allows a reply within 30 minutes of their text, even at night', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NIGHT })
    const phone = testNumber(run, 32)
    const c = await makeClient(phone)
    await db.communication.create({
      data: { clientId: c.id, channel: 'SMS', direction: 'INBOUND', status: 'RECEIVED', body: 'are you there?', occurredAt: new Date(NIGHT.getTime() - 10 * 60_000) },
    })
    const out = await sendMessage(admin.actor, { clientId: c.id, channel: 'SMS', body: 'yes' })
    expect(out).toMatchObject({ ok: true, status: 'SENT' })
  })

  it('fails closed without PHONE_HASH_KEY', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON })
    vi.stubEnv('PHONE_HASH_KEY', '')
    const c = await makeClient(testNumber(run, 33))
    expect(await sendMessage(admin.actor, { clientId: c.id, channel: 'SMS', body: 'hi' })).toMatchObject({ ok: false, code: 'CHECK_FAILED' })
  })

  it('sends with the org’s own Messaging Service AND its own From', async () => {
    await db.organization.update({
      where: { id: orgId },
      data: { settings: { telephony: { messagingServiceSid: `MG${'3'.repeat(32)}` } } },
    })
    let body: URLSearchParams | null = null
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (!String(url).startsWith('https://api.twilio.com/')) throw new Error('unexpected network call')
      body = new URLSearchParams(init.body as string)
      return new Response(JSON.stringify({ sid: sid('SM', run, 'mg'), status: 'queued' }), { status: 201 })
    })
    const out = await new TwilioSmsProvider().send({ to: testNumber(run, 34), body: 'hi', organizationId: orgId })
    expect(out.status).toBe('SENT')
    expect(body!.get('MessagingServiceSid')).toBe(`MG${'3'.repeat(32)}`)
    expect(body!.get('From')).toBe(LINE)
    expect(body!.get('StatusCallback')).toBe('https://www.prodigyflo.ai/api/telephony/sms/status')
    await db.organization.update({ where: { id: orgId }, data: { settings: {} } })
  })
})

describe('automation', () => {
  it('a scheduled text outside their hours waits for the morning; no attempt is counted', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NIGHT })
    const c = await makeClient(testNumber(run, 40))
    const sm = await db.scheduledMessage.create({
      data: { organizationId: orgId, clientId: c.id, userId: admin.id, channel: 'SMS', body: 'reminder', sendAt: new Date(NIGHT.getTime() - 60_000) },
    })
    const result = await runDueWork(NIGHT, { organizationId: orgId })
    expect(result.scheduled.deferred).toBe(1)
    const row = await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })
    expect(row).toMatchObject({ status: 'PENDING', attempts: 0 })
    expect(row.sendAt.toISOString()).toBe('2026-10-08T15:00:00.000Z')
  })
})
