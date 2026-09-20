import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionKey } from '@/lib/permissions'
import { clientScope, type SessionUser } from '@/lib/rbac'
import {
  composeDigestBody,
  composeDigestTitle,
  digestScopeFor,
  isMondayIn,
  isoWeekKey,
  isoWeekday,
  lastWeekWindow,
  qualifiedInWeekWhere,
  sendWeeklyDigests,
  type WeeklyStats,
} from '@/lib/digest'

const LA = 'America/Los_Angeles'
const NY = 'America/New_York'

// ── Mocks for the delivery path (sendWeeklyDigests) ──────────────────────────
// Only the delivery tests use these; the pure-logic and where-clause tests do
// not touch the DB. clientScope stays REAL so the query scoping is exercised.
const { mockDb, mockClaim, mockMerge, mockLoadActor } = vi.hoisted(() => ({
  mockDb: {
    organization: { findMany: vi.fn(), findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    client: { count: vi.fn(), findMany: vi.fn() },
    deal: { findMany: vi.fn() },
    communication: { findMany: vi.fn() },
    nurtureTouch: { count: vi.fn() },
    closerBrief: { findMany: vi.fn() },
    notification: { createMany: vi.fn() },
    auditEvent: { create: vi.fn() },
  },
  mockClaim: vi.fn(),
  mockMerge: vi.fn(),
  mockLoadActor: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: mockDb }))
vi.mock('@/lib/org-settings', () => ({
  claimOrgSettingsValue: mockClaim,
  mergeOrgSettings: mockMerge,
}))
vi.mock('@/lib/automation/actor', () => ({ loadActor: mockLoadActor }))

function session(permissions: PermissionKey[], overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'u1',
    name: 'Test User',
    email: 'user@example.com',
    organizationId: 'org1',
    organizationName: 'Org',
    roleId: 'role1',
    role: 'SALES_MANAGER',
    roleName: 'Sales Manager',
    isOwner: false,
    regionId: null,
    teamId: 'teamA',
    managerId: null,
    avatarUrl: null,
    title: null,
    permissions: new Set(permissions),
    portalClientId: null,
    ...overrides,
  }
}

describe('isoWeekKey', () => {
  it('computes plain mid-year weeks', () => {
    // 2026-01-01 is a Thursday, so W35's Monday is Aug 24.
    expect(isoWeekKey(2026, 8, 17)).toBe('2026-W34')
    expect(isoWeekKey(2026, 8, 24)).toBe('2026-W35')
  })

  it('starts the year on W01 when Jan 1 is a Thursday', () => {
    expect(isoWeekKey(2026, 1, 1)).toBe('2026-W01')
  })

  it('assigns early January to the previous ISO year when it falls late in the week', () => {
    // 2027-01-01 is a Friday — it belongs to 2026's 53rd week.
    expect(isoWeekKey(2027, 1, 1)).toBe('2026-W53')
  })

  it('assigns late December to the next ISO year when the week is mostly new-year', () => {
    // Mon 2024-12-30 sits in the week whose Thursday is 2025-01-02.
    expect(isoWeekKey(2024, 12, 30)).toBe('2025-W01')
  })
})

describe('isoWeekday + isMondayIn', () => {
  it('depends on the org timezone, not UTC', () => {
    // 2026-08-24T04:00Z = Mon 00:00 EDT but still Sun 21:00 PDT.
    const at = new Date('2026-08-24T04:00:00Z')
    expect(isoWeekday(at, NY)).toBe(1)
    expect(isoWeekday(at, LA)).toBe(7)
    expect(isMondayIn(at, NY)).toBe(true)
    expect(isMondayIn(at, LA)).toBe(false)
  })
})

describe('lastWeekWindow', () => {
  it('on a Monday covers the Mon-Sun week ending yesterday, cut at local midnight', () => {
    const now = new Date('2026-08-24T16:00:00Z') // Mon 09:00 PDT
    const w = lastWeekWindow(now, LA)
    expect(w.start.toISOString()).toBe('2026-08-17T07:00:00.000Z') // Mon Aug 17 00:00 PDT
    expect(w.end.toISOString()).toBe('2026-08-24T07:00:00.000Z') // Mon Aug 24 00:00 PDT
    expect(w.weekKey).toBe('2026-W34')
    expect(w.label).toBe('Aug 17–23')
  })

  it('uses the org wall clock to decide which week is last', () => {
    // Sun 21:00 PDT — the LA week has not rolled over yet.
    const w = lastWeekWindow(new Date('2026-08-24T04:00:00Z'), LA)
    expect(w.start.toISOString()).toBe('2026-08-10T07:00:00.000Z')
    expect(w.weekKey).toBe('2026-W33')
  })

  it('is stable across the whole local Monday (the guard key never flaps)', () => {
    const early = lastWeekWindow(new Date('2026-08-24T07:05:00Z'), LA) // Mon 00:05 PDT
    const late = lastWeekWindow(new Date('2026-08-25T06:55:00Z'), LA) // Mon 23:55 PDT
    expect(early.weekKey).toBe('2026-W34')
    expect(late.weekKey).toBe(early.weekKey)
    expect(late.start.toISOString()).toBe(early.start.toISOString())
  })

  it('labels a cross-month week with both months', () => {
    const w = lastWeekWindow(new Date('2026-09-07T16:00:00Z'), LA) // Mon Sep 7
    expect(w.label).toBe('Aug 31 – Sep 6')
    expect(w.weekKey).toBe('2026-W36')
  })

  it('crosses the year boundary with the previous ISO year key', () => {
    const w = lastWeekWindow(new Date('2027-01-04T12:00:00Z'), 'UTC') // Mon Jan 4
    expect(w.start.toISOString()).toBe('2026-12-28T00:00:00.000Z')
    expect(w.end.toISOString()).toBe('2027-01-04T00:00:00.000Z')
    expect(w.weekKey).toBe('2026-W53')
    expect(w.label).toBe('Dec 28 – Jan 3')
  })

  it('spans exactly seven local days across a DST fall-back week', () => {
    // The week Oct 26 – Nov 1 2026 contains the US fall-back (Nov 1), so its
    // bounds sit in different UTC offsets and the window is 169 hours long.
    const w = lastWeekWindow(new Date('2026-11-02T17:00:00Z'), LA) // Mon Nov 2, PST
    expect(w.start.toISOString()).toBe('2026-10-26T07:00:00.000Z') // Mon Oct 26 00:00 PDT
    expect(w.end.toISOString()).toBe('2026-11-02T08:00:00.000Z') // Mon Nov 2 00:00 PST
  })
})

describe('composeDigestBody', () => {
  const full: WeeklyStats = {
    label: 'Aug 17–23',
    newLeads: 42,
    qualified: 17,
    wins: 9,
    revenue: 84_500,
    closeRatePct: 36,
    calls: 128,
    briefAdoptionPct: 71,
    nurtureConfirmed: 23,
    topCloser: { name: 'Jane Doe', wins: 4 },
  }

  it('composes the full week into one compact paragraph', () => {
    expect(composeDigestBody(full)).toBe(
      'Last week (Aug 17–23): 42 new leads, 17 qualified, 9 wins for $84,500 (36% close rate). ' +
        '128 calls logged (71% with an AI brief), 23 nurture touches confirmed. ' +
        'Top closer: Jane Doe with 4 wins. Full breakdown on the Performance page.',
    )
  })

  it('stays under the ~400 char notification budget', () => {
    expect(composeDigestBody(full).length).toBeLessThan(400)
  })

  it('omits null rates and the top closer on a quiet week', () => {
    const body = composeDigestBody({
      label: 'Aug 17–23',
      newLeads: 0,
      qualified: 0,
      wins: 0,
      revenue: 0,
      closeRatePct: null,
      calls: 0,
      briefAdoptionPct: null,
      nurtureConfirmed: 0,
      topCloser: null,
    })
    expect(body).toBe(
      'Last week (Aug 17–23): 0 new leads, 0 qualified, no wins. ' +
        '0 calls logged, 0 nurture touches confirmed. Full breakdown on the Performance page.',
    )
  })

  it('pluralizes wins and touches correctly at one', () => {
    const body = composeDigestBody({
      ...full,
      wins: 1,
      revenue: 5000,
      nurtureConfirmed: 1,
      topCloser: { name: 'Jane Doe', wins: 1 },
    })
    expect(body).toContain('1 win for $5,000')
    expect(body).toContain('1 nurture touch confirmed')
    expect(body).toContain('Jane Doe with 1 win.')
  })
})

describe('qualifiedInWeekWhere', () => {
  it('counts distinct clients (EXISTS on stage history), not QUALIFIED entries', () => {
    const inWeek = { gte: new Date('2026-08-17T07:00:00Z'), lt: new Date('2026-08-24T07:00:00Z') }
    const where = qualifiedInWeekWhere({ organizationId: 'org1', deletedAt: null }, inWeek)
    // A Client where-clause — one row per client, so a client that re-entered
    // QUALIFIED twice in the week still counts once, matching the sibling
    // metrics' client populations. The window applies to the entry, not the
    // client's other fields.
    expect(where).toEqual({
      organizationId: 'org1',
      deletedAt: null,
      stageHistory: { some: { toKey: 'QUALIFIED', enteredAt: inWeek } },
    })
  })
})

describe('composeDigestTitle', () => {
  it('names the week with the neutral title when no scope is given', () => {
    expect(composeDigestTitle('Aug 17–23')).toBe('Weekly digest · Aug 17–23')
  })

  it('names the recipient scope so team numbers never read as company numbers', () => {
    expect(composeDigestTitle('Aug 17–23', 'org')).toBe('Company last week · Aug 17–23')
    expect(composeDigestTitle('Aug 17–23', 'region')).toBe('Your region last week · Aug 17–23')
    expect(composeDigestTitle('Aug 17–23', 'team')).toBe('Your team last week · Aug 17–23')
  })
})

describe('digestScopeFor', () => {
  it('maps the broadest client-read grant held to a scope', () => {
    expect(digestScopeFor(session(['clients:read_all']))).toBe('org')
    expect(digestScopeFor(session(['clients:read_region', 'clients:read_team']))).toBe('region')
    expect(digestScopeFor(session(['clients:read_team']))).toBe('team')
  })

  it('defaults to team scope when the recipient holds no broad grant', () => {
    // Managers are the only extra recipients; a narrower grant still gets the
    // most conservative (team) label rather than an org-wide one.
    expect(digestScopeFor(session(['clients:read_assigned']))).toBe('team')
  })
})

describe('per-recipient stat scoping (clientScope threading)', () => {
  const inWeek = { gte: new Date('2026-08-17T07:00:00Z'), lt: new Date('2026-08-24T07:00:00Z') }

  it("denies the retired SALES_MANAGER role", () => {
    const mgr = session(['clients:read_team'], { id: 'mgr', teamId: 'teamA' })
    const scope = clientScope(mgr)
    // Team managers get an OR of their own team / owned / managed clients — a
    // client on teamB with a different owner and manager matches no branch.
    expect(scope).toEqual({
      organizationId: 'org1',
      deletedAt: null,
      id: '__none__',
    })
    // The digest's qualified where threads that scope through unchanged, so the
    // qualified count is likewise team-bounded.
    expect(qualifiedInWeekWhere(scope, inWeek)).toEqual({
      ...scope,
      stageHistory: { some: { toKey: 'QUALIFIED', enteredAt: inWeek } },
    })
  })

  it('gives an ADMIN the whole org (no team OR), which a manager never gets', () => {
    const admin = clientScope(session(['clients:read_all'], { role: 'SUPER_ADMIN' }))
    expect(admin).toEqual({ organizationId: 'org1', deletedAt: null })
    expect('OR' in admin).toBe(false)
  })
})

describe('sendWeeklyDigests (delivery + claim guard)', () => {
  const MONDAY = new Date('2026-08-24T16:00:00Z') // Mon 09:00 PDT

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.organization.findMany.mockResolvedValue([{ id: 'org1', timezone: LA }])
    mockDb.organization.findUnique.mockResolvedValue({ timezone: LA })
    mockDb.user.findMany.mockResolvedValue([{ id: 'mgr' }])
    mockDb.client.count.mockResolvedValue(0)
    mockDb.client.findMany.mockResolvedValue([])
    mockDb.deal.findMany.mockResolvedValue([])
    mockDb.communication.findMany.mockResolvedValue([])
    mockDb.nurtureTouch.count.mockResolvedValue(0)
    mockDb.closerBrief.findMany.mockResolvedValue([])
    mockDb.notification.createMany.mockResolvedValue({ count: 1 })
    mockDb.auditEvent.create.mockResolvedValue({})
    mockClaim.mockResolvedValue(true)
    mockLoadActor.mockResolvedValue(session(['clients:read_team'], { id: 'mgr', teamId: 'teamA' }))
  })

  it('claims the week once and delivers one scoped notification per recipient', async () => {
    const res = await sendWeeklyDigests(MONDAY)
    expect(mockClaim).toHaveBeenCalledTimes(1)
    expect(mockClaim).toHaveBeenCalledWith('org1', 'digest', 'lastSentWeek', '2026-W34')
    expect(mockDb.notification.createMany).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ mondays: 1, sent: 1, recipients: 1 })
  })

  it('titles each recipient with their own scope (manager => team, not company)', async () => {
    await sendWeeklyDigests(MONDAY)
    const rows = mockDb.notification.createMany.mock.calls[0][0].data as Array<{ title: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Your team last week · Aug 17–23')
  })

  it('gives an ADMIN recipient the company-wide title', async () => {
    mockLoadActor.mockResolvedValue(session(['clients:read_all'], { id: 'adm', role: 'ADMIN' }))
    await sendWeeklyDigests(MONDAY)
    const rows = mockDb.notification.createMany.mock.calls[0][0].data as Array<{ title: string }>
    expect(rows[0].title).toBe('Company last week · Aug 17–23')
  })

  it('fires the claim guard once: a run that loses the claim sends nothing', async () => {
    mockClaim.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const first = await sendWeeklyDigests(MONDAY)
    const second = await sendWeeklyDigests(MONDAY)
    expect(first.sent).toBe(1)
    expect(second.sent).toBe(0)
    // Exactly one run created notifications; the loser short-circuited.
    expect(mockDb.notification.createMany).toHaveBeenCalledTimes(1)
  })

  it('does not deliver on a day that is not Monday in the org timezone', async () => {
    const sunday = new Date('2026-08-24T04:00:00Z') // Sun 21:00 PDT
    const res = await sendWeeklyDigests(sunday)
    expect(res.mondays).toBe(0)
    expect(mockClaim).not.toHaveBeenCalled()
    expect(mockDb.notification.createMany).not.toHaveBeenCalled()
  })
})
