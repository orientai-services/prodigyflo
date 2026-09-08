import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SUBROUTES, navigationFor } from '@/lib/navigation'
import { PERMISSIONS, type PermissionKey } from '@/lib/permissions'
import type { SessionUser } from '@/lib/rbac'

const APP_DIR = path.resolve(__dirname, '../app/(app)')

function pageExists(href: string): boolean {
  return existsSync(path.join(APP_DIR, ...href.split('/').filter(Boolean), 'page.tsx'))
}

/** A minimal, fully-populated SessionUser for pure navigation tests. */
function fixtureUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    name: 'Test User',
    email: 'test@example.com',
    organizationId: 'org-1',
    organizationName: 'Test Org',
    homeOrganizationId: 'org-1',
    organizationKind: 'CLIENT',
    roleId: 'role-1',
    role: 'SUPER_ADMIN',
    roleName: 'Super Admin',
    isOwner: false,
    regionId: null,
    teamId: null,
    managerId: null,
    avatarUrl: null,
    title: null,
    permissions: new Set<PermissionKey>(['users:manage', 'users:read']),
    portalClientId: null,
    ...overrides,
  }
}

const ALL_PERMISSIONS = new Set(Object.keys(PERMISSIONS) as PermissionKey[])

function hrefsOf(user: SessionUser): string[] {
  return navigationFor(user).flatMap((s) => s.items.map((i) => i.href))
}

describe('SUBROUTES', () => {
  it('every href points at an existing page.tsx under src/app/(app)', () => {
    const missing = SUBROUTES.filter((item) => !pageExists(item.href)).map((item) => item.href)

    expect(missing, `stale palette sub-routes (no page.tsx on disk): ${missing.join(', ')}`).toEqual([])
  })

  it('has no duplicate hrefs', () => {
    const hrefs = SUBROUTES.map((i) => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('every entry carries a permission gate or is intentionally open', () => {
    // Every current sub-route sits behind a page gate; a new open route should
    // be a conscious decision, not a forgotten anyOf.
    for (const item of SUBROUTES) {
      expect(item.anyOf?.length ?? 0, `${item.href} has an empty anyOf`).toBeGreaterThan(0)
    }
  })
})

describe('navigationFor', () => {
  it('every sidebar href points at an existing page.tsx under src/app/(app)', () => {
    // A maximally-privileged agency owner sees every entry, so this sweeps
    // the whole SECTIONS list against the filesystem — nav never links a 404.
    const everything = fixtureUser({
      isOwner: true,
      organizationKind: 'AGENCY',
      permissions: ALL_PERMISSIONS,
    })
    const missing = hrefsOf(everything).filter((href) => !pageExists(href))

    expect(missing, `stale nav routes (no page.tsx on disk): ${missing.join(', ')}`).toEqual([])
  })

  it('shows /agency to an agency-home user holding users:manage', () => {
    const user = fixtureUser({ organizationKind: 'AGENCY' })
    expect(hrefsOf(user)).toContain('/agency')
  })

  it('hides /agency from a client-org user even with users:manage', () => {
    const user = fixtureUser({ organizationKind: 'CLIENT' })
    expect(hrefsOf(user)).not.toContain('/agency')
  })

  it('hides /agency when organizationKind is absent (legacy fixtures = CLIENT)', () => {
    const user = fixtureUser({ organizationKind: undefined })
    expect(hrefsOf(user)).not.toContain('/agency')
  })

  it('hides /agency from an agency user without users:manage', () => {
    const user = fixtureUser({
      organizationKind: 'AGENCY',
      permissions: new Set<PermissionKey>(['users:read']),
    })
    expect(hrefsOf(user)).not.toContain('/agency')
  })

  it('agencyOnly stacks on top of permissions like ownerOnly does', () => {
    // Same permissions, only the home-org kind differs — the flag is the gate.
    const agency = fixtureUser({ organizationKind: 'AGENCY' })
    const client = fixtureUser({ organizationKind: 'CLIENT' })
    expect(hrefsOf(agency)).toContain('/agency')
    expect(hrefsOf(client)).not.toContain('/agency')
  })
})
