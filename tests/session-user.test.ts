/**
 * getSessionUser reads the user, organization, role and permission keys in one
 * SQL round trip. These cases pin it to what the Prisma include it replaced
 * returned: same fields, same permission set, same refusals (inactive,
 * deleted, non-staff, unknown id).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ session: null as null | { user: { id: string } } }))
vi.mock('@/lib/auth', () => ({ auth: async () => state.session }))

import type { RoleKey } from '@prisma/client'
import { db } from '@/lib/db'
import { effectivePermissions, isStaffRole, type PermissionKey } from '@/lib/permissions'
import { getSessionUser, loadSessionRow, sessionUserFrom, type SessionUser } from '@/lib/rbac'
import { makeOrg } from './fixtures/telephony'

const run = `sess-${Date.now().toString(36)}`
let orgId = ''
const ids: Record<string, string> = {}

/** The Prisma include getSessionUser used before the single query. */
async function viaInclude(userId: string): Promise<SessionUser | null> {
  const user = await db.user.findFirst({
    where: { id: userId, isActive: true, deletedAt: null },
    include: {
      organization: { select: { id: true, name: true, kind: true, slug: true } },
      role: { include: { permissions: { include: { permission: true } } } },
    },
  })
  if (!user || !isStaffRole(user.role.key)) return null
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    organizationId: user.organizationId,
    organizationName: user.organization.name,
    organizationSlug: user.organization.slug,
    homeOrganizationId: user.organizationId,
    organizationKind: 'CLIENT',
    roleId: user.roleId,
    role: user.role.key,
    roleName: user.role.name,
    isOwner: user.role.key === 'SUPER_ADMIN',
    regionId: null,
    teamId: user.teamId,
    managerId: null,
    avatarUrl: user.avatarUrl,
    title: user.title,
    permissions: effectivePermissions(user.role.key, user.role.permissions.map((rp) => rp.permission.key as PermissionKey)),
    portalClientId: null,
    landingPath: null,
  }
}

function comparable(user: SessionUser | null) {
  return user ? { ...user, permissions: [...user.permissions].sort() } : null
}

async function role(key: RoleKey, name: string, permissions: string[]) {
  const row = await db.role.create({ data: { organizationId: orgId, key, name } })
  for (const permKey of permissions) {
    const permission = await db.permission.upsert({ where: { key: permKey }, update: {}, create: { key: permKey, description: permKey, category: 'test' } })
    await db.rolePermission.create({ data: { roleId: row.id, permissionId: permission.id } })
  }
  return row.id
}

async function user(label: string, roleId: string, extra: { isActive?: boolean; deletedAt?: Date; avatarUrl?: string; title?: string } = {}) {
  const row = await db.user.create({
    data: { organizationId: orgId, roleId, name: `${label} ${run}`, email: `${label}.${run}@example.test`, passwordHash: 'x', ...extra },
  })
  ids[label] = row.id
}

beforeAll(async () => {
  orgId = (await makeOrg(run, 'Session')).orgId
  const admin = await role('SUPER_ADMIN', 'Super Admin', ['users:manage'])
  const closer = await role('CLOSER', 'Closer', ['communications:send', 'communications:read', 'clients:read_assigned', 'users:manage'])
  // ADMIN is not a staff role: it never gets a session.
  const bare = await role('ADMIN', 'Admin', [])
  const client = await role('CLIENT', 'Client', ['clients:read_assigned'])
  await user('admin', admin, { avatarUrl: '/a.png', title: 'Owner' })
  await user('closer', closer)
  await user('bare', bare)
  await user('client', client)
  await user('inactive', closer, { isActive: false })
  await user('deleted', closer, { deletedAt: new Date() })
})

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: orgId } })
})

describe('getSessionUser', () => {
  it('returns exactly what the Prisma include returned, for every kind of user', async () => {
    for (const [label, id] of Object.entries(ids)) {
      const row = await loadSessionRow(id)
      const fast = row ? sessionUserFrom(row) : null
      expect(comparable(fast), label).toEqual(comparable(await viaInclude(id)))
      state.session = { user: { id } }
      expect(comparable(await getSessionUser()), label).toEqual(comparable(await viaInclude(id)))
    }
  })

  it('refuses inactive, deleted, non-staff and unknown users', async () => {
    for (const label of ['inactive', 'deleted', 'client', 'bare']) {
      state.session = { user: { id: ids[label] } }
      expect(await getSessionUser(), label).toBeNull()
    }
    state.session = { user: { id: 'no-such-user' } }
    expect(await getSessionUser()).toBeNull()
    state.session = null
    expect(await getSessionUser()).toBeNull()
  })

  it('keeps the role rules: a closer only holds editable keys, a super admin holds all', async () => {
    state.session = { user: { id: ids.closer } }
    const closer = await getSessionUser()
    expect(closer?.permissions.has('communications:send')).toBe(true)
    expect(closer?.permissions.has('users:manage')).toBe(false)
    state.session = { user: { id: ids.admin } }
    const admin = await getSessionUser()
    expect(admin).toMatchObject({ isOwner: true, avatarUrl: '/a.png', title: 'Owner', organizationSlug: `${run}-session` })
    expect(admin?.permissions.has('telephony:manage')).toBe(true)
  })
})
