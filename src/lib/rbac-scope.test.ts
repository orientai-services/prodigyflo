import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@/lib/rbac'
import { clientScope } from '@/lib/rbac'

function session(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'u1',
    name: 'Test',
    email: 'test@example.com',
    organizationId: 'org-scs',
    organizationName: 'Team Prodigy',
    roleId: 'r1',
    role: 'ADMIN',
    roleName: 'Admin',
    isOwner: false,
    regionId: null,
    teamId: 'team-a',
    managerId: null,
    avatarUrl: null,
    title: null,
    permissions: new Set(),
    portalClientId: null,
    ...overrides,
  }
}

describe('clientScope', () => {
  it('lets ADMIN see every client in their org even with a teamId and without read_all', () => {
    const where = clientScope(session({ role: 'ADMIN', teamId: 'team-a', permissions: new Set(['clients:read_team']) }))
    expect(where).toEqual({ organizationId: 'org-scs', deletedAt: null })
    expect(where).not.toHaveProperty('OR')
  })

  it('lets SUPER_ADMIN see every client in their org', () => {
    const where = clientScope(session({ role: 'SUPER_ADMIN', teamId: 'team-a', permissions: new Set(['clients:read_team']) }))
    expect(where).toEqual({ organizationId: 'org-scs', deletedAt: null })
  })

  it('does not open another organization', () => {
    const where = clientScope(session({ organizationId: 'org-scs', role: 'ADMIN' }))
    expect(where.organizationId).toBe('org-scs')
    expect(where.organizationId).not.toBe('org-other')
  })

  it('still team-scopes a manager who is not an org admin', () => {
    const where = clientScope(
      session({ role: 'SALES_MANAGER', permissions: new Set(['clients:read_team']), teamId: 'team-a' }),
    )
    expect(where.organizationId).toBe('org-scs')
    expect(where.OR).toEqual(
      expect.arrayContaining([expect.objectContaining({ teamId: 'team-a' })]),
    )
  })
})
