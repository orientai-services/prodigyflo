/**
 * The server actions and the compliance loader against the database
 * (docs/TELEPHONY_LIVE.md §2.7, §3): checkDial for the P0a tel: flow (and its
 * hours override), the do-not-contact list, team numbers vs. a self-edited
 * profile phone, recorded consent, time zones, missed calls, fail-closed
 * loading, browser-calling setup and the presence heartbeat.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ actor: null as unknown }))
vi.mock('@/lib/rbac', async (orig) => ({
  ...(await orig<typeof import('@/lib/rbac')>()),
  requireUser: async () => state.actor,
  getSessionUser: async () => state.actor,
}))

import { decodeJwt } from 'jose'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import {
  addSuppression,
  addTeamNumber,
  checkDial,
  getVoiceSetup,
  getVoiceToken,
  listMissedCalls,
  listSuppressions,
  listTeamNumbers,
  markMissedCallHandled,
  recordConsent,
  removeSuppression,
  reviewSmsOptOut,
  setConsentForms,
  setContactTimeZone,
} from '@/lib/telephony/actions'
import { decideOutbound } from '@/lib/telephony/compliance'
import { phoneHash } from '@/lib/telephony/compliance-core'
import { POST as presence } from '@/app/api/voice/presence/route'
import type { DialCheck, SuppressionVM } from '@/lib/telephony/voice-contract'
import { APP, ACCOUNT, OTHER_ACCOUNT, OTHER_TOKEN, makeLine, makeOrg, makeUser, sid, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `tact-${Date.now().toString(36)}`
type User = Awaited<ReturnType<typeof makeUser>>
let orgId = ''
let manager: User
let rep: User
let rep2: User
let leadId = ''
let noConsentLeadId = ''
let unknownZoneLeadId = ''

const NOON = new Date('2026-10-07T18:00:00.000Z') // Wed 11:00 am Pacific
const EVENING = new Date('2026-10-08T03:40:00.000Z') // Wed 8:40 pm Pacific
const LEAD_PHONE = testNumber(run, 10)

async function as<T>(user: User, fn: () => Promise<T>): Promise<T> {
  state.actor = user.actor
  return fn()
}

async function lead(phone: string, lockedBy: string, consent: boolean) {
  return (
    await db.callCenterLead.create({
      data: {
        organizationId: orgId,
        source: 'FORM',
        language: 'EN',
        status: 'WAITING',
        lockedBy,
        phoneLast4: phone.replace(/\D/g, '').slice(-4),
        phoneSecret: encryptSecret(phone) as never,
        phoneHash: phone.startsWith('+1') ? phoneHash(phone) : null,
        ...(consent ? { consentAt: new Date('2026-10-01T00:00:00Z'), consentSource: 'lead_form', consentFormId: 'f1' } : {}),
      },
    })
  ).id
}

beforeAll(async () => {
  orgId = (await makeOrg(run)).orgId
  stubTelephonyEnv(orgId)
  manager = await makeUser(orgId, run, 'Manager', 'SUPER_ADMIN')
  rep = await makeUser(orgId, run, 'Rep', 'CLOSER')
  rep2 = await makeUser(orgId, run, 'Rep Two', 'CLOSER')
  await makeLine(orgId, testNumber(run, 1), { routing: 'FORWARD', forwardTo: testNumber(run, 2) })
  leadId = await lead(LEAD_PHONE, rep.id, true)
  noConsentLeadId = await lead(testNumber(run, 11), rep.id, false)
  unknownZoneLeadId = await lead('+18005550142', rep.id, true)
})

beforeEach(() => {
  vi.unstubAllEnvs()
  stubTelephonyEnv(orgId)
  vi.useFakeTimers({ toFake: ['Date'], now: NOON })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.organization.delete({ where: { id: orgId } })
})

describe('checkDial (P0a: the tel: flow)', () => {
  it('passes for my own consented lead and tells me who and why', async () => {
    const res = (await as(rep, () => checkDial({ kind: 'lead', id: leadId }))) as DialCheck
    expect(res).toMatchObject({ ok: true, purpose: 'marketing', calleeZone: 'America/Los_Angeles', calleeLocalTime: '11:00 am', line: null })
    if (res.ok) expect(res.basis).toContain('form f1')
    // A rep never gets the full number back; the desk already shows it to them.
    expect(res).not.toHaveProperty('dial')
  })

  it('blocks a lead with no consent — and a manager cannot override that', async () => {
    expect(await as(rep, () => checkDial({ kind: 'lead', id: noConsentLeadId }))).toMatchObject({ ok: false, code: 'NO_CONSENT', canOverride: null })
  })

  it('refuses another rep’s lead', async () => {
    expect(await as(rep2, () => checkDial({ kind: 'lead', id: leadId }))).toMatchObject({ ok: false, code: 'LOCKED_BY_OTHER' })
  })

  it('outside hours: a rep sees no override; a manager may override with a reason, and it is audited', async () => {
    vi.setSystemTime(EVENING)
    await db.callCenterLead.update({ where: { id: leadId }, data: { lockedBy: manager.id } })
    try {
      const repView = await as(rep, () => checkDial({ kind: 'lead', id: noConsentLeadId }))
      expect(repView).toMatchObject({ ok: false, code: 'NO_CONSENT' })
      const blocked = await as(manager, () => checkDial({ kind: 'lead', id: leadId }))
      expect(blocked).toMatchObject({ ok: false, code: 'OUTSIDE_HOURS', canOverride: 'hours' })
      expect(await as(manager, () => checkDial({ kind: 'lead', id: leadId }, undefined, { kind: 'hours', reason: '  ' }))).toMatchObject({ ok: false })
      const overridden = (await as(manager, () => checkDial({ kind: 'lead', id: leadId }, undefined, { kind: 'hours', reason: 'They asked us to call tonight' }))) as DialCheck
      expect(overridden.ok).toBe(true)
      if (overridden.ok) expect(overridden.overrideToken).toMatch(/\./)
      // tel: flow (no browser line): a manager gets the number to dial.
      if (overridden.ok) expect(overridden.dial).toMatch(/^\+1\d{10}$/)
      expect(await db.auditEvent.count({ where: { organizationId: orgId, action: 'telephony.hours_override' } })).toBe(1)
    } finally {
      await db.callCenterLead.update({ where: { id: leadId }, data: { lockedBy: rep.id } })
    }
  })

  it('a rep cannot override even when asking', async () => {
    vi.setSystemTime(EVENING)
    const res = await as(rep, () => checkDial({ kind: 'lead', id: leadId }, undefined, { kind: 'hours', reason: 'please' }))
    expect(res).toMatchObject({ ok: false, code: 'OUTSIDE_HOURS', canOverride: null })
  })

  it('an unknown zone blocks until someone sets it, which is audited', async () => {
    expect(await as(rep, () => checkDial({ kind: 'lead', id: unknownZoneLeadId }))).toMatchObject({ ok: false, code: 'UNKNOWN_TIMEZONE', canOverride: null })
    expect(await as(rep, () => setContactTimeZone({ target: { kind: 'lead', id: unknownZoneLeadId }, zone: 'Not/AZone', note: 'x' }))).toMatchObject({ ok: false })
    expect(await as(rep, () => setContactTimeZone({ target: { kind: 'lead', id: unknownZoneLeadId }, zone: 'America/Denver', note: 'They said Denver' }))).toEqual({ ok: true })
    expect(await as(rep, () => checkDial({ kind: 'lead', id: unknownZoneLeadId }))).toMatchObject({ ok: true, calleeZone: 'America/Denver' })
    expect(await db.auditEvent.count({ where: { organizationId: orgId, action: 'telephony.timezone_set' } })).toBe(1)
  })
})

describe('the do-not-contact list', () => {
  it('a rep can add a number; only a manager can take it off, with a note', async () => {
    const phone = testNumber(run, 20)
    expect(await as(rep, () => addSuppression({ phone, sms: true, call: true, reason: 'Asked on the phone' }))).toEqual({ ok: true })
    const rows = (await as(rep, () => listSuppressions())) as SuppressionVM[]
    const row = rows.find((r) => r.last4 === phone.slice(-4))!
    expect(row).toMatchObject({ reason: 'Asked on the phone', by: 'Rep', sms: { source: 'manual' }, call: { source: 'manual' } })
    expect(JSON.stringify(rows)).not.toContain(phone.slice(2, 8))
    expect(await as(rep, () => removeSuppression(row.id, 'oops'))).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await as(manager, () => removeSuppression(row.id, ''))).toMatchObject({ ok: false, code: 'NO_NOTE' })
    expect(await as(manager, () => removeSuppression(row.id, 'Added by mistake'))).toEqual({ ok: true })
    expect(((await as(rep, () => listSuppressions())) as SuppressionVM[]).some((r) => r.id === row.id)).toBe(false)
  })

  it('a block written under one VAULT_KEY still blocks after VAULT_KEY changes', async () => {
    const phone = LEAD_PHONE
    await as(rep, () => addSuppression({ phone, sms: false, call: true, reason: 'DNC' }))
    vi.stubEnv('VAULT_KEY', 'a-completely-different-vault-key')
    const d = await decideOutbound({ organizationId: orgId, channel: 'CALL', purpose: 'marketing', phone, leadId, zoneHints: {} })
    expect(d).toMatchObject({ allowed: false, code: 'SUPPRESSED' })
    const row = await db.callCenterSuppression.findUniqueOrThrow({ where: { organizationId_numberHash: { organizationId: orgId, numberHash: phoneHash(phone) } } })
    await db.callCenterSuppression.delete({ where: { id: row.id } })
  })

  it('a possible opt-out can be confirmed (voids lead consent) or lifted', async () => {
    const phone = testNumber(run, 21)
    const l = await lead(phone, rep.id, true)
    const hold = await db.callCenterSuppression.create({
      data: { organizationId: orgId, numberHash: phoneHash(phone), reason: 'Possible opt-out', last4: phone.slice(-4), smsBlockedAt: new Date(), smsBlockedSource: 'sms_stop_review' },
    })
    expect(await as(rep, () => reviewSmsOptOut(hold.id, 'confirm', 'yes'))).toMatchObject({ ok: false })
    expect(await as(manager, () => reviewSmsOptOut(hold.id, 'confirm', 'They meant it'))).toEqual({ ok: true })
    expect((await db.callCenterSuppression.findUniqueOrThrow({ where: { id: hold.id } })).smsBlockedSource).toBe('sms_stop')
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: l } })).consentRevokedAt).not.toBeNull()

    const phone2 = testNumber(run, 22)
    const hold2 = await db.callCenterSuppression.create({
      data: { organizationId: orgId, numberHash: phoneHash(phone2), reason: 'Possible opt-out', last4: phone2.slice(-4), smsBlockedAt: new Date(), smsBlockedSource: 'sms_stop_review' },
    })
    expect(await as(manager, () => reviewSmsOptOut(hold2.id, 'lift', 'Not an opt-out'))).toEqual({ ok: true })
    const lifted = await db.callCenterSuppression.findUniqueOrThrow({ where: { id: hold2.id } })
    expect(lifted.smsBlockedAt).toBeNull()
    expect(lifted.removedAt).not.toBeNull()
  })

  it('without PHONE_HASH_KEY the list refuses to guess', async () => {
    vi.stubEnv('PHONE_HASH_KEY', '')
    expect(await as(rep, () => addSuppression({ phone: testNumber(run, 23), sms: true, call: false, reason: 'x' }))).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
  })
})

describe('who counts as "our own" number', () => {
  it('a rep’s self-edited profile phone set to a lead’s number does NOT make it callable', async () => {
    const phone = testNumber(run, 30)
    const l = await lead(phone, rep.id, false)
    await db.user.update({ where: { id: rep.id }, data: { phone } })
    expect(await as(rep, () => checkDial({ kind: 'lead', id: l }))).toMatchObject({ ok: false, code: 'NO_CONSENT' })
  })

  it('a manager-kept team number is callable; adding it is manager-only and audited', async () => {
    const phone = testNumber(run, 31)
    const l = await lead(phone, rep.id, false)
    expect(await as(rep, () => addTeamNumber({ phone, label: 'Sam cell' }))).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await as(manager, () => addTeamNumber({ phone, label: 'Sam cell' }))).toEqual({ ok: true })
    expect(await as(manager, () => listTeamNumbers())).toEqual([{ hash: phoneHash(phone), last4: phone.slice(-4), label: 'Sam cell' }])
    expect(await as(rep, () => checkDial({ kind: 'lead', id: l }))).toMatchObject({ ok: true, basis: 'Own team number' })
    expect(await db.auditEvent.count({ where: { organizationId: orgId, action: 'telephony.team_number_added' } })).toBe(1)
  })
})

describe('consent recorded by hand', () => {
  it('a manager records it (with where the signed copy is), and the lead becomes callable', async () => {
    const l = await lead(testNumber(run, 40), rep.id, false)
    expect(await as(rep, () => recordConsent({ target: { kind: 'lead', id: l }, note: 'Signed form in the Vault' }))).toMatchObject({ ok: false })
    expect(await as(manager, () => recordConsent({ target: { kind: 'lead', id: l }, note: 'x' }))).toMatchObject({ ok: false, code: 'NO_NOTE' })
    expect(await as(manager, () => recordConsent({ target: { kind: 'lead', id: l }, note: 'Signed form in the Vault' }))).toEqual({ ok: true })
    expect(await as(rep, () => checkDial({ kind: 'lead', id: l }))).toMatchObject({ ok: true })
  })

  it('consent forms are a manager’s, audited statement', async () => {
    expect(await as(rep, () => setConsentForms({ formId: '123', textVersion: 'v1' }))).toMatchObject({ ok: false })
    expect(await as(manager, () => setConsentForms({ formId: '123', textVersion: 'v1' }))).toEqual({ ok: true })
    expect(await as(manager, () => setConsentForms({ formId: 'bad id!', textVersion: 'v1' }))).toMatchObject({ ok: false, code: 'BAD_FORM' })
    expect(await db.auditEvent.count({ where: { organizationId: orgId, action: 'telephony.consent_form_set' } })).toBe(1)
  })
})

describe('fail closed', () => {
  it('a read error is CHECK_FAILED, never an allow', async () => {
    vi.spyOn(db.organization, 'findUnique').mockRejectedValueOnce(new Error('db down'))
    const d = await decideOutbound({ organizationId: orgId, channel: 'CALL', purpose: 'marketing', phone: LEAD_PHONE, leadId, zoneHints: {} })
    expect(d).toMatchObject({ allowed: false, code: 'CHECK_FAILED' })
  })

  it('a missing PHONE_HASH_KEY is CHECK_FAILED', async () => {
    vi.stubEnv('PHONE_HASH_KEY', '')
    expect(await as(rep, () => checkDial({ kind: 'lead', id: leadId }))).toMatchObject({ ok: false, code: 'CHECK_FAILED' })
  })
})

describe('missed calls', () => {
  it('lists the ones I may see, and "Mark handled" clears it', async () => {
    const vc = await db.voiceCall.create({
      data: {
        organizationId: orgId,
        callSid: sid('CA', run, 'missed'),
        accountSid: ACCOUNT,
        direction: 'INBOUND',
        status: 'completed',
        outcome: 'VOICEMAIL',
        needsAction: true,
        recordingSid: sid('RE', run, 'missed'),
        recordingKind: 'voicemail',
        recordingDurationSeconds: 17,
        callCenterLeadId: leadId,
        remoteLast4: '0142',
      },
    })
    const mine = await as(rep, () => listMissedCalls())
    expect(mine.find((m) => m.id === vc.id)).toMatchObject({ reason: 'voicemail', voicemail: { src: `/api/voice/recordings/${vc.id}`, seconds: 17 } })
    expect((await as(rep2, () => listMissedCalls())).some((m) => m.id === vc.id)).toBe(false)
    expect(await as(rep2, () => markMissedCallHandled(vc.id))).toMatchObject({ ok: false })
    expect(await as(rep, () => markMissedCallHandled(vc.id, 'Called back'))).toEqual({ ok: true })
    expect(await db.voiceCall.findUniqueOrThrow({ where: { id: vc.id } })).toMatchObject({ needsAction: false, handledById: rep.id, handledNote: 'Called back' })
  })
})

describe('browser calling setup (P0b)', () => {
  const keys = {
    TWILIO_API_KEY_SID: `SK${'1'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: 'test-only-key-secret',
    TWILIO_TWIML_APP_SID: `AP${'2'.repeat(32)}`,
  }

  it('with the flag off it says so, and no token is minted', async () => {
    expect(await as(rep, () => getVoiceSetup())).toEqual({ ready: false, reason: "Phone calling from the browser isn't switched on yet." })
    expect(await as(rep, () => getVoiceToken())).toMatchObject({ ok: false, code: 'FLAG_OFF' })
  })

  it('with the flag on: ready, lines, and an org-bound identity in the token', async () => {
    stubTelephonyEnv(orgId, { VOICE_BROWSER_ENABLED: 'true', ...keys })
    const setup = await as(rep, () => getVoiceSetup())
    expect(setup).toMatchObject({ ready: true, identity: `pf_${orgId}_${rep.id}`, canPickLine: false, mode: 'mock' })
    if (setup.ready) expect(setup.lines).toHaveLength(1)
    const token = await as(rep, () => getVoiceToken())
    expect('token' in token).toBe(true)
    if ('token' in token) {
      const claims = decodeJwt(token.token) as { sub: string; grants: { identity: string } }
      expect(claims.sub).toBe(ACCOUNT)
      expect(claims.grants.identity).toBe(`pf_${orgId}_${rep.id}`)
    }
  })

  it('an org on its own Twilio is not set up for browser calling yet', async () => {
    const other = await makeOrg(run, 'Own')
    const ownRep = await makeUser(other.orgId, run, 'Own Rep', 'CLOSER')
    const connector = await db.connector.create({ data: { organizationId: other.orgId, kind: 'TWILIO_SMS', name: 'Twilio', isEnabled: true } })
    for (const [fieldKey, value] of Object.entries({ accountSid: OTHER_ACCOUNT, authToken: OTHER_TOKEN })) {
      await db.connectorCredential.create({ data: { organizationId: other.orgId, connectorId: connector.id, fieldKey, ...encryptSecret(value) } })
    }
    stubTelephonyEnv(orgId, { VOICE_BROWSER_ENABLED: 'true', ...keys })
    expect(await as(ownRep, () => getVoiceSetup())).toEqual({ ready: false, reason: "Browser calling isn't set up for this account's own Twilio yet." })
    await db.organization.delete({ where: { id: other.orgId } })
  })

  it('the presence heartbeat: 404 when off, own-origin only, then recorded', async () => {
    const post = (body: string, origin = APP) =>
      presence(new Request(`${APP}/api/voice/presence`, { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body }))
    state.actor = rep.actor
    expect((await post('{"state":"ready"}')).status).toBe(404)
    stubTelephonyEnv(orgId, { VOICE_BROWSER_ENABLED: 'true', ...keys })
    expect((await post('{"state":"ready"}', 'https://evil.example')).status).toBe(403)
    expect((await post('{"state":"maybe"}')).status).toBe(400)
    expect((await post('{"state":"ready"}')).status).toBe(204)
    const row = await db.voicePresence.findUniqueOrThrow({ where: { userId_organizationId: { userId: rep.id, organizationId: orgId } } })
    expect(row).toMatchObject({ state: 'ready', identity: `pf_${orgId}_${rep.id}` })
    expect((await post('{"state":"offline"}')).status).toBe(204)
    state.actor = null
    expect((await post('{"state":"ready"}')).status).toBe(401)
  })
})
