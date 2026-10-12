/**
 * The dial pad's `number:` target against the database (docs/DIAL_PAD.md §2):
 * a typed number matches a client in scope, then a lead in the org (no desk
 * lock), else it is an unknown number called as servicing on the rep's say-so.
 * Do-not-call and calling hours still decide; the webhook re-resolves; every
 * hand dial leaves one audit row with the last four only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ actor: null as unknown, afterQueue: [] as (() => unknown)[] }))
vi.mock('@/lib/rbac', async (orig) => ({
  ...(await orig<typeof import('@/lib/rbac')>()),
  requireUser: async () => state.actor,
  getSessionUser: async () => state.actor,
}))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    state.afterQueue.push(fn)
  },
}))

import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { POST as clientVoice } from '@/app/api/telephony/client/voice/route'
import { checkDial } from '@/lib/telephony/actions'
import { phoneHash } from '@/lib/telephony/compliance-core'
import { NOT_A_US_NUMBER, resolveDialTarget } from '@/lib/telephony/targets'
import type { DialCheck } from '@/lib/telephony/voice-contract'
import { ACCOUNT, makeLine, makeOrg, makeUser, sid, signedPost, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `thand-${Date.now().toString(36)}`
const APP_SID = `AP${'8'.repeat(32)}`
let n = 0
const callSid = () => sid('CA', run, n++)

// Wednesday 2026-10-07, 11:00 am Pacific; 8:40 pm Pacific the same day.
const NOON = new Date('2026-10-07T18:00:00.000Z')
const EVENING = new Date('2026-10-08T03:40:00.000Z')

type User = Awaited<ReturnType<typeof makeUser>>
let orgId = ''
let rep: User
let rep2: User
let mainLine = ''
let clientId = ''
let leadId = ''

const CLIENT_PHONE = testNumber(run, 10)
const OTHERS_CLIENT_PHONE = testNumber(run, 11)
const LEAD_PHONE = testNumber(run, 12)
const UNKNOWN_PHONE = testNumber(run, 13)
const SUPPRESSED_PHONE = testNumber(run, 14)

const num = (e164: string) => ({ kind: 'number' as const, id: e164 })

async function as<T>(user: User, fn: () => Promise<T>): Promise<T> {
  state.actor = user.actor
  return fn()
}

async function client(name: string, phone: string, ownerId: string) {
  const row = await db.client.create({
    data: {
      organizationId: orgId,
      pipelineId: (await db.pipeline.findFirstOrThrow({ where: { organizationId: orgId } })).id,
      currentStageId: (await db.pipelineStage.findFirstOrThrow({ where: { pipeline: { organizationId: orgId }, category: 'INTAKE' } })).id,
      firstName: name,
      lastName: 'Test',
      email: `${name.toLowerCase()}.${run}@example.test`,
      // Stored the way people type it: the match normalises.
      phone: `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`,
      ownerId,
    },
  })
  await db.consent.create({
    data: { clientId: row.id, type: 'TCPA_CONTACT', granted: true, textVersion: 'v1', text: 'ok', purpose: 'test', grantedAt: new Date('2026-09-01T00:00:00Z') },
  })
  return row.id
}

async function place(user: User, target: string) {
  const cs = callSid()
  const res = await clientVoice(
    signedPost('/api/telephony/client/voice', {
      CallSid: cs,
      AccountSid: ACCOUNT,
      ApplicationSid: APP_SID,
      From: `client:pf_${orgId}_${user.id}`,
      To: '',
      target,
      line: mainLine,
    }),
  )
  expect(res.status).toBe(200)
  return { cs, twiml: await res.text() }
}

function handDialAudits() {
  return db.auditEvent.findMany({ where: { organizationId: orgId, action: 'telephony.hand_dial' }, orderBy: { createdAt: 'asc' } })
}

beforeAll(async () => {
  orgId = (await makeOrg(run)).orgId
  stubTelephonyEnv(orgId)
  rep = await makeUser(orgId, run, 'Hand Rep', 'CLOSER')
  rep2 = await makeUser(orgId, run, 'Hand Rep Two', 'CLOSER')
  mainLine = (await makeLine(orgId, testNumber(run, 1), { routing: 'FORWARD', forwardTo: testNumber(run, 2), isPrimary: true })).id
  clientId = await client('Casey', CLIENT_PHONE, rep.id)
  await client('Other', OTHERS_CLIENT_PHONE, rep2.id)
  leadId = (
    await db.callCenterLead.create({
      data: {
        organizationId: orgId,
        source: 'FORM',
        language: 'EN',
        status: 'WAITING',
        lockedBy: rep2.id, // another rep holds it: a hand dial may still call
        phoneLast4: LEAD_PHONE.slice(-4),
        phoneSecret: encryptSecret(LEAD_PHONE) as never,
        phoneHash: phoneHash(LEAD_PHONE),
        consentAt: new Date('2026-10-01T00:00:00Z'),
        consentSource: 'lead_form',
        consentFormId: 'f1',
      },
    })
  ).id
  await db.callCenterSuppression.create({
    data: {
      organizationId: orgId,
      numberHash: phoneHash(SUPPRESSED_PHONE),
      reason: 'test',
      last4: SUPPRESSED_PHONE.slice(-4),
      callBlockedAt: new Date(),
      callBlockedSource: 'manual',
    },
  })
})

beforeEach(() => {
  state.afterQueue.length = 0
  vi.unstubAllEnvs()
  stubTelephonyEnv(orgId)
  vi.useFakeTimers({ toFake: ['Date'], now: NOON })
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.organization.delete({ where: { id: orgId } })
})

describe('resolveDialTarget for a typed number', () => {
  it('a client in scope: exactly what the client target gives', async () => {
    const byNumber = await resolveDialTarget(rep.actor, num(CLIENT_PHONE), NOON)
    const byId = await resolveDialTarget(rep.actor, { kind: 'client', id: clientId }, NOON)
    expect(byNumber.ok && byId.ok).toBe(true)
    if (!byNumber.ok || !byId.ok) return
    expect(byNumber.target).toMatchObject({ clientId, leadId: null, who: 'Casey Test', handDial: 'client' })
    expect(byNumber.target.purpose).toBe(byId.target.purpose)
    expect(byNumber.target.servicingBasis).toBe(byId.target.servicingBasis)
  })

  it('a lead in the org, held by another rep: matched without the desk lock', async () => {
    expect(await resolveDialTarget(rep.actor, { kind: 'lead', id: leadId }, NOON)).toMatchObject({ ok: false, code: 'LOCKED_BY_OTHER' })
    const res = await resolveDialTarget(rep.actor, num(LEAD_PHONE), NOON)
    expect(res).toMatchObject({ ok: true, target: { leadId, clientId: null, purpose: 'marketing', handDial: 'lead', phone: LEAD_PHONE } })
  })

  it('an unknown number: servicing, on the rep\'s say-so', async () => {
    const res = await resolveDialTarget(rep.actor, num(UNKNOWN_PHONE), NOON)
    expect(res).toMatchObject({
      ok: true,
      target: {
        clientId: null,
        leadId: null,
        purpose: 'servicing',
        servicingBasis: 'Hand-dialed by Hand Rep',
        handDial: 'unknown',
        zoneHints: { e164: UNKNOWN_PHONE },
      },
    })
    if (res.ok) expect(res.target.who).toMatch(/^\(725\) \d{3}-\d{4}$/)
  })

  it('a client outside the rep\'s scope is not revealed: it is an unknown number', async () => {
    const res = await resolveDialTarget(rep.actor, num(OTHERS_CLIENT_PHONE), NOON)
    expect(res).toMatchObject({ ok: true, target: { clientId: null, handDial: 'unknown' } })
    if (res.ok) expect(res.target.who).not.toContain('Other')
  })

  it('anything that is not a US number is NO_NUMBER', async () => {
    for (const id of ['+447911123456', '+11255551234', '555-1234', '']) {
      expect(await resolveDialTarget(rep.actor, num(id), NOON)).toMatchObject({ ok: false, code: 'NO_NUMBER', reason: NOT_A_US_NUMBER })
    }
  })
})

describe('checkDial for a typed number (tel: flow)', () => {
  it('an unknown number in hours is allowed, with the hand-dial basis and one audit row', async () => {
    const before = (await handDialAudits()).length
    const res = (await as(rep, () => checkDial(num(UNKNOWN_PHONE)))) as DialCheck
    expect(res).toMatchObject({ ok: true, purpose: 'servicing', basis: 'Hand-dialed by Hand Rep', line: null })
    const rows = await handDialAudits()
    expect(rows).toHaveLength(before + 1)
    const row = rows.at(-1)!
    expect(row.after).toMatchObject({ last4: UNKNOWN_PHONE.slice(-4), match: 'unknown', via: 'tel' })
    expect(JSON.stringify(row)).not.toContain(UNKNOWN_PHONE.slice(2))
  })

  it('the do-not-call list still blocks, and nothing is logged as a dial', async () => {
    const before = (await handDialAudits()).length
    expect(await as(rep, () => checkDial(num(SUPPRESSED_PHONE)))).toMatchObject({ ok: false, code: 'SUPPRESSED' })
    expect(await handDialAudits()).toHaveLength(before)
  })

  it('calling hours still apply', async () => {
    vi.setSystemTime(EVENING)
    expect(await as(rep, () => checkDial(num(UNKNOWN_PHONE)))).toMatchObject({ ok: false, code: 'OUTSIDE_HOURS' })
  })

  it('a malformed number never reaches the rules', async () => {
    expect(await as(rep, () => checkDial(num('+447911123456')))).toMatchObject({ ok: false, code: 'NO_NUMBER', reason: NOT_A_US_NUMBER })
  })
})

describe('the browser-call webhook re-resolves a typed number', () => {
  beforeEach(() => {
    stubTelephonyEnv(orgId, {
      VOICE_BROWSER_ENABLED: 'true',
      TWILIO_TWIML_APP_SID: APP_SID,
      TWILIO_API_KEY_SID: `SK${'1'.repeat(32)}`,
      TWILIO_API_KEY_SECRET: 'test-only-key-secret',
    })
  })

  it('a client match: dials the client, the call lands on their file, one audit row', async () => {
    const before = (await handDialAudits()).length
    const { cs, twiml } = await place(rep, `number:${CLIENT_PHONE}`)
    expect(twiml).toContain(`<Number`)
    expect(twiml).toContain(CLIENT_PHONE.slice(-4))
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc).toMatchObject({ direction: 'OUTBOUND', clientId, callCenterLeadId: null, userId: rep.id })
    expect(vc.communicationId).toBeTruthy()
    const rows = await handDialAudits()
    expect(rows).toHaveLength(before + 1)
    expect(rows.at(-1)!.after).toMatchObject({ last4: CLIENT_PHONE.slice(-4), match: 'client', via: 'browser', voiceCallId: vc.id })
  })

  it('a lead match: the call links to the lead', async () => {
    const { cs, twiml } = await place(rep, `number:${LEAD_PHONE}`)
    expect(twiml).toContain(`>${LEAD_PHONE}</Number>`)
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc).toMatchObject({ clientId: null, callCenterLeadId: leadId, purpose: 'marketing' })
  })

  it('an unknown number: servicing, no client or lead', async () => {
    const { cs, twiml } = await place(rep, `number:${UNKNOWN_PHONE}`)
    expect(twiml).toContain(`>${UNKNOWN_PHONE}</Number>`)
    const vc = await db.voiceCall.findUniqueOrThrow({ where: { callSid: cs } })
    expect(vc).toMatchObject({ clientId: null, callCenterLeadId: null, purpose: 'servicing', basis: 'Hand-dialed by Hand Rep' })
  })

  it('never dials a suppressed number, or a key that is not exactly +1 and ten digits', async () => {
    expect((await place(rep, `number:${SUPPRESSED_PHONE}`)).twiml).toContain('This number is on the do-not-call list.')
    const bad = await place(rep, `number:${UNKNOWN_PHONE.slice(2)}`)
    expect(bad.twiml).not.toContain('<Dial')
  })
})
