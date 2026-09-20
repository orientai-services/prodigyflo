import 'server-only'
import { cache } from 'react'
import { headers } from 'next/headers'
import { staffRouteAllowed } from '@/lib/staff-routes'
import { redirect } from 'next/navigation'
import type { Prisma, RoleKey } from '@prisma/client'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { effectivePermissions, isStaffRole, type PermissionKey } from '@/lib/permissions'

export type SessionUser = {
  id: string
  name: string
  email: string
  /** The single workspace this staff identity belongs to. */
  organizationId: string
  organizationName: string
  /**
   * Slug of the ACTIVE organization. Optional so the many test fixtures that
   * build a SessionUser by hand keep compiling; every real session sets it.
   * Branding reads this rather than the name, which users can edit.
   */
  organizationSlug?: string
  /** Compatibility fields for retained historical modules; organization switching is retired. */
  homeOrganizationId?: string
  organizationKind?: string
  roleId: string
  role: RoleKey
  roleName: string
  /** Compatibility alias derived from Super Admin role; never a separate authority. */
  isOwner: boolean
  regionId: string | null
  teamId: string | null
  managerId: string | null
  avatarUrl: string | null
  title: string | null
  permissions: Set<PermissionKey>
  /** Retained type compatibility; always null for active staff. */
  portalClientId: string | null
  /** Retained type compatibility; active staff always land on Board. */
  landingPath?: string | null
}

export class ForbiddenError extends Error {
  constructor(message = 'You do not have permission to perform this action.') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

/**
 * Loads the signed-in user with role and permissions straight from the database.
 * `cache` dedupes it within a single request, so calling it from a layout, a page
 * and three server components costs one query.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return null

  const user = await db.user.findFirst({
    where: { id: userId, isActive: true, deletedAt: null },
    include: {
      // `slug` is the per-account branding key — see components/brand/org-brand.
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
})

/** Redirects to /login when signed out. Use in every protected layout and page. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) redirect('/login')
  const pathname = (await headers()).get('x-prodigy-path')
  if (pathname && !staffRouteAllowed(user.role, pathname)) {
    if (pathname.startsWith('/api/')) throw new ForbiddenError()
    redirect('/forbidden')
  }
  return user
}

export function can(user: SessionUser, permission: PermissionKey): boolean {
  return effectivePermissions(user.role, user.permissions).has(permission)
}

export function canAny(user: SessionUser, permissions: PermissionKey[]): boolean {
  return permissions.some((p) => can(user, p))
}

/** Throws ForbiddenError — for server actions and route handlers. */
export async function requirePermission(permission: PermissionKey): Promise<SessionUser> {
  const user = await requireUser()
  if (!can(user, permission)) throw new ForbiddenError()
  return user
}

/** Redirects to /forbidden — for pages, where an exception would be a poor UX. */
export async function requirePermissionPage(permission: PermissionKey): Promise<SessionUser> {
  const user = await requireUser()
  if (!can(user, permission)) redirect('/forbidden')
  return user
}

/**
 * The single source of truth for "which clients may this user see".
 *
 * Always spread this into a Prisma `where`; never query Client without it.
 * Ordering matters: the broadest permission the user holds wins, and every
 * branch is additionally constrained to the user's own organization.
 */
export function clientScope(user: SessionUser): Prisma.ClientWhereInput {
  const base: Prisma.ClientWhereInput = {
    organizationId: user.organizationId,
    deletedAt: null,
  }

  if (user.role === 'SUPER_ADMIN') return base
  // The current owner is authoritative; historical Assignment rows grant nothing.
  if (user.role === 'CLOSER') return { ...base, ownerId: user.id }
  return { ...base, id: '__none__' }
}

/** Loads one client inside the caller's scope, or null when out of reach. */
export async function findClientInScope<T extends Prisma.ClientInclude>(
  user: SessionUser,
  clientId: string,
  include?: T,
) {
  return db.client.findFirst({
    where: { AND: [clientScope(user), { id: clientId }] },
    ...(include ? { include } : {}),
  })
}

/** Same, but redirects when the client is missing or out of scope. */
export async function requireClientInScope(user: SessionUser, clientId: string) {
  const client = await findClientInScope(user, clientId)
  if (!client) redirect('/forbidden')
  return client
}

/** Which users this user may see, for assignment pickers and roster views. */
export function userScope(user: SessionUser): Prisma.UserWhereInput {
  const base: Prisma.UserWhereInput = { organizationId: user.organizationId, deletedAt: null }

  return user.role === 'SUPER_ADMIN' ? base : { ...base, id: user.id }
}

/** True when the viewer is allowed to see staff-only content on a client record. */
export function canSeeInternal(user: SessionUser): boolean {
  return can(user, 'communications:read_internal')
}
