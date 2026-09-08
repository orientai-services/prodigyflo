import { describe, expect, it } from 'vitest'
import type { RoleKey } from '@prisma/client'
import type { PermissionKey } from '@/lib/permissions'
import { ForbiddenError, type SessionUser } from '@/lib/rbac'
import {
  buildCloserCandidates,
  getAssignmentPanelData,
  type CloserRow,
  type CloserStats,
} from '@/lib/assignment'

function row(overrides: Partial<CloserRow> = {}): CloserRow {
  return {
    id: 'closer-1',
    name: 'Casey Closer',
    maxWorkload: 40,
    languages: ['en'],
    licensedIn: ['NV'],
    specialties: ['solar'],
    regionName: 'West',
    teamName: 'Alpha',
    ...overrides,
  }
}

function stats(overrides: Partial<CloserStats> = {}): CloserStats {
  return {
    activeByOwner: new Map(),
    outcomesByOwner: new Map(),
    lastAssignedByAssignee: new Map(),
    ...overrides,
  }
}

describe('buildCloserCandidates', () => {
  it('maps roster fields and defaults stats to an empty pipeline', () => {
    const [c] = buildCloserCandidates([row()], stats())
    expect(c).toMatchObject({
      id: 'closer-1',
      name: 'Casey Closer',
      regionName: 'West',
      teamName: 'Alpha',
      languages: ['en'],
      licensedIn: ['NV'],
      specialties: ['solar'],
      activeClients: 0,
      capacity: 40,
      closeRatePct: null,
      sampleSize: 0,
      lastAssignedAt: null,
    })
  })

  it('counts the live pipeline per owner', () => {
    const [a, b] = buildCloserCandidates(
      [row({ id: 'a' }), row({ id: 'b', name: 'B' })],
      stats({ activeByOwner: new Map([['a', 12]]) }),
    )
    expect(a.activeClients).toBe(12)
    expect(b.activeClients).toBe(0)
  })

  it('computes close rate and sample size from decided outcomes', () => {
    const [c] = buildCloserCandidates(
      [row()],
      stats({ outcomesByOwner: new Map([['closer-1', { won: 2, lost: 1 }]]) }),
    )
    expect(c.sampleSize).toBe(3)
    expect(c.closeRatePct).toBe(66.7)
  })

  it('reports a 0% close rate (not null) when every decided client was lost', () => {
    const [c] = buildCloserCandidates(
      [row()],
      stats({ outcomesByOwner: new Map([['closer-1', { won: 0, lost: 4 }]]) }),
    )
    expect(c.closeRatePct).toBe(0)
    expect(c.sampleSize).toBe(4)
  })

  it('never emits a zero capacity — a misconfigured workload cannot divide by zero', () => {
    const [c] = buildCloserCandidates([row({ maxWorkload: 0 })], stats())
    expect(c.capacity).toBe(1)
  })

  it('serializes the last assignment timestamp for rotation scoring', () => {
    const when = new Date('2026-08-01T12:00:00.000Z')
    const [c] = buildCloserCandidates(
      [row()],
      stats({ lastAssignedByAssignee: new Map([['closer-1', when]]) }),
    )
    expect(c.lastAssignedAt).toBe('2026-08-01T12:00:00.000Z')
  })
})

describe('getAssignmentPanelData — permission gate', () => {
  // The gate throws BEFORE any database access, so an ungated caller never
  // reaches the client, recommendation, or candidate queries.

  function session(role: RoleKey, permissions: PermissionKey[]): SessionUser {
    return {
      id: 'u1',
      name: 'Test User',
      email: 'user@example.com',
      organizationId: 'org1',
      organizationName: 'Org',
      roleId: 'role1',
      role,
      roleName: role,
      isOwner: false,
      regionId: null,
      teamId: null,
      managerId: null,
      avatarUrl: null,
      title: null,
      permissions: new Set(permissions),
      portalClientId: role === 'CLIENT' ? 'client_1' : null,
    }
  }

  it('rejects a portal CLIENT — internal AI analysis never reaches the portal', async () => {
    await expect(
      getAssignmentPanelData(session('CLIENT', ['portal:self']), 'client_1'),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('rejects a DOCUMENT_COLLECTOR (real grant set, none of ai:run/ai:review/clients:reassign)', async () => {
    const collector = session('DOCUMENT_COLLECTOR', [
      'clients:read_assigned',
      'documents:read',
      'documents:request',
      'documents:upload',
      'communications:read',
      'communications:send',
    ])
    await expect(getAssignmentPanelData(collector, 'client_1')).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })
})
