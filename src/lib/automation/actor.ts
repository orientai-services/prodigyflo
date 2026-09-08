import 'server-only'
import { db } from '@/lib/db'
import type { SessionUser } from '@/lib/rbac'
import type { PermissionKey } from '@/lib/permissions'

/**
 * Builds a SessionUser for background work (the job runner has no session).
 * The permission set is loaded from the database exactly like getSessionUser,
 * so sendMessage() enforces the same permission + scope + consent gates for an
 * automated send as for a manual one — automation never gets a wider reach
 * than the human it acts for.
 */
export async function loadActor(userId: string | null | undefined): Promise<SessionUser | null> {
  if (!userId) return null

  const user = await db.user.findFirst({
    where: { id: userId, isActive: true, deletedAt: null },
    include: {
      organization: { select: { id: true, name: true } },
      role: { include: { permissions: { include: { permission: true } } } },
      clientPortalLink: { select: { id: true } },
    },
  })
  if (!user) return null

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    organizationId: user.organizationId,
    organizationName: user.organization.name,
    roleId: user.roleId,
    role: user.role.key,
    roleName: user.role.name,
    isOwner: user.isOwner,
    regionId: user.regionId,
    teamId: user.teamId,
    managerId: user.managerId,
    avatarUrl: user.avatarUrl,
    title: user.title,
    permissions: new Set(user.role.permissions.map((rp) => rp.permission.key as PermissionKey)),
    portalClientId: user.clientPortalLink?.id ?? null,
  }
}
