/**
 * Regression tests for the telephony live review (feat/telephony-live):
 *
 *  sec-1   a tenant can't claim the shared platform account by typing its
 *          Account SID into its own connector vault
 *  sec-2   a text's From is always one of the org's own lines on the sending
 *          account — never a vault number next to platform credentials, never
 *          a shared env number
 *  stop    an opt-out sent to a number we have no line for still reaches a person
 *  window  automation never uses the 30-minute reply window
 *  review  confirming a held opt-out revokes the client's TCPA consent
 *  race    two finalizes of one call write one trail line and count one try
 *  zone    a client's time zone can be set when address and number don't say
 *  assign  a platform number can't go to an org on its own Twilio, and a
 *          platform line's webhooks verify with the platform token
 *
 * Signed with TEST tokens; every fetch is stubbed; nothing reaches Twilio.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ actor: null as unknown }))
vi.mock('@/lib/rbac', async (orig) => ({
  ...(await orig<typeof import('@/lib/rbac')>()),
  requireUser: async () => state.actor,
  getSessionUser: async () => state.actor,
}))
const afterQueue = vi.hoisted(() => [] as (() => unknown)[])
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    afterQueue.push(fn)
  },
}))

import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { telephonyCredentialsDetailed } from '@/lib/telephony'
import { checkDial, reviewSmsOptOut, setContactTimeZone, setVoiceLimitedMode } from '@/lib/telephony/actions'
import { decideOutbound } from '@/lib/telephony/compliance'
import { phoneHash } from '@/lib/telephony/compliance-core'
import { credentialScope, guardAccountAction } from '@/lib/telephony/tenancy'
import { OWN_ACCOUNT_REFUSED, setNumberAssignment } from '@/lib/telephony/number-sync'
import { clearSmsStop } from '@/lib/telephony/suppressions'
import { finalizeCall } from '@/lib/telephony/voice-calls'
import { ZONE_WAIT_NOTE } from '@/lib/automation/engine'
import { CALL_RESULT_UNKNOWN } from '@/lib/call-center/desk'
import { FROM_NUMBER_NOT_SYNCED, TwilioSmsProvider, NO_TEXTING_LINE } from '@/lib/messaging/twilio'
import { accountSendingNumber } from '@/lib/messaging/sending-number'
import {
  CHECK_UNAVAILABLE,
  PAIR_REFUSED,
  PLATFORM_SID_REFUSED,
  checkTwilioConnectorSave,
  checkTwilioPair,
} from '@/lib/connectors/twilio-account-check'
import { POST as voice } from '@/app/api/telephony/voice/route'
import { POST as sms } from '@/app/api/telephony/sms/route'
import { ACCOUNT, OTHER_ACCOUNT, OTHER_TOKEN, TOKEN, makeLine, makeOrg, makeUser, sid, signedPost, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `trev-${Date.now().toString(36)}`
type Org = Awaited<ReturnType<typeof makeOrg>>
type User = Awaited<ReturnType<typeof makeUser>>
let P: Org // the platform org
let A: Org // a tenant on the platform account
let B: Org // a tenant whose admin tries to claim the platform account
let V: Org // a tenant on its own Twilio account (vault)
let owner: User
let bAdmin: User
let aManager: User

const ATTACKER_TOKEN = 'attacker-chosen-token'
const A_LINE = testNumber(run, 1)
const B_LINE = testNumber(run, 2)
const CALLER = testNumber(run, 3)
const NOON = new Date('2026-10-07T18:00:00.000Z') // Wed 11:00 am Pacific

let fetchCalls: { url: string; body: string }[] = []

async function storeTwilio(organizationId: string, values: Record<string, string>) {
  const connector = await db.connector.upsert({
    where: { organizationId_kind: { organizationId, kind: 'TWILIO_SMS' } },
    update: { isEnabled: true },
    create: { organizationId, kind: 'TWILIO_SMS', name: 'Twilio SMS', isEnabled: true },
    select: { id: true },
  })
  await db.connectorCredential.deleteMany({ where: { connectorId: connector.id } })
  for (const [fieldKey, value] of Object.entries(values)) {
    await db.connectorCredential.create({ data: { organizationId, connectorId: connector.id, fieldKey, ...encryptSecret(value) } })
  }
}

async function as<T>(user: User, fn: () => Promise<T>): Promise<T> {
  state.actor = user.actor
  return fn()
}

async function drain() {
  while (afterQueue.length) await afterQueue.shift()!()
}

async function client(org: Org, phone: string, opts: { consent?: boolean; stageId?: string } = {}) {
  return db.client.create({
    data: {
      organizationId: org.orgId,
      pipelineId: org.pipelineId,
      currentStageId: opts.stageId ?? org.intakeStageId,
      firstName: 'Pat',
      lastName: 'Client',
      email: `pat.${phone.slice(-6)}.${run}@example.test`,
      phone,
      ...(opts.consent
        ? { consents: { create: [{ type: 'TCPA_CONTACT' as const, granted: true, textVersion: 'v1', text: 'Consent', purpose: 'test' }] } }
        : {}),
    },
  })
}

beforeAll(async () => {
  P = await makeOrg(run, 'Platform')
  A = await makeOrg(run, 'A')
  B = await makeOrg(run, 'B')
  V = await makeOrg(run, 'Vault')
  stubTelephonyEnv(P.orgId)
  owner = await makeUser(P.orgId, run, 'Owner', 'SUPER_ADMIN', { permissions: ['telephony:manage', 'users:manage'] })
  bAdmin = await makeUser(B.orgId, run, 'B Admin', 'SUPER_ADMIN', { permissions: ['telephony:manage', 'connectors:manage', 'users:manage', 'communications:send'] })
  aManager = await makeUser(A.orgId, run, 'A Manager', 'SUPER_ADMIN', {
    permissions: ['telephony:manage', 'communications:send', 'communications:read', 'clients:read_all', 'users:manage'],
  })
  await makeLine(A.orgId, A_LINE, { friendlyName: 'A line', providerAccountSid: ACCOUNT })
  await makeLine(B.orgId, B_LINE, { friendlyName: 'B line' })
  await storeTwilio(V.orgId, { accountSid: OTHER_ACCOUNT, authToken: OTHER_TOKEN })
})

beforeEach(() => {
  afterQueue.length = 0
  fetchCalls = []
  stubTelephonyEnv(P.orgId)
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: String(init?.body ?? '') })
    return new Response(JSON.stringify({ sid: sid('SM', run, fetchCalls.length), status: 'queued' }), { status: 201 })
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  await db.connector.deleteMany({ where: { organizationId: B.orgId } })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.telephonyAccountState.deleteMany({ where: { accountSid: { in: [ACCOUNT, OTHER_ACCOUNT] } } })
  await db.organization.deleteMany({ where: { id: { in: [A.orgId, B.orgId, V.orgId, P.orgId] } } })
})

// ── sec-1 ────────────────────────────────────────────────────────────────────

describe('sec-1: the platform Account SID in a tenant vault', () => {
  it('resolves to the platform env pair, never the vault token', async () => {
    await storeTwilio(B.orgId, { accountSid: ACCOUNT, authToken: ATTACKER_TOKEN })
    expect(await telephonyCredentialsDetailed(B.orgId)).toEqual({ creds: { accountSid: ACCOUNT, authToken: TOKEN }, source: 'platform' })
    expect(await credentialScope(B.orgId)).toEqual({ kind: 'platform', creds: { accountSid: ACCOUNT, authToken: TOKEN } })
  })

  it("can't pass the account guard, so the shared voice-limit row stays untouched", async () => {
    await storeTwilio(B.orgId, { accountSid: ACCOUNT, authToken: ATTACKER_TOKEN })
    expect(await guardAccountAction(bAdmin.actor, B.orgId)).toMatchObject({ ok: false, code: 'PLATFORM_ONLY' })
    expect(await as(bAdmin, () => setVoiceLimitedMode('off'))).toMatchObject({ ok: false, code: 'PLATFORM_ONLY' })
    expect(await db.telephonyAccountState.findUnique({ where: { accountSid: ACCOUNT } })).toBeNull()
    // The platform owner still can.
    expect(await guardAccountAction(owner.actor, P.orgId)).toMatchObject({ ok: true, scope: { kind: 'platform' } })
  })

  it("can't sign webhooks for its own lines with a token it chose", async () => {
    await storeTwilio(B.orgId, { accountSid: ACCOUNT, authToken: ATTACKER_TOKEN })
    const forged = { CallSid: sid('CA', run, 'forged'), AccountSid: ACCOUNT, From: CALLER, To: B_LINE, CallStatus: 'ringing', ErrorCode: '10004' }
    const res = await voice(signedPost('/api/telephony/voice', forged, ATTACKER_TOKEN))
    expect(res.status).toBe(403)
    await drain()
    expect(await db.voiceCall.findUnique({ where: { callSid: forged.CallSid } })).toBeNull()
    // Twilio's real signature (the platform token) still works for B's line.
    const real = { ...forged, CallSid: sid('CA', run, 'real') }
    expect((await voice(signedPost('/api/telephony/voice', real, TOKEN))).status).toBe(200)
  })

  it('the connector save refuses the platform SID, alone or with a token', async () => {
    expect(await checkTwilioConnectorSave(B.orgId, 'TWILIO_SMS', { accountSid: ACCOUNT })).toEqual({ ok: false, error: PLATFORM_SID_REFUSED })
    expect(await checkTwilioConnectorSave(B.orgId, 'TWILIO_VOICE', { accountSid: ` ${ACCOUNT} `, authToken: 'x' })).toEqual({ ok: false, error: PLATFORM_SID_REFUSED })
    // A token saved later is checked against the SID already stored.
    await storeTwilio(B.orgId, { accountSid: ACCOUNT })
    expect(await checkTwilioConnectorSave(B.orgId, 'TWILIO_SMS', { authToken: ATTACKER_TOKEN })).toEqual({ ok: false, error: PLATFORM_SID_REFUSED })
    expect(await checkTwilioConnectorSave(B.orgId, 'EMAIL', { accountSid: ACCOUNT })).toEqual({ ok: true })
  })

  it('with live carriers the pair must answer Twilio with the same SID', async () => {
    const env = { ...process.env, TELEPHONY_PROVIDER: 'twilio' }
    const seen: string[] = []
    const answer = (status: number, body: unknown) =>
      (async (url: string | URL | Request) => {
        seen.push(String(url))
        return new Response(JSON.stringify(body), { status })
      }) as unknown as typeof fetch
    expect(await checkTwilioPair({ accountSid: OTHER_ACCOUNT, authToken: OTHER_TOKEN }, { env, fetcher: answer(200, { sid: OTHER_ACCOUNT }) })).toEqual({ ok: true })
    expect(seen[0]).toBe(`https://api.twilio.com/2010-04-01/Accounts/${OTHER_ACCOUNT}.json`)
    expect(await checkTwilioPair({ accountSid: OTHER_ACCOUNT, authToken: 'wrong' }, { env, fetcher: answer(401, { code: 20003 }) })).toEqual({ ok: false, error: PAIR_REFUSED })
    expect(await checkTwilioPair({ accountSid: OTHER_ACCOUNT, authToken: OTHER_TOKEN }, { env, fetcher: answer(200, { sid: ACCOUNT }) })).toEqual({ ok: false, error: PAIR_REFUSED })
    const down = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await checkTwilioPair({ accountSid: OTHER_ACCOUNT, authToken: OTHER_TOKEN }, { env, fetcher: down })).toEqual({ ok: false, error: CHECK_UNAVAILABLE })
    // Mock carrier: nothing leaves the server.
    seen.length = 0
    expect(await checkTwilioPair({ accountSid: OTHER_ACCOUNT, authToken: OTHER_TOKEN }, { fetcher: answer(500, {}) })).toEqual({ ok: true })
    expect(seen).toHaveLength(0)
  })
})

// ── sec-2 + compliance-stop-to-fallback-sender-lost ─────────────────────────

describe("sec-2: a text's From is the org's own line", () => {
  it("a vault From number next to platform credentials (another org's line) is never used", async () => {
    await storeTwilio(B.orgId, { fromNumber: A_LINE })
    await db.phoneNumber.updateMany({ where: { e164: B_LINE }, data: { capabilities: { sms: false, voice: true, mms: false } } })
    const res = await new TwilioSmsProvider().send({ to: CALLER, body: 'hello', organizationId: B.orgId })
    expect(res).toEqual({ status: 'FAILED', externalRef: null, error: NO_TEXTING_LINE })
    expect(fetchCalls).toHaveLength(0)
    await db.phoneNumber.updateMany({ where: { e164: B_LINE }, data: { capabilities: { sms: true, voice: true, mms: true } } })
  })

  it('TWILIO_FROM_NUMBER is not a fallback for an organization', async () => {
    vi.stubEnv('TWILIO_FROM_NUMBER', A_LINE)
    const lineless = await makeOrg(run, 'Lineless')
    const res = await new TwilioSmsProvider().send({ to: CALLER, body: 'hello', organizationId: lineless.orgId })
    expect(res).toMatchObject({ status: 'FAILED', error: NO_TEXTING_LINE })
    expect(fetchCalls).toHaveLength(0)
    await db.organization.delete({ where: { id: lineless.orgId } })
  })

  it('a voice-only main line no longer hides an SMS-capable second line', async () => {
    const org = await makeOrg(run, 'Twolines')
    const voiceOnly = testNumber(run, 10)
    const texting = testNumber(run, 11)
    await makeLine(org.orgId, voiceOnly, { isPrimary: true })
    await db.phoneNumber.updateMany({ where: { e164: voiceOnly }, data: { capabilities: { sms: false, voice: true, mms: false } } })
    await makeLine(org.orgId, texting, { isPrimary: false })
    expect(await accountSendingNumber(org.orgId)).toBe(texting)
    const res = await new TwilioSmsProvider().send({ to: CALLER, body: 'hello', organizationId: org.orgId })
    expect(res.status).toBe('SENT')
    expect(new URLSearchParams(fetchCalls[0].body).get('From')).toBe(texting)
    await db.organization.delete({ where: { id: org.orgId } })
  })

  it('a line recorded on another carrier account is not a From for this one', async () => {
    expect(await accountSendingNumber(A.orgId, { accountSid: ACCOUNT })).toBe(A_LINE)
    expect(await accountSendingNumber(A.orgId, { accountSid: OTHER_ACCOUNT })).toBeNull()
  })

  it("a STOP to a number we have no line for tells the platform owner's admins, never another tenant", async () => {
    const unknownLine = testNumber(run, 12)
    const from = testNumber(run, 13)
    const res = await sms(signedPost('/api/telephony/sms', { MessageSid: sid('SM', run, 'stop'), AccountSid: ACCOUNT, From: from, To: unknownLine, Body: 'STOP' }))
    expect(res.status).toBe(200)
    const note = await db.notification.findFirst({ where: { organizationId: P.orgId, title: 'Opt-out not saved' } })
    expect(note?.body).toContain(from.slice(-4))
    for (const other of [A, B, V]) {
      expect(await db.notification.count({ where: { organizationId: other.orgId, title: 'Opt-out not saved' } })).toBe(0)
    }
  })

  it('with no platform owner configured, an unrouted opt-out notifies nobody', async () => {
    vi.stubEnv('TELEPHONY_PLATFORM_ORG_ID', '')
    const from = testNumber(run, 14)
    const res = await sms(signedPost('/api/telephony/sms', { MessageSid: sid('SM', run, 'stop2'), AccountSid: ACCOUNT, From: from, To: testNumber(run, 15), Body: 'STOP' }))
    expect(res.status).toBe(200)
    const notes = await db.notification.findMany({ where: { title: 'Opt-out not saved', body: { contains: from.slice(-4) } } })
    expect(notes).toHaveLength(0)
  })

  it("a From number saved next to the org's own credentials is never sent from until it is synced in", async () => {
    const savedFrom = testNumber(run, 16)
    await storeTwilio(V.orgId, { accountSid: OTHER_ACCOUNT, authToken: OTHER_TOKEN, fromNumber: savedFrom })
    const res = await new TwilioSmsProvider().send({ to: CALLER, body: 'hello', organizationId: V.orgId })
    expect(res).toEqual({ status: 'FAILED', externalRef: null, error: FROM_NUMBER_NOT_SYNCED })
    expect(fetchCalls).toHaveLength(0)
    // Once the number is a line on that account, texts go out from it.
    await makeLine(V.orgId, savedFrom, { friendlyName: 'V line', providerAccountSid: OTHER_ACCOUNT })
    const ok = await new TwilioSmsProvider().send({ to: CALLER, body: 'hello', organizationId: V.orgId })
    expect(ok.status).toBe('SENT')
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toContain(OTHER_ACCOUNT)
    expect(new URLSearchParams(fetchCalls[0].body).get('From')).toBe(savedFrom)
    await db.phoneNumber.deleteMany({ where: { e164: savedFrom } })
    await storeTwilio(V.orgId, { accountSid: OTHER_ACCOUNT, authToken: OTHER_TOKEN })
  })
})

// ── compliance-reply-window-automation ──────────────────────────────────────

describe('the 30-minute reply window is for people, not automation', () => {
  it('an automated text at 11 pm is deferred even right after the client texted in', async () => {
    const phone = testNumber(run, 20)
    const c = await client(A, phone, { consent: true })
    const late = new Date('2026-10-08T06:00:00.000Z') // Wed 11:00 pm Pacific
    await db.communication.create({
      data: { clientId: c.id, channel: 'SMS', direction: 'INBOUND', status: 'RECEIVED', body: 'thanks', occurredAt: new Date(late.getTime() - 10 * 60_000), message: { create: {} } },
    })
    const input = { organizationId: A.orgId, channel: 'SMS' as const, purpose: 'marketing' as const, phone, clientId: c.id, zoneHints: { e164: phone } }
    expect(await decideOutbound(input, { now: late })).toMatchObject({ allowed: true })
    const automated = await decideOutbound({ ...input, automated: true }, { now: late })
    expect(automated).toMatchObject({ allowed: false, code: 'OUTSIDE_HOURS' })
    expect(automated.allowed === false && automated.retryAt).toBeInstanceOf(Date)
  })
})

// ── compliance-review-confirm-keeps-consent ─────────────────────────────────

describe('confirming a held opt-out', () => {
  it("revokes the client's TCPA consent: calls need consent again and START can't undo it", async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON })
    const phone = testNumber(run, 30)
    const c = await client(A, phone, { consent: true })
    const hold = await db.callCenterSuppression.create({
      data: { organizationId: A.orgId, numberHash: phoneHash(phone), reason: 'Possible opt-out', last4: phone.slice(-4), smsBlockedAt: new Date(), smsBlockedSource: 'sms_stop_review' },
    })
    const call = { organizationId: A.orgId, channel: 'CALL' as const, purpose: 'marketing' as const, phone, clientId: c.id, zoneHints: { e164: phone } }
    expect(await decideOutbound(call)).toMatchObject({ allowed: true })
    // While held, a text is "held", not decided.
    expect(await decideOutbound({ ...call, channel: 'SMS' })).toMatchObject({ allowed: false, code: 'SUPPRESSED', held: true })

    expect(await as(aManager, () => reviewSmsOptOut(hold.id, 'confirm', 'They meant it'))).toEqual({ ok: true })
    const consent = await db.consent.findFirstOrThrow({ where: { clientId: c.id, type: 'TCPA_CONTACT' } })
    expect(consent.revokedAt).not.toBeNull()
    expect(await db.auditEvent.count({ where: { organizationId: A.orgId, action: 'consent.revoked', entityId: c.id } })).toBe(1)
    expect(await decideOutbound(call)).toMatchObject({ allowed: false, code: 'NO_CONSENT' })

    expect(await clearSmsStop(A.orgId, phoneHash(phone))).toBe(true)
    expect(await decideOutbound({ ...call, channel: 'SMS' })).toMatchObject({ allowed: false, code: 'OPTED_OUT' })
  })
})

// ── compliance-finalize-not-race-safe ───────────────────────────────────────

describe('finalizing one call twice at once', () => {
  async function lead(org: Org) {
    return db.callCenterLead.create({ data: { organizationId: org.orgId, source: 'INBOUND', language: 'EN', status: 'WAITING' } })
  }

  it('an inbound call gets one trail line', async () => {
    const l = await lead(A)
    const vc = await db.voiceCall.create({
      data: { organizationId: A.orgId, callSid: sid('CA', run, 'race-in'), accountSid: ACCOUNT, direction: 'INBOUND', status: 'completed', outcome: 'NO_ANSWER', stage: 'hung-up', endedAt: new Date(), callCenterLeadId: l.id },
    })
    await Promise.all([finalizeCall(vc.id), finalizeCall(vc.id), finalizeCall(vc.id)])
    const events = await db.callCenterEvent.findMany({ where: { leadId: l.id, type: 'CALL' } })
    expect(events).toHaveLength(1)
    expect(events[0].voiceCallId).toBe(vc.id)
  })

  it('an outbound call gets one trail line and counts one try', async () => {
    const l = await lead(A)
    const vc = await db.voiceCall.create({
      data: { organizationId: A.orgId, callSid: sid('CA', run, 'race-out'), accountSid: ACCOUNT, direction: 'OUTBOUND', status: 'completed', outcome: 'NO_ANSWER', endedAt: new Date(), callCenterLeadId: l.id },
    })
    await Promise.all([finalizeCall(vc.id), finalizeCall(vc.id), finalizeCall(vc.id)])
    expect(await db.callCenterEvent.count({ where: { leadId: l.id, type: 'CALL' } })).toBe(1)
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: l.id } })).tries).toBe(1)
    // A replay later changes nothing.
    await finalizeCall(vc.id)
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: l.id } })).tries).toBe(1)
  })

  it("an outbound call whose result never arrived is not guessed as 'No answer'", async () => {
    const l = await db.callCenterLead.create({ data: { organizationId: A.orgId, source: 'INBOUND', language: 'EN', status: 'WAITING', tries: 1 } })
    const vc = await db.voiceCall.create({
      data: { organizationId: A.orgId, callSid: sid('CA', run, 'lost-out'), accountSid: ACCOUNT, direction: 'OUTBOUND', status: 'unknown', endedAt: new Date(), callCenterLeadId: l.id },
    })
    await Promise.all([finalizeCall(vc.id), finalizeCall(vc.id)])
    const events = await db.callCenterEvent.findMany({ where: { leadId: l.id, type: 'CALL' } })
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0].body)).toMatchObject({ detail: CALL_RESULT_UNKNOWN, voiceCallId: vc.id })
    const after = await db.callCenterLead.findUniqueOrThrow({ where: { id: l.id } })
    expect(after).toMatchObject({ tries: 1, status: 'WAITING', nextAttemptAt: null })
    expect((await db.voiceCall.findUniqueOrThrow({ where: { id: vc.id } })).needsAction).toBe(false)
  })
})

// ── compliance-client-zone-unfixable ────────────────────────────────────────

describe("a client's time zone", () => {
  it('a client with a number abroad can be given a zone, which unblocks the call', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON })
    const c = await client(A, '+573001234567', { stageId: A.fulfillmentStageId })
    const target = { kind: 'client' as const, id: c.id }
    expect(await as(aManager, () => checkDial(target))).toMatchObject({ ok: false, code: 'UNKNOWN_TIMEZONE' })
    expect(await as(aManager, () => setContactTimeZone({ target, zone: 'America/Bogota', note: 'Lives in Bogotá' }))).toEqual({ ok: true })
    expect((await db.client.findUniqueOrThrow({ where: { id: c.id } })).timeZone).toBe('America/Bogota')
    expect(await as(aManager, () => checkDial(target))).toMatchObject({ ok: true, calleeZone: 'America/Bogota' })
    expect(await db.auditEvent.count({ where: { organizationId: A.orgId, action: 'telephony.timezone_set', entityId: c.id } })).toBe(1)
  })

  it('setting the zone wakes automated texts parked for it, and only those', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON })
    const c = await client(A, '+573001234568', { stageId: A.fulfillmentStageId })
    const later = new Date(NOON.getTime() + 6 * 3_600_000)
    const parked = await db.scheduledMessage.create({
      data: { organizationId: A.orgId, clientId: c.id, channel: 'SMS', body: 'Hi', sendAt: later, error: ZONE_WAIT_NOTE },
    })
    const other = await db.scheduledMessage.create({ data: { organizationId: A.orgId, clientId: c.id, channel: 'SMS', body: 'Later', sendAt: later } })
    const sequence = await db.sequence.create({ data: { organizationId: A.orgId, name: `Zone ${run}` } })
    const enrolled = await db.sequenceEnrollment.create({ data: { sequenceId: sequence.id, clientId: c.id, nextRunAt: later, stoppedReason: ZONE_WAIT_NOTE } })
    await as(aManager, () => setContactTimeZone({ target: { kind: 'client', id: c.id }, zone: 'America/Bogota', note: 'Lives in Bogotá' }))
    expect((await db.scheduledMessage.findUniqueOrThrow({ where: { id: parked.id } })).sendAt.getTime()).toBeLessThanOrEqual(NOON.getTime())
    expect((await db.scheduledMessage.findUniqueOrThrow({ where: { id: other.id } })).sendAt.getTime()).toBe(later.getTime())
    expect((await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrolled.id } })).nextRunAt!.getTime()).toBeLessThanOrEqual(NOON.getTime())
  })
})

// ── regression-platform-number-assigned-to-vault-org ────────────────────────

describe('platform numbers and orgs on their own Twilio', () => {
  it('the platform owner cannot assign a platform number to an org with its own Twilio', async () => {
    const numberSid = `PN${'c3'.repeat(16)}`
    expect(await setNumberAssignment(owner.actor, { sid: numberSid, organizationId: V.orgId })).toEqual({ ok: false, code: 'OWN_ACCOUNT', error: OWN_ACCOUNT_REFUSED })
    expect(await setNumberAssignment(owner.actor, { sid: numberSid, organizationId: A.orgId })).toEqual({ ok: true })
    expect(await setNumberAssignment(owner.actor, { sid: numberSid, organizationId: null })).toEqual({ ok: true })
  })

  it("a line recorded on the platform account verifies with the platform token, even in a vault org", async () => {
    const line = testNumber(run, 40)
    await makeLine(V.orgId, line, { friendlyName: 'Old platform line', providerAccountSid: ACCOUNT, isPrimary: false })
    const params = { CallSid: sid('CA', run, 'vline'), AccountSid: ACCOUNT, From: CALLER, To: line, CallStatus: 'ringing' }
    expect((await voice(signedPost('/api/telephony/voice', params, TOKEN))).status).toBe(200)
    expect((await voice(signedPost('/api/telephony/voice', { ...params, CallSid: sid('CA', run, 'vline2') }, OTHER_TOKEN))).status).toBe(403)
    // …and a text from that vault org never goes out From it on the vault account.
    expect(await accountSendingNumber(V.orgId, { accountSid: OTHER_ACCOUNT })).toBeNull()
  })
})
