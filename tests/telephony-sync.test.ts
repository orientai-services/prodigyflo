/**
 * Number sync on a SHARED carrier account (docs/TELEPHONY_LIVE.md §4.4): only
 * the platform owner syncs the platform account, only assigned sid → org pairs
 * are imported or repointed, a number on another org's row is never moved,
 * imports cost nothing, and a second run changes nothing. An org on its own
 * vault Twilio syncs only into itself. The carrier is the mock adapter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ actor: null as unknown }))
vi.mock('@/lib/rbac', async (orig) => ({
  ...(await orig<typeof import('@/lib/rbac')>()),
  requireUser: async () => state.actor,
  getSessionUser: async () => state.actor,
}))

import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { applyNumberSync, previewNumberSync, setNumberAssignment } from '@/lib/telephony/actions'
import { getMockOwnedNumbers, setMockOwnedNumbers } from '@/lib/telephony/mock'
import { repointByDefault, syncNumbersForScript } from '@/lib/telephony/number-sync'
import type { OwnedNumber } from '@/lib/telephony/provider'
import type { SyncPreviewVM, SyncResultVM } from '@/lib/telephony/voice-contract'
import { APP, OTHER_ACCOUNT, OTHER_TOKEN, makeOrg, makeUser, sid, stubTelephonyEnv, testNumber } from './fixtures/telephony'

const run = `tsync-${Date.now().toString(36)}`
type User = Awaited<ReturnType<typeof makeUser>>
let P = ''
let A = ''
let B = ''
let V = ''
let owner: User
let aAdmin: User
let vAdmin: User

const num = (i: number, voiceUrl: string | null = null): OwnedNumber => ({
  sid: sid('PN', run, i),
  e164: testNumber(run, i),
  friendlyName: `Line ${i}`,
  capabilities: { voice: true, sms: true, mms: false },
  voiceUrl,
  smsUrl: null,
  statusCallback: null,
  voiceFallbackUrl: null,
  dateCreated: null,
})
const N = {
  newForA: num(1),
  hereInB: num(2, `${APP}/api/telephony/voice`),
  rowInA_assignedB: num(3),
  releasedInB: num(4),
  unassigned: num(5),
  foreignHost: num(6, 'https://other-app.example.com/voice'),
}

async function as<T>(user: User, fn: () => Promise<T>): Promise<T> {
  state.actor = user.actor
  return fn()
}

beforeAll(async () => {
  P = (await makeOrg(run, 'Platform')).orgId
  A = (await makeOrg(run, 'A')).orgId
  B = (await makeOrg(run, 'B')).orgId
  V = (await makeOrg(run, 'Vault')).orgId
  stubTelephonyEnv(P)
  owner = await makeUser(P, run, 'Platform Owner', 'SUPER_ADMIN')
  aAdmin = await makeUser(A, run, 'A Admin', 'SUPER_ADMIN')
  vAdmin = await makeUser(V, run, 'V Admin', 'SUPER_ADMIN')

  // B already has N2 (active) and N4 (released); A has N3.
  const row = (orgId: string, n: OwnedNumber, status: 'ACTIVE' | 'RELEASED') =>
    db.phoneNumber.create({ data: { organizationId: orgId, e164: n.e164, friendlyName: n.friendlyName, status, provider: 'mock', providerSid: n.sid } })
  await row(B, N.hereInB, 'ACTIVE')
  await row(B, N.releasedInB, 'RELEASED')
  await row(A, N.rowInA_assignedB, 'ACTIVE')

  // Org V brought its own Twilio.
  const connector = await db.connector.create({ data: { organizationId: V, kind: 'TWILIO_SMS', name: 'Twilio SMS', isEnabled: true } })
  for (const [fieldKey, value] of Object.entries({ accountSid: OTHER_ACCOUNT, authToken: OTHER_TOKEN })) {
    await db.connectorCredential.create({ data: { organizationId: V, connectorId: connector.id, fieldKey, ...encryptSecret(value) } })
  }
})

beforeEach(() => {
  stubTelephonyEnv(P)
  setMockOwnedNumbers(Object.values(N))
})

afterAll(async () => {
  vi.unstubAllEnvs()
  setMockOwnedNumbers([])
  await db.organization.deleteMany({ where: { id: { in: [P, A, B, V] } } })
})

describe('the shared platform account', () => {
  it('an org’s own SUPER_ADMIN is refused and sees no rows', async () => {
    const preview = await as(aAdmin, () => previewNumberSync())
    expect(preview).toMatchObject({ ok: false, code: 'PLATFORM_ONLY' })
    expect(JSON.stringify(preview)).not.toContain(N.hereInB.e164.slice(-4))
    const applied = await as(aAdmin, () => applyNumberSync({ importSids: [N.newForA.sid], repointSids: [N.newForA.sid] }))
    expect(applied).toMatchObject({ ok: false })
    expect(await db.phoneNumber.count({ where: { e164: N.newForA.e164 } })).toBe(0)
    expect(await as(aAdmin, () => setNumberAssignment({ sid: N.newForA.sid, organizationId: A }))).toMatchObject({ ok: false })
  })

  it('nobody is platform owner when TELEPHONY_PLATFORM_ORG_ID is unset', async () => {
    vi.stubEnv('TELEPHONY_PLATFORM_ORG_ID', '')
    expect(await as(owner, () => previewNumberSync())).toMatchObject({ ok: false, error: "Platform owner isn't configured." })
  })

  it('the platform owner assigns numbers, then sees every state', async () => {
    for (const [n, org] of [
      [N.newForA, A],
      [N.hereInB, B],
      [N.rowInA_assignedB, B],
      [N.releasedInB, B],
      [N.foreignHost, A],
    ] as const) {
      expect(await as(owner, () => setNumberAssignment({ sid: n.sid, organizationId: org }))).toEqual({ ok: true })
    }
    const preview = (await as(owner, () => previewNumberSync())) as SyncPreviewVM
    const bySid = new Map(preview.rows.map((r) => [r.sid, r]))
    expect(preview.platform).toBe(true)
    expect(bySid.get(N.newForA.sid)).toMatchObject({ state: 'new', assignedOrg: { id: A } })
    expect(bySid.get(N.hereInB.sid)).toMatchObject({ state: 'here', pointsHere: true })
    expect(bySid.get(N.rowInA_assignedB.sid)).toMatchObject({ state: 'other-account' })
    expect(bySid.get(N.releasedInB.sid)).toMatchObject({ state: 'released-here' })
    expect(bySid.get(N.unassigned.sid)).toMatchObject({ state: 'unassigned', assignedOrg: null })
    expect(bySid.get(N.foreignHost.sid)).toMatchObject({ state: 'new', voiceUrlHost: 'other-app.example.com', pointsHere: false })
    expect(bySid.get(N.newForA.sid)?.display).toContain(N.newForA.e164.slice(-4))
  })

  it('repoint is pre-ticked only for numbers pointing nowhere or already here', () => {
    expect(repointByDefault(N.newForA)).toBe(true)
    expect(repointByDefault(N.hereInB)).toBe(true)
    expect(repointByDefault(N.foreignHost)).toBe(false)
  })

  it('imports only assigned pairs, never moves another org’s number, charges nothing', async () => {
    const all = Object.values(N).map((n) => n.sid)
    const result = (await as(owner, () => applyNumberSync({ importSids: all, repointSids: [N.newForA.sid] }))) as SyncResultVM
    expect(result.imported).toBe(3) // newForA, releasedInB, foreignHost
    expect(result.repointed).toBe(1)
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.sid, s.reason]))
    expect(reasons[N.unassigned.sid]).toBe('Assign to an account first.')
    expect(reasons[N.rowInA_assignedB.sid]).toContain('Not changed')

    const imported = await db.phoneNumber.findUniqueOrThrow({ where: { e164: N.newForA.e164 } })
    expect(imported).toMatchObject({
      organizationId: A,
      status: 'ACTIVE',
      routing: 'VOICEMAIL_ONLY',
      ringBrowsers: null,
      providerSid: N.newForA.sid,
      providerAccountSid: `AC${'a1'.repeat(16)}`,
    })
    expect(imported.importedAt).not.toBeNull()
    expect((await db.phoneNumber.findUniqueOrThrow({ where: { e164: N.releasedInB.e164 } })).status).toBe('ACTIVE')
    expect((await db.phoneNumber.findUniqueOrThrow({ where: { e164: N.rowInA_assignedB.e164 } })).organizationId).toBe(A)
    expect(await db.phoneNumber.count({ where: { e164: N.unassigned.e164 } })).toBe(0)
    expect(await db.walletEntry.count({ where: { organizationId: { in: [A, B] } } })).toBe(0)
    // Repointed at the carrier (the mock's registry), foreign host untouched.
    const reg = new Map(getMockOwnedNumbers().map((x) => [x.sid, x]))
    expect(reg.get(N.newForA.sid)?.voiceUrl).toBe(`${APP}/api/telephony/voice`)
    expect(reg.get(N.foreignHost.sid)?.voiceUrl).toBe('https://other-app.example.com/voice')
  })

  it('a second run changes nothing', async () => {
    const all = Object.values(N).map((n) => n.sid)
    const again = (await as(owner, () => applyNumberSync({ importSids: all, repointSids: [] }))) as SyncResultVM
    expect(again).toMatchObject({ imported: 0, updated: 0, repointed: 0 })
  })

  it('the script in dry run writes nothing', async () => {
    const extra = num(7)
    setMockOwnedNumbers([...Object.values(N), extra])
    await as(owner, () => setNumberAssignment({ sid: extra.sid, organizationId: A }))
    const out = await syncNumbersForScript({ execute: false, repoint: true })
    expect(out.ok).toBe(true)
    if (out.ok && 'wouldImport' in out) expect(out.wouldImport).toContain(extra.sid)
    expect(await db.phoneNumber.count({ where: { e164: extra.e164 } })).toBe(0)
    const executed = await syncNumbersForScript({ execute: true, repoint: false })
    expect(executed.ok).toBe(true)
    expect((await db.phoneNumber.findUniqueOrThrow({ where: { e164: extra.e164 } })).organizationId).toBe(A)
  })
})

describe('an org on its own Twilio (vault)', () => {
  it('its own manager syncs into that org only', async () => {
    const own = num(20)
    setMockOwnedNumbers([own])
    const preview = (await as(vAdmin, () => previewNumberSync())) as SyncPreviewVM
    expect(preview.platform).toBe(false)
    expect(preview.rows).toHaveLength(1)
    expect(preview.rows[0]).toMatchObject({ state: 'new' })
    const result = (await as(vAdmin, () => applyNumberSync({ importSids: [own.sid], repointSids: [] }))) as SyncResultVM
    expect(result.imported).toBe(1)
    expect(await db.phoneNumber.findUniqueOrThrow({ where: { e164: own.e164 } })).toMatchObject({ organizationId: V, providerAccountSid: OTHER_ACCOUNT })
  })

  it('the platform owner cannot reach into it either (not their account)', async () => {
    setMockOwnedNumbers([num(21)])
    expect(await as(owner, () => previewNumberSync(V))).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})
