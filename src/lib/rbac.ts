import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { Prisma, RoleKey } from '@prisma/client'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { ORG_SWITCH_COOKIE, verifyOrgSwitchGrant } from '@/lib/org-switch'
import type { PermissionKey } from '@/lib/permissions'

export type SessionUser = {
  id: string
  name: string
  email: string
  /**
   * The organization the user is CURRENTLY working in. Normally the org the
   * user row belongs to; for agency users holding a valid org-switch grant it
   * is the chosen child account instead. Every query that scopes by
   * organizationId therefore follows the switch automatically.
   */
  organizationId: string
  organizationName: string
  /**
   * Slug of the ACTIVE organization. Optional so the many test fixtures that
   * build a SessionUser by hand keep compiling; every real session sets it.
   * Branding reads this rather than the name, which users can edit.
   */
  organizationSlug?: string
  /**
   * The organization the user's row actually lives in — always their agency
   * (or standalone) org, never affected by switching. Use it when the HOME
   * identity matters: the agency console, the switcher, audit attribution.
   * getSessionUser always sets it; optional only so pre-existing test
   * fixtures that build SessionUser literals stay valid. Treat absence as
   * "same as organizationId".
   */
  homeOrganizationId?: string
  /**
   * Kind of the HOME organization ('AGENCY' | 'CLIENT'). Deliberately the
   * home org's kind, not the active one: it answers "is this an agency user
   * who may switch?", which must not change while visiting a client account.
   * getSessionUser always sets it; optional for fixtures, absence = CLIENT.
   */
  organizationKind?: string
  roleId: string
  role: RoleKey
  roleName: string
  /** True owner of the organization. Never surfaced in the UI — reads as Super Admin. */
  isOwner: boolean
  regionId: string | null
  teamId: string | null
  managerId: string | null
  avatarUrl: string | null
  title: string | null
  permissions: Set<PermissionKey>
  /** Set only for CLIENT-role users: the client record they own. */
  portalClientId: string | null
  /** Optional post-login landing override; falls back to ROLE_HOME. */
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
      clientPortalLink: { select: { id: true } },
    },
  })
  if (!user) return null

  // ── agency org switch ──────────────────────────────────────
  // A valid `pf-active-org` grant lets a user whose HOME org is an AGENCY
  // work inside one of its direct, non-deleted child accounts: the session's
  // organizationId/organizationName flip to the target, and the org-local
  // anchors (region/team/manager/portal link) are nulled because they belong
  // to the home org and would be dangling references in the target.
  //
  // Role and permissions deliberately still resolve from the HOME org role:
  // the child account has no Role row for this user, and the agency's
  // authority is what admits them — an agency admin acts as an admin wherever
  // they go. With region/team null, their base `clients:read_all` scope
  // applies cleanly inside the target org via clientScope().
  //
  // Absent, expired, forged, self-targeted, or ineligible cookies all fall
  // through silently — byte-identical to pre-switch behavior.
  let activeOrg: { id: string; name: string; slug: string } = {
    id: user.organizationId,
    name: user.organization.name,
    slug: user.organization.slug,
  }
  let switched = false
  if (user.organization.kind === 'AGENCY') {
    const token = (await cookies()).get(ORG_SWITCH_COOKIE)?.value
    const grant = token ? verifyOrgSwitchGrant(token) : null
    if (grant && grant.uid === user.id && grant.orgId !== user.organizationId) {
      const target = await db.organization.findFirst({
        where: { id: grant.orgId, deletedAt: null, parentOrganizationId: user.organizationId },
        select: { id: true, name: true, slug: true },
      })
      if (target) {
        activeOrg = target
        switched = true
      }
    }
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    organizationId: activeOrg.id,
    organizationName: activeOrg.name,
    organizationSlug: activeOrg.slug,
    homeOrganizationId: user.organizationId,
    organizationKind: user.organization.kind,
    roleId: user.roleId,
    role: user.role.key,
    roleName: user.role.name,
    isOwner: user.isOwner,
    regionId: switched ? null : user.regionId,
    teamId: switched ? null : user.teamId,
    managerId: switched ? null : user.managerId,
    avatarUrl: user.avatarUrl,
    title: user.title,
    permissions: new Set(user.role.permissions.map((rp) => rp.permission.key as PermissionKey)),
    portalClientId: switched ? null : (user.clientPortalLink?.id ?? null),
    landingPath: user.landingPath ?? null,
  }
})

/** Redirects to /login when signed out. Use in every protected layout and page. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) redirect('/login')
  return user
}

export function can(user: SessionUser, permission: PermissionKey): boolean {
  return user.permissions.has(permission)
}

export function canAny(user: SessionUser, permissions: PermissionKey[]): boolean {
  return permissions.some((p) => user.permissions.has(p))
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

  if (user.permissions.has('clients:read_all')) return base

  if (user.permissions.has('clients:read_region')) {
    return {
      ...base,
      OR: [
        { regionId: user.regionId },
        { ownerId: user.id },
        { team: { regionId: user.regionId } },
      ],
    }
  }

  if (user.permissions.has('clients:read_team')) {
    return {
      ...base,
      OR: [
        { teamId: user.teamId },
        { ownerId: user.id },
        { owner: { managerId: user.id } },
        { team: { managerId: user.id } },
      ],
    }
  }

  if (user.role === 'DOCUMENT_COLLECTOR') {
    // Collectors reach a client only through a document assigned to them.
    return { ...base, documents: { some: { collectorId: user.id } } }
  }

  if (user.permissions.has('clients:read_assigned')) {
    return {
      ...base,
      OR: [
        { ownerId: user.id },
        { assignments: { some: { assigneeId: user.id, isActive: true } } },
      ],
    }
  }

  if (user.role === 'CLIENT') {
    return { ...base, portalUserId: user.id }
  }

  // No client-read permission at all — match nothing.
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

  if (user.permissions.has('clients:read_all')) return base
  if (user.permissions.has('clients:read_region')) return { ...base, regionId: user.regionId }
  if (user.permissions.has('clients:read_team')) {
    return { ...base, OR: [{ teamId: user.teamId }, { managerId: user.id }, { id: user.id }] }
  }
  return { ...base, id: user.id }
}

/** True when the viewer is allowed to see staff-only content on a client record. */
export function canSeeInternal(user: SessionUser): boolean {
  return user.role !== 'CLIENT' && user.permissions.has('communications:read_internal')
}
