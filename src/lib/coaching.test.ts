import { describe, expect, it } from 'vitest'
import type { PermissionKey } from '@/lib/permissions'
import type { SessionUser } from '@/lib/rbac'
import {
  briefStatus,
  canCoach,
  coachingRollups,
  coachingVisibleWhere,
  probabilityTier,
  salesLevel,
} from '@/lib/coaching'

function session(permissions: PermissionKey[], overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'u1',
    name: 'Test Closer',
    email: 'closer@example.com',
    organizationId: 'org1',
    organizationName: 'Org',
    roleId: 'role1',
    role: 'CLOSER',
    roleName: 'Closer',
    isOwner: false,
    regionId: null,
    teamId: 'team1',
    managerId: null,
    avatarUrl: null,
    title: null,
    permissions: new Set(permissions),
    portalClientId: null,
    ...overrides,
  }
}

describe('salesLevel', () => {
  it('returns the broadest analytics grant held', () => {
    expect(salesLevel(session(['analytics:org', 'analytics:self']))).toBe('org')
    expect(salesLevel(session(['analytics:region']))).toBe('region')
    expect(salesLevel(session(['analytics:team', 'analytics:self']))).toBe('team')
  })

  it('admits a closer with only analytics:self', () => {
    expect(salesLevel(session(['analytics:self']))).toBe('self')
  })

  it('rejects users with no analytics permission at all', () => {
    expect(salesLevel(session([]))).toBeNull()
    expect(salesLevel(session(['clients:read_assigned']))).toBeNull()
  })
})

describe('probabilityTier', () => {
  it('grades hotter probabilities into stronger tiers', () => {
    expect(probabilityTier(100)).toBe('scorching')
    expect(probabilityTier(95)).toBe('scorching')
    expect(probabilityTier(94.9)).toBe('hot')
    expect(probabilityTier(90)).toBe('hot')
    expect(probabilityTier(89.9)).toBe('warm')
    expect(probabilityTier(80)).toBe('warm')
  })
})

describe('briefStatus', () => {
  const t = new Date('2026-08-01T00:00:00Z')

  it('is none without a brief', () => {
    expect(briefStatus(null, null)).toBe('none')
  })

  it('is generated when a brief exists unread', () => {
    expect(briefStatus(t, null)).toBe('generated')
  })

  it('is viewed once someone opened it', () => {
    expect(briefStatus(t, t)).toBe('viewed')
  })
})

describe('coachingRollups', () => {
  const now = new Date('2026-08-24T12:00:00Z')
  const thisMonth = new Date('2026-08-10T09:00:00Z')
  const lastMonth = new Date('2026-07-10T09:00:00Z')

  it('averages CALL_QA scores to one decimal and ignores 1-on-1s', () => {
    const rollups = coachingRollups(
      [
        { subjectId: 'a', kind: 'CALL_QA', score: 7, createdAt: lastMonth },
        { subjectId: 'a', kind: 'CALL_QA', score: 8, createdAt: thisMonth },
        { subjectId: 'a', kind: 'CALL_QA', score: 8, createdAt: thisMonth },
        { subjectId: 'a', kind: 'ONE_ON_ONE', score: null, createdAt: thisMonth },
      ],
      now,
    )
    const a = rollups.get('a')!
    expect(a.qaCount).toBe(3)
    expect(a.qaAvg).toBe(7.7)
    expect(a.total).toBe(4)
  })

  it('counts only this calendar month toward monthCount', () => {
    const rollups = coachingRollups(
      [
        { subjectId: 'b', kind: 'ONE_ON_ONE', score: null, createdAt: thisMonth },
        { subjectId: 'b', kind: 'CALL_QA', score: 5, createdAt: lastMonth },
      ],
      now,
    )
    expect(rollups.get('b')!.monthCount).toBe(1)
    expect(rollups.get('b')!.total).toBe(2)
  })

  it('keeps qaAvg null when a subject has no scored calls', () => {
    const rollups = coachingRollups(
      [{ subjectId: 'c', kind: 'ONE_ON_ONE', score: null, createdAt: thisMonth }],
      now,
    )
    expect(rollups.get('c')!.qaAvg).toBeNull()
    expect(rollups.get('c')!.qaCount).toBe(0)
  })

  it('separates subjects', () => {
    const rollups = coachingRollups(
      [
        { subjectId: 'a', kind: 'CALL_QA', score: 10, createdAt: thisMonth },
        { subjectId: 'b', kind: 'CALL_QA', score: 2, createdAt: thisMonth },
      ],
      now,
    )
    expect(rollups.get('a')!.qaAvg).toBe(10)
    expect(rollups.get('b')!.qaAvg).toBe(2)
  })
})

describe('coaching visibility', () => {
  it('canCoach requires the roster permission plus team-level analytics or better', () => {
    expect(canCoach(session(['users:read', 'analytics:team']))).toBe(true)
    expect(canCoach(session(['users:read', 'analytics:region']))).toBe(true)
    expect(canCoach(session(['users:read', 'analytics:org']))).toBe(true)
    expect(canCoach(session(['users:read', 'analytics:self']))).toBe(false)
    expect(canCoach(session(['users:read']))).toBe(false)
    expect(canCoach(session([]))).toBe(false)
  })

  it('analytics breadth alone never grants coaching — MARKETING stays out', () => {
    // MARKETING's real grant set: wide analytics, no roster access.
    const marketing = ['analytics:marketing', 'analytics:org', 'connectors:read', 'clients:read_all']
    expect(canCoach(session(marketing as PermissionKey[]))).toBe(false)
  })

  it('pins every query to the organization', () => {
    const where = coachingVisibleWhere(session(['analytics:self']))
    expect(where.organizationId).toBe('org1')
  })

  it('limits a closer to notes they wrote or that are about them', () => {
    const where = coachingVisibleWhere(session(['analytics:self']))
    expect(where.OR).toEqual([{ subjectId: 'u1' }, { authorId: 'u1' }])
  })

  it('limits MARKETING (org analytics, no roster) to notes they wrote or that are about them', () => {
    const where = coachingVisibleWhere(
      session(['analytics:marketing', 'analytics:org', 'clients:read_all']),
    )
    expect(where.OR).toEqual([{ subjectId: 'u1' }, { authorId: 'u1' }])
  })

  it('extends a manager to subjects inside their user scope', () => {
    const where = coachingVisibleWhere(session(['users:read', 'analytics:team', 'clients:read_team']))
    expect(where.OR).toHaveLength(3)
    const scoped = (where.OR as Record<string, unknown>[])[2]
    expect(scoped).toHaveProperty('subject')
    // The subject branch is still org-pinned through userScope.
    expect((scoped.subject as Record<string, unknown>).organizationId).toBe('org1')
  })
})
