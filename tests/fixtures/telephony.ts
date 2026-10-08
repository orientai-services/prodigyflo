/**
 * Shared fixtures for the DB-backed telephony tests (tests/telephony-*.test.ts).
 *
 * Nothing here talks to Twilio: requests are signed locally with a TEST token
 * (computeTwilioSignature), the carrier is the mock adapter, and any fetch is
 * stubbed per test. Every org is created per run and deleted (cascading) after.
 */
import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import type { RoleKey } from '@prisma/client'
import { db } from '@/lib/db'
import { loadActor } from '@/lib/automation/actor'
import type { PermissionKey } from '@/lib/permissions'
import type { SessionUser } from '@/lib/rbac'
import { resetTelephonyProvider } from '@/lib/telephony'
import { computeTwilioSignature } from '@/lib/telephony/signature'

export const APP = 'https://www.prodigyflo.ai'
export const ACCOUNT = `AC${'a1'.repeat(16)}`
export const TOKEN = 'test-only-auth-token'
export const OTHER_ACCOUNT = `AC${'b2'.repeat(16)}`
export const OTHER_TOKEN = 'test-only-other-token'

/** Platform env for a test file. Call in beforeAll/beforeEach; vi.unstubAllEnvs() in afterAll. */
export function stubTelephonyEnv(platformOrgId: string, extra: Record<string, string> = {}) {
  vi.stubEnv('APP_URL', APP)
  vi.stubEnv('TWILIO_ACCOUNT_SID', ACCOUNT)
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN)
  vi.stubEnv('TELEPHONY_PROVIDER', 'mock')
  vi.stubEnv('TELEPHONY_PLATFORM_ORG_ID', platformOrgId)
  vi.stubEnv('TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS', '')
  vi.stubEnv('PHONE_HASH_KEY', 'test-only-phone-hash-key-0123456789abcdef')
  vi.stubEnv('TELEPHONY_OVERRIDE_KEY', 'test-only-override-key-0123456789abcdef')
  // Browser calling is off unless a test turns it on.
  for (const k of ['VOICE_BROWSER_ENABLED', 'TWILIO_TWIML_APP_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TELEPHONY_WEBHOOK_HOSTS', 'TWILIO_VOICE_FALLBACK_URL']) {
    vi.stubEnv(k, '')
  }
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v)
  resetTelephonyProvider()
}

/** A run-unique, valid Las Vegas (725) number: never a real subscriber in tests. */
export function testNumber(run: string, n: number): string {
  const h = createHash('sha256').update(`${run}:${n}`).digest()
  const seven = String(2_000_000 + (h.readUInt32BE(0) % 7_999_999)).padStart(7, '0')
  return `+1725${seven}`
}

export async function makeOrg(run: string, name = 'Org') {
  const org = await db.organization.create({ data: { name: `${name} ${run}`, slug: `${run}-${name.toLowerCase().replace(/\W+/g, '-')}` } })
  const pipeline = await db.pipeline.create({ data: { organizationId: org.id, name: 'P', isDefault: true } })
  const intake = await db.pipelineStage.create({ data: { pipelineId: pipeline.id, key: 'NEW_LEAD', name: 'New lead', category: 'INTAKE', position: 0 } })
  const install = await db.pipelineStage.create({
    data: { pipelineId: pipeline.id, key: 'DOCUMENT_COLLECTION', name: 'Document collection', category: 'FULFILLMENT', position: 5 },
  })
  return { orgId: org.id, pipelineId: pipeline.id, intakeStageId: intake.id, fulfillmentStageId: install.id }
}

const CLOSER_SEND: PermissionKey[] = ['communications:send', 'communications:read']

export async function makeUser(
  orgId: string,
  run: string,
  name: string,
  role: RoleKey,
  opts: { phone?: string; permissions?: PermissionKey[] } = {},
): Promise<{ id: string; actor: SessionUser }> {
  const key = role
  let roleRow = await db.role.findFirst({ where: { organizationId: orgId, key } })
  if (!roleRow) roleRow = await db.role.create({ data: { organizationId: orgId, key, name: key } })
  // Admin notifications go to users:manage holders by stored permission rows.
  const perms = opts.permissions ?? (role === 'CLOSER' ? CLOSER_SEND : ['users:manage'])
  for (const permKey of perms) {
    const permission = await db.permission.upsert({ where: { key: permKey }, update: {}, create: { key: permKey, description: permKey, category: 'test' } })
    await db.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: roleRow.id, permissionId: permission.id } },
      update: {},
      create: { roleId: roleRow.id, permissionId: permission.id },
    })
  }
  const user = await db.user.create({
    data: {
      organizationId: orgId,
      roleId: roleRow.id,
      name,
      email: `${name.toLowerCase().replace(/\W+/g, '.')}.${run}@example.test`,
      passwordHash: 'x',
      phone: opts.phone ?? null,
    },
  })
  const actor = await loadActor(user.id)
  if (!actor) throw new Error('actor did not load')
  return { id: user.id, actor: { ...actor, homeOrganizationId: orgId } }
}

export async function makeLine(
  orgId: string,
  e164: string,
  data: Partial<{
    routing: 'FORWARD' | 'TEAM' | 'VOICEMAIL_ONLY'
    forwardTo: string | null
    teamUserIds: string[]
    recordCalls: boolean
    assignedUserId: string | null
    isPrimary: boolean
    ringBrowsers: boolean | null
    friendlyName: string
    provider: string
    providerSid: string
    providerAccountSid: string
  }> = {},
) {
  return db.phoneNumber.create({
    data: {
      organizationId: orgId,
      e164,
      friendlyName: data.friendlyName ?? 'Main line',
      status: 'ACTIVE',
      isPrimary: data.isPrimary ?? true,
      provider: data.provider ?? 'mock',
      providerSid: data.providerSid ?? `PNMOCK${e164.replace(/\D/g, '')}`,
      providerAccountSid: data.providerAccountSid ?? null,
      capabilities: { sms: true, mms: true, voice: true },
      routing: data.routing ?? 'VOICEMAIL_ONLY',
      forwardTo: data.forwardTo ?? null,
      teamUserIds: data.teamUserIds ?? [],
      recordCalls: data.recordCalls ?? false,
      assignedUserId: data.assignedUserId ?? null,
      ringBrowsers: data.ringBrowsers ?? null,
    },
  })
}

/** A Twilio-style form POST to one of our webhook paths, signed with `token` over APP + path. */
export function signedPost(pathAndQuery: string, params: Record<string, string>, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (token) headers['x-twilio-signature'] = computeTwilioSignature(token, `${APP}${pathAndQuery}`, params)
  return new Request(`http://internal.test${pathAndQuery}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  })
}

/** A fake but well-formed Twilio SID with a run-unique tail. */
export function sid(prefix: 'CA' | 'RE' | 'SM' | 'PN' | 'MG', run: string, n: number | string): string {
  const hex = createHash('sha256').update(`${prefix}:${run}:${n}`).digest('hex').slice(0, 32)
  return `${prefix}${hex}`
}
