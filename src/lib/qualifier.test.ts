import { describe, expect, it } from 'vitest'
import {
  STALE_DRIFT_POINTS,
  hotLeadWhere,
  reviewStatus,
  summarizeCoverage,
  type LatestReview,
} from '@/lib/qualifier'
import type { SessionUser } from '@/lib/rbac'

const T0 = new Date('2026-08-20T12:00:00Z')
const BEFORE = new Date('2026-08-19T12:00:00Z')
const AFTER = new Date('2026-08-21T12:00:00Z')

function approved(overrides: Partial<LatestReview> = {}): LatestReview {
  return { decision: 'APPROVED', probabilityAtReview: 85, createdAt: T0, ...overrides }
}

describe('reviewStatus', () => {
  it('is needs_review when the lead has never been reviewed', () => {
    expect(reviewStatus(null, { aiCloseProbability: 92, aiCloseProbabilityAt: T0 })).toBe(
      'needs_review',
    )
  })

  it('is rejected when the latest decision is REJECTED, regardless of score drift', () => {
    const review: LatestReview = { decision: 'REJECTED', probabilityAtReview: 85, createdAt: T0 }
    expect(reviewStatus(review, { aiCloseProbability: 99, aiCloseProbabilityAt: AFTER })).toBe(
      'rejected',
    )
  })

  it('is approved when the score matches and has not been rescored since', () => {
    expect(reviewStatus(approved(), { aiCloseProbability: 85, aiCloseProbabilityAt: BEFORE })).toBe(
      'approved',
    )
  })

  it('stays approved at exactly the drift boundary', () => {
    expect(
      reviewStatus(approved(), {
        aiCloseProbability: 85 + STALE_DRIFT_POINTS,
        aiCloseProbabilityAt: BEFORE,
      }),
    ).toBe('approved')
  })

  it('goes stale when the score drifts more than the boundary, either direction', () => {
    expect(
      reviewStatus(approved(), {
        aiCloseProbability: 85 + STALE_DRIFT_POINTS + 1,
        aiCloseProbabilityAt: BEFORE,
      }),
    ).toBe('stale')
    expect(
      reviewStatus(approved(), {
        aiCloseProbability: 85 - STALE_DRIFT_POINTS - 1,
        aiCloseProbabilityAt: BEFORE,
      }),
    ).toBe('stale')
  })

  it('goes stale when the score is newer than the review, even without drift', () => {
    expect(reviewStatus(approved(), { aiCloseProbability: 85, aiCloseProbabilityAt: AFTER })).toBe(
      'stale',
    )
  })

  it('stays approved when the score timestamp equals the review time', () => {
    expect(
      reviewStatus(approved(), { aiCloseProbability: 85, aiCloseProbabilityAt: new Date(T0) }),
    ).toBe('approved')
  })

  it('falls back to the timestamp check when either probability is missing', () => {
    // No captured probability, no rescore since — the approval stands.
    expect(
      reviewStatus(approved({ probabilityAtReview: null }), {
        aiCloseProbability: 99,
        aiCloseProbabilityAt: BEFORE,
      }),
    ).toBe('approved')
    // No captured probability but a rescore after the review — stale.
    expect(
      reviewStatus(approved({ probabilityAtReview: null }), {
        aiCloseProbability: 85,
        aiCloseProbabilityAt: AFTER,
      }),
    ).toBe('stale')
    // Score wiped since the review with no timestamp at all — the approval stands.
    expect(
      reviewStatus(approved(), { aiCloseProbability: null, aiCloseProbabilityAt: null }),
    ).toBe('approved')
  })
})

describe('hotLeadWhere', () => {
  const admin: SessionUser = {
    id: 'u1',
    name: 'Ada Admin',
    email: 'ada@example.com',
    organizationId: 'org1',
    organizationName: 'Org',
    roleId: 'r1',
    role: 'SUPER_ADMIN',
    roleName: 'Admin / Operations',
    isOwner: false,
    regionId: null,
    teamId: null,
    managerId: null,
    avatarUrl: null,
    title: null,
    permissions: new Set(['clients:read_all']),
    portalClientId: null,
  }

  // Coverage and the queue size themselves against this filter with NO row
  // limit — it must stay identical to the one inside getHotLeads (closeops.ts).
  it('matches the getHotLeads filter: org-scoped, live, non-submission, at/above threshold', () => {
    expect(hotLeadWhere(admin, { phase: 2, hotLeadThreshold: 75, leakageDays: 7 })).toEqual({
      organizationId: 'org1',
      deletedAt: null,
      status: 'ACTIVE',
      currentStage: { isTerminal: false, category: { not: 'SUBMISSION' } },
      aiCloseProbability: { gte: 75 },
    })
  })
})

describe('summarizeCoverage', () => {
  it('handles an empty hot list without inventing a percentage', () => {
    expect(summarizeCoverage([])).toEqual({
      total: 0,
      approved: 0,
      needsReview: 0,
      stale: 0,
      rejected: 0,
      approvedPct: null,
    })
  })

  it('counts each status and computes the approved share to one decimal', () => {
    const summary = summarizeCoverage([
      'approved',
      'approved',
      'needs_review',
      'stale',
      'rejected',
      'needs_review',
    ])
    expect(summary).toEqual({
      total: 6,
      approved: 2,
      needsReview: 2,
      stale: 1,
      rejected: 1,
      approvedPct: 33.3,
    })
  })
})
