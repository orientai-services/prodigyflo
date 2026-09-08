import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import type { PermissionKey } from '@/lib/permissions'
import type { SessionUser } from '@/lib/rbac'
import { claimOrgSettingsValue, mergeOrgSettings } from '@/lib/org-settings'
import { updateCloseOpsConfig } from '@/lib/closeops'

const stamp = `orgsettings-${Date.now()}`

let orgId: string
let adminId: string

function session(userId: string, organizationId: string, permissions: PermissionKey[]): SessionUser {
  return {
    id: userId,
    name: 'Settings Tester',
    email: `${userId}@example.com`,
    organizationId,
    organizationName: 'Settings Test',
    roleId: 'role',
    role: 'ADMIN',
    roleName: 'Admin',
    isOwner: false,
    regionId: null,
    teamId: null,
    managerId: null,
    avatarUrl: null,
    title: null,
    permissions: new Set(permissions),
    portalClientId: null,
  }
}

async function readSettings(): Promise<Record<string, unknown>> {
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } })
  return (org.settings as Record<string, unknown> | null) ?? {}
}

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: 'Settings Org', slug: stamp } })
  orgId = org.id
  const role = await db.role.create({ data: { organizationId: orgId, key: 'ADMIN', name: 'Admin' } })
  const admin = await db.user.create({
    data: { organizationId: orgId, roleId: role.id, email: `admin.${stamp}@example.com`, passwordHash: 'x', name: 'Ada Admin' },
  })
  adminId = admin.id
})

afterAll(async () => {
  await db.organization.delete({ where: { id: orgId } }).catch(() => {})
})

describe('mergeOrgSettings', () => {
  it('creates the subkey on empty settings', async () => {
    await db.organization.update({ where: { id: orgId }, data: { settings: {} } })
    await mergeOrgSettings(orgId, 'digest', { lastSentWeek: '2026-W33' })
    expect(await readSettings()).toEqual({ digest: { lastSentWeek: '2026-W33' } })
  })

  it('merges into its own subkey without touching sibling keys', async () => {
    await db.organization.update({
      where: { id: orgId },
      data: { settings: { closeOps: { phase: 2, hotLeadThreshold: 75, leakageDays: 7 }, digest: { lastSentWeek: '2026-W30' } } },
    })
    await mergeOrgSettings(orgId, 'digest', { lastSentWeek: '2026-W34' })
    expect(await readSettings()).toEqual({
      closeOps: { phase: 2, hotLeadThreshold: 75, leakageDays: 7 },
      digest: { lastSentWeek: '2026-W34' },
    })
  })

  it('preserves unnamed fields under the merged subkey', async () => {
    await db.organization.update({
      where: { id: orgId },
      data: { settings: { digest: { lastSentWeek: '2026-W30', extra: true } } },
    })
    await mergeOrgSettings(orgId, 'digest', { lastSentWeek: '2026-W34' })
    expect(await readSettings()).toEqual({ digest: { lastSentWeek: '2026-W34', extra: true } })
  })

  it('replaces a non-object subkey instead of erroring', async () => {
    await db.organization.update({ where: { id: orgId }, data: { settings: { digest: 'garbage' } } })
    await mergeOrgSettings(orgId, 'digest', { lastSentWeek: '2026-W34' })
    expect(await readSettings()).toEqual({ digest: { lastSentWeek: '2026-W34' } })
  })
})

describe('claimOrgSettingsValue', () => {
  it('claims once per value: first caller true, repeats false', async () => {
    await db.organization.update({ where: { id: orgId }, data: { settings: {} } })
    expect(await claimOrgSettingsValue(orgId, 'digest', 'lastSentWeek', '2026-W34')).toBe(true)
    expect(await claimOrgSettingsValue(orgId, 'digest', 'lastSentWeek', '2026-W34')).toBe(false)
    expect(await readSettings()).toEqual({ digest: { lastSentWeek: '2026-W34' } })
    // A new week claims again over the stale key.
    expect(await claimOrgSettingsValue(orgId, 'digest', 'lastSentWeek', '2026-W35')).toBe(true)
  })

  it('lets exactly one of many concurrent claimers win (the double-digest race)', async () => {
    await db.organization.update({ where: { id: orgId }, data: { settings: { digest: { lastSentWeek: '2026-W35' } } } })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimOrgSettingsValue(orgId, 'digest', 'lastSentWeek', '2026-W36')),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await readSettings()).toEqual({ digest: { lastSentWeek: '2026-W36' } })
  })

  it('is releasable by merging the field back to null', async () => {
    await db.organization.update({ where: { id: orgId }, data: { settings: {} } })
    expect(await claimOrgSettingsValue(orgId, 'digest', 'lastSentWeek', '2026-W37')).toBe(true)
    await mergeOrgSettings(orgId, 'digest', { lastSentWeek: null })
    expect(await claimOrgSettingsValue(orgId, 'digest', 'lastSentWeek', '2026-W37')).toBe(true)
  })
})

describe('updateCloseOpsConfig (atomic settings write)', () => {
  it('writes the config without clobbering sibling settings keys', async () => {
    await db.organization.update({
      where: { id: orgId },
      data: { settings: { digest: { lastSentWeek: '2026-W34' } } },
    })
    const user = session(adminId, orgId, ['org:manage'])
    const next = await updateCloseOpsConfig(user, { phase: 2, leakageDays: 5 })
    expect(next).toEqual({ phase: 2, hotLeadThreshold: 75, leakageDays: 5 })
    expect(await readSettings()).toEqual({
      digest: { lastSentWeek: '2026-W34' },
      closeOps: { phase: 2, hotLeadThreshold: 75, leakageDays: 5 },
    })
  })
})
