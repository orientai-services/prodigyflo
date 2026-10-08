import { vi } from 'vitest'
import { db } from '@/lib/db'
import type { SessionUser } from '@/lib/rbac'
import type { PermissionKey } from '@/lib/permissions'
import { ALLOWED_ACCOUNT, FOREIGN_ACCOUNT, IDS } from './ids'

export async function makeOrg(tag: string) {
  const org = await db.organization.create({ data: { name: `Org ${tag}`, slug: tag } })
  const pipeline = await db.pipeline.create({ data: { organizationId: org.id, name: 'P', isDefault: true } })
  await db.pipelineStage.create({ data: { pipelineId: pipeline.id, key: 'NEW_LEAD', name: 'New', category: 'INTAKE', position: 0 } })
  return org
}

/** A real Super Admin row, for code paths that reference the actor (createdById, actorId). */
export async function makeAdmin(orgId: string): Promise<string> {
  const role = await db.role.create({ data: { organizationId: orgId, key: 'SUPER_ADMIN', name: 'Super Admin' } })
  const user = await db.user.create({ data: { organizationId: orgId, roleId: role.id, email: `admin-${orgId}@example.test`, passwordHash: 'x', name: 'Ads Admin' } })
  return user.id
}

export function sessionFor(
  orgId: string,
  permissions: PermissionKey[] = ['connectors:read', 'connectors:manage'],
  role: SessionUser['role'] = 'SUPER_ADMIN',
  userId = `user_${orgId}`,
): SessionUser {
  return {
    id: userId,
    name: 'Ads Tester',
    email: `ads-${orgId}@example.test`,
    organizationId: orgId,
    organizationName: 'Ads Test',
    roleId: 'role',
    role,
    roleName: role,
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

/** Live ads env for a bound workspace (all values fake). */
export function stubLiveEnv(orgId: string, over: Record<string, string> = {}) {
  const vars: Record<string, string> = {
    META_ADS_ORG_ID: orgId,
    META_ALLOWED_AD_ACCOUNTS: ALLOWED_ACCOUNT,
    META_ADS_APP_ID: 'ads-app-1',
    META_ADS_APP_SECRET: 'test-ads-secret-not-real',
    META_ADS_SYSTEM_USER_TOKEN: 'TEST-ADS-TOKEN-not-real',
    META_GRAPH_VERSION: 'v25.0',
    ...over,
  }
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
}

/** The approved account row is unique across workspaces: clear leftovers from a crashed run. */
export async function clearSharedRows() {
  await db.metaAdAccount.deleteMany({ where: { adAccountId: { in: [ALLOWED_ACCOUNT, FOREIGN_ACCOUNT] } } })
  await db.metaObjectAccount.deleteMany({ where: { objectId: { in: Object.values(IDS) } } })
}
