/**
 * The Twilio status card on a SHARED account (docs/TELEPHONY_LIVE.md §2.1,
 * §2.8, §3 TwilioStatusVM): an org's own admin sees only its numbers and
 * errors — no balance, no env, no switches — while the platform owner sees the
 * account-wide view and is the only one who can change the voice-limit mode.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ actor: null as unknown }))
vi.mock('@/lib/rbac', async (orig) => ({
  ...(await orig<typeof import('@/lib/rbac')>()),
  requireUser: async () => state.actor,
  getSessionUser: async () => state.actor,
}))

import { db } from '@/lib/db'
import { getTwilioStatus, saveCallingRules, setManualCarrierState, setMessagingService, setVoiceLimitedMode } from '@/lib/telephony/actions'
import type { TwilioStatusVM } from '@/lib/telephony/voice-contract'
import { ACCOUNT, makeLine, makeOrg, makeUser, sid, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `tstat-${Date.now().toString(36)}`
type User = Awaited<ReturnType<typeof makeUser>>
let P = ''
let A = ''
let B = ''
let owner: User
let aAdmin: User
let aRep: User

async function as<T>(user: User, fn: () => Promise<T>): Promise<T> {
  state.actor = user.actor
  return fn()
}

beforeAll(async () => {
  P = (await makeOrg(run, 'Platform')).orgId
  A = (await makeOrg(run, 'A')).orgId
  B = (await makeOrg(run, 'B')).orgId
  stubTelephonyEnv(P)
  owner = await makeUser(P, run, 'Owner', 'SUPER_ADMIN')
  aAdmin = await makeUser(A, run, 'A Admin', 'SUPER_ADMIN')
  aRep = await makeUser(A, run, 'A Rep', 'CLOSER')
  await makeLine(A, testNumber(run, 1))
  await makeLine(B, testNumber(run, 2))
  await makeLine(B, testNumber(run, 3), { isPrimary: false })
  const now = new Date()
  await db.voiceCall.create({ data: { organizationId: A, callSid: sid('CA', run, 1), accountSid: ACCOUNT, direction: 'OUTBOUND', status: 'failed', errorCode: '10004', startedAt: now } })
  await db.voiceCall.create({ data: { organizationId: B, callSid: sid('CA', run, 2), accountSid: ACCOUNT, direction: 'OUTBOUND', status: 'failed', errorCode: '13227', startedAt: now } })
  await db.telephonyAccountState.upsert({
    where: { accountSid: ACCOUNT },
    create: { accountSid: ACCOUNT, balance: '$41.20', profileStatus: 'in-review', profileSource: 'twilio', mediaAuthState: 'on' },
    update: { balance: '$41.20', profileStatus: 'in-review', profileSource: 'twilio', mediaAuthState: 'on', voiceLimitedMode: 'auto' },
  })
})

beforeEach(() => stubTelephonyEnv(P))

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.telephonyAccountState.deleteMany({ where: { accountSid: ACCOUNT } })
  await db.organization.deleteMany({ where: { id: { in: [P, A, B] } } })
})

describe('an org on the shared account', () => {
  it('sees only its own numbers and errors; no balance, no env, no switches', async () => {
    const vm = (await as(aAdmin, () => getTwilioStatus(false))) as TwilioStatusVM
    expect(vm.scope).toBe('org')
    expect(vm.balance).toBeNull()
    expect(vm.env).toEqual([])
    expect(vm.voiceLimited.canChange).toBe(false)
    expect(vm.numbers).toMatchObject({ inTwilio: null, here: 1 })
    expect(vm.recentErrors.map((e) => e.code)).toEqual(['10004'])
    expect(vm.account).toBe(`AC…${ACCOUNT.slice(-4)}`)
    expect(JSON.stringify(vm)).not.toContain('test-only-auth-token')
  })

  it('its SUPER_ADMIN cannot change the account-wide switches', async () => {
    expect(await as(aAdmin, () => setVoiceLimitedMode('off'))).toMatchObject({ ok: false, code: 'PLATFORM_ONLY' })
    expect(await as(aAdmin, () => setManualCarrierState({ profile: 'twilio-approved' }))).toMatchObject({ ok: false })
    expect(await as(aAdmin, () => setMessagingService({ organizationId: A, sid: `MG${'0'.repeat(32)}` }))).toMatchObject({ ok: false })
    expect((await db.telephonyAccountState.findUniqueOrThrow({ where: { accountSid: ACCOUNT } })).voiceLimitedMode).toBe('auto')
  })

  it('a rep without telephony:read gets no card at all', async () => {
    expect(await as(aRep, () => getTwilioStatus(false))).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})

describe('the platform owner', () => {
  it('sees the account-wide view: balance, profile, env names (never values), every error', async () => {
    const vm = (await as(owner, () => getTwilioStatus(false))) as TwilioStatusVM
    expect(vm.scope).toBe('platform')
    expect(vm.balance).toBe('$41.20')
    expect(vm.profile).toMatchObject({ status: 'in-review', source: 'twilio' })
    expect(vm.mediaAuth.state).toBe('on')
    expect(vm.env.find((e) => e.name === 'TWILIO_AUTH_TOKEN')).toEqual({ name: 'TWILIO_AUTH_TOKEN', set: true })
    expect(vm.env.find((e) => e.name === 'TWILIO_API_KEY_SECRET')).toEqual({ name: 'TWILIO_API_KEY_SECRET', set: false })
    expect(JSON.stringify(vm)).not.toContain('test-only-auth-token')
    expect(vm.recentErrors.map((e) => e.code).sort()).toEqual(['10004', '13227'])
    expect(vm.voiceLimited.canChange).toBe(true)
  })

  it('can set the one-call-at-a-time mode and record carrier state by hand', async () => {
    expect(await as(owner, () => setVoiceLimitedMode('off'))).toEqual({ ok: true })
    expect((await db.telephonyAccountState.findUniqueOrThrow({ where: { accountSid: ACCOUNT } })).voiceLimitedMode).toBe('off')
    expect(await as(owner, () => setManualCarrierState({ profile: 'twilio-approved', mediaAuth: 'on' }))).toEqual({ ok: true })
    const st = await db.telephonyAccountState.findUniqueOrThrow({ where: { accountSid: ACCOUNT } })
    expect(st).toMatchObject({ profileStatus: 'twilio-approved', profileSource: 'manual', mediaAuthState: 'on', mediaAuthSource: 'manual' })
    expect(await as(owner, () => setManualCarrierState({ profile: 'whatever' }))).toMatchObject({ ok: false, code: 'BAD_STATE' })
    await as(owner, () => setVoiceLimitedMode('auto'))
  })

  it('sets a Messaging Service per org (mock: no A2P read)', async () => {
    expect(await as(owner, () => setMessagingService({ organizationId: A, sid: 'nope' }))).toMatchObject({ ok: false, code: 'BAD_SID' })
    // The owner may set it for an org on the platform account (guard is per account, not per active org).
    const res = await as(owner, () => setMessagingService({ organizationId: A, sid: `MG${'1'.repeat(32)}` }))
    expect(res).toEqual({ ok: true })
    const org = await db.organization.findUniqueOrThrow({ where: { id: A }, select: { settings: true } })
    expect((org.settings as { telephony?: { messagingServiceSid?: string } }).telephony?.messagingServiceSid).toBe(`MG${'1'.repeat(32)}`)
  })
})

describe('calling rules', () => {
  it('outbound recording can’t be switched on while media auth is off', async () => {
    await db.telephonyAccountState.update({ where: { accountSid: ACCOUNT }, data: { mediaAuthState: 'off' } })
    const res = await as(aAdmin, () => saveCallingRules({ recordOutbound: true, windowStart: 8, windowEnd: 20 }))
    expect(res).toMatchObject({ ok: false, error: 'Recordings are public at Twilio. Turn on HTTP auth for media.' })
    await db.telephonyAccountState.update({ where: { accountSid: ACCOUNT }, data: { mediaAuthState: 'on' } })
    expect(await as(aAdmin, () => saveCallingRules({ recordOutbound: true, windowStart: 9, windowEnd: 19 }))).toEqual({ ok: true })
    expect(await as(aAdmin, () => saveCallingRules({ recordOutbound: false, windowStart: 7, windowEnd: 22 }))).toMatchObject({ ok: false, code: 'BAD_WINDOW' })
  })
})
