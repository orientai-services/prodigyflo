import { describe, expect, it } from 'vitest'
import type { StageKey } from '@prisma/client'
import {
  computeAttribution,
  computeForecast,
  computeJourney,
  measureStageWinRates,
  pickTouch,
  type AttributionClientInput,
  type Outcome,
  type StageStayInput,
  type TouchInput,
} from '@/lib/revops'
import { buildAttorneyManifest, computeAttorneyReadiness } from '@/lib/attorney'

// ── fixtures ─────────────────────────────────────────────────

const at = (day: number) => new Date(2026, 0, day)

const touch = (overrides: Partial<TouchInput> = {}): TouchInput => ({
  campaignId: null,
  leadSourceId: null,
  touch: 'MIDDLE',
  occurredAt: at(1),
  ...overrides,
})

const channels = {
  campaigns: [
    { id: 'camp_fb', name: 'FB Solar Regret', channel: 'facebook', spend: 1000 },
    { id: 'camp_gg', name: 'Google Brand', channel: 'google', spend: 0 },
  ],
  sources: [{ id: 'src_ref', name: 'Referrals', channel: 'referral' }],
}

// ── attribution ──────────────────────────────────────────────

describe('pickTouch', () => {
  it('uses timestamps when no explicit markers exist', () => {
    const events = [
      touch({ campaignId: 'b', occurredAt: at(5) }),
      touch({ campaignId: 'a', occurredAt: at(1) }),
      touch({ campaignId: 'c', occurredAt: at(9) }),
    ]
    expect(pickTouch(events, 'FIRST')?.campaignId).toBe('a')
    expect(pickTouch(events, 'LAST')?.campaignId).toBe('c')
  })

  it('lets an explicit FIRST/LAST marker outrank ordering', () => {
    const events = [
      touch({ campaignId: 'early', occurredAt: at(1) }),
      touch({ campaignId: 'markedFirst', occurredAt: at(3), touch: 'FIRST' }),
      touch({ campaignId: 'markedLast', occurredAt: at(5), touch: 'LAST' }),
      touch({ campaignId: 'late', occurredAt: at(9) }),
    ]
    expect(pickTouch(events, 'FIRST')?.campaignId).toBe('markedFirst')
    expect(pickTouch(events, 'LAST')?.campaignId).toBe('markedLast')
  })

  it('returns null with no events', () => {
    expect(pickTouch([], 'FIRST')).toBeNull()
  })
})

describe('computeAttribution', () => {
  it('credits first-touch and last-touch to different rows for a multi-touch client', () => {
    const clients: AttributionClientInput[] = [
      {
        id: 'c1',
        campaignId: null,
        leadSourceId: null,
        won: true,
        revenue: 5000,
        events: [
          touch({ campaignId: 'camp_fb', occurredAt: at(1) }),
          touch({ leadSourceId: 'src_ref', occurredAt: at(10) }),
        ],
      },
    ]
    const rows = computeAttribution(clients, channels)
    const fb = rows.find((r) => r.key === 'campaign:camp_fb')!
    const ref = rows.find((r) => r.key === 'source:src_ref')!

    expect(fb.leadsFirst).toBe(1)
    expect(fb.leadsLast).toBe(0)
    expect(fb.revenueFirst).toBe(5000)
    expect(fb.revenueLast).toBe(0)
    expect(fb.wonFirst).toBe(1)

    expect(ref.leadsFirst).toBe(0)
    expect(ref.leadsLast).toBe(1)
    expect(ref.revenueLast).toBe(5000)
    expect(ref.wonLast).toBe(1)
  })

  it('falls back to the client record and buckets untracked clients as direct', () => {
    const clients: AttributionClientInput[] = [
      { id: 'c1', campaignId: 'camp_fb', leadSourceId: null, won: false, revenue: 0, events: [] },
      { id: 'c2', campaignId: null, leadSourceId: null, won: true, revenue: 800, events: [] },
    ]
    const rows = computeAttribution(clients, channels)
    const fb = rows.find((r) => r.key === 'campaign:camp_fb')!
    const direct = rows.find((r) => r.key === 'direct')!

    expect(fb.leadsFirst).toBe(1)
    expect(fb.leadsLast).toBe(1)
    expect(direct.leadsFirst).toBe(1)
    expect(direct.revenueFirst).toBe(800)
    expect(direct.revenueLast).toBe(800)
    expect(direct.spend).toBeNull()
    expect(direct.cplFirst).toBeNull()
  })

  it('computes CPL only where spend exists', () => {
    const clients: AttributionClientInput[] = [
      { id: 'c1', campaignId: 'camp_fb', leadSourceId: null, won: false, revenue: 0, events: [] },
      { id: 'c2', campaignId: 'camp_fb', leadSourceId: null, won: false, revenue: 0, events: [] },
      { id: 'c3', campaignId: 'camp_gg', leadSourceId: null, won: false, revenue: 0, events: [] },
    ]
    const rows = computeAttribution(clients, channels)
    expect(rows.find((r) => r.key === 'campaign:camp_fb')!.cplFirst).toBe(500)
    // Zero recorded spend → no CPL rather than $0, which would read as "free".
    expect(rows.find((r) => r.key === 'campaign:camp_gg')!.cplFirst).toBeNull()
  })

  it('counts every event as a touch', () => {
    const clients: AttributionClientInput[] = [
      {
        id: 'c1',
        campaignId: null,
        leadSourceId: null,
        won: false,
        revenue: 0,
        events: [
          touch({ campaignId: 'camp_fb', occurredAt: at(1) }),
          touch({ campaignId: 'camp_fb', occurredAt: at(2) }),
          touch({ leadSourceId: 'src_ref', occurredAt: at(3) }),
        ],
      },
    ]
    const rows = computeAttribution(clients, channels)
    expect(rows.find((r) => r.key === 'campaign:camp_fb')!.touches).toBe(2)
    expect(rows.find((r) => r.key === 'source:src_ref')!.touches).toBe(1)
  })
})

// ── forecast ─────────────────────────────────────────────────

const outcomes = (map: Record<string, Outcome>) => new Map(Object.entries(map))

describe('measureStageWinRates', () => {
  it('measures probability as won ÷ decided, excluding open clients from n', () => {
    const entries = [
      { clientId: 'w1', toKey: 'QUALIFIED' as StageKey },
      { clientId: 'w2', toKey: 'QUALIFIED' as StageKey },
      { clientId: 'l1', toKey: 'QUALIFIED' as StageKey },
      { clientId: 'o1', toKey: 'QUALIFIED' as StageKey }, // open — must not count
    ]
    const rates = measureStageWinRates(
      entries,
      outcomes({ w1: 'WON', w2: 'WON', l1: 'LOST', o1: 'OPEN' }),
    )
    const q = rates.get('QUALIFIED')!
    expect(q.n).toBe(3)
    expect(q.won).toBe(2)
    expect(q.probability).toBeCloseTo(2 / 3)
  })

  it('counts a client once per stage even with repeated entries', () => {
    const entries = [
      { clientId: 'w1', toKey: 'FOLLOW_UP' as StageKey },
      { clientId: 'w1', toKey: 'FOLLOW_UP' as StageKey },
      { clientId: 'l1', toKey: 'FOLLOW_UP' as StageKey },
    ]
    const rates = measureStageWinRates(entries, outcomes({ w1: 'WON', l1: 'LOST' }))
    expect(rates.get('FOLLOW_UP')!.n).toBe(2)
    expect(rates.get('FOLLOW_UP')!.probability).toBe(0.5)
  })

  it('reports null probability when a stage has no decided history', () => {
    const rates = measureStageWinRates(
      [{ clientId: 'o1', toKey: 'PAYMENT_SELECTION' as StageKey }],
      outcomes({ o1: 'OPEN' }),
    )
    expect(rates.get('PAYMENT_SELECTION')!.n).toBe(0)
    expect(rates.get('PAYMENT_SELECTION')!.probability).toBeNull()
  })
})

describe('computeForecast', () => {
  const rates = measureStageWinRates(
    [
      { clientId: 'w1', toKey: 'QUALIFIED' },
      { clientId: 'l1', toKey: 'QUALIFIED' },
      { clientId: 'l2', toKey: 'QUALIFIED' },
      { clientId: 'l3', toKey: 'QUALIFIED' },
    ],
    outcomes({ w1: 'WON', l1: 'LOST', l2: 'LOST', l3: 'LOST' }),
  )

  it('weights open value by the measured stage probability', () => {
    const summary = computeForecast(
      [
        { id: 'a', stageKey: 'QUALIFIED', estimatedValue: 10000, probability: 90, expectedCloseAt: null },
        { id: 'b', stageKey: 'QUALIFIED', estimatedValue: 6000, probability: null, expectedCloseAt: null },
      ],
      rates,
    )
    // Measured 25% outranks the optimistic 90% the rep typed in.
    expect(summary.weightedTotal).toBeCloseTo(16000 * 0.25)
    const stage = summary.stages.find((s) => s.stageKey === 'QUALIFIED')!
    expect(stage.measuredProbability).toBeCloseTo(0.25)
    expect(stage.n).toBe(4)
    expect(stage.probabilitySource).toBe('measured')
    expect(stage.openValue).toBe(16000)
  })

  it('falls back to Client.probability when a stage lacks history', () => {
    const summary = computeForecast(
      [{ id: 'a', stageKey: 'FOLLOW_UP', estimatedValue: 8000, probability: 40, expectedCloseAt: null }],
      rates, // no FOLLOW_UP history
    )
    expect(summary.weightedTotal).toBeCloseTo(8000 * 0.4)
    const stage = summary.stages.find((s) => s.stageKey === 'FOLLOW_UP')!
    expect(stage.measuredProbability).toBeNull()
    expect(stage.n).toBe(0)
    expect(stage.probabilitySource).toBe('client-fallback')
  })

  it('excludes value with no probability at all and reports it', () => {
    const summary = computeForecast(
      [{ id: 'a', stageKey: 'PAYMENT_SELECTION', estimatedValue: 5000, probability: null, expectedCloseAt: null }],
      rates,
    )
    expect(summary.weightedTotal).toBe(0)
    expect(summary.unweightedValue).toBe(5000)
    expect(summary.unweightedClients).toBe(1)
    expect(summary.stages[0].probabilitySource).toBe('none')
  })

  it('clamps out-of-range client probabilities', () => {
    const summary = computeForecast(
      [{ id: 'a', stageKey: 'FOLLOW_UP', estimatedValue: 1000, probability: 150, expectedCloseAt: null }],
      rates,
    )
    expect(summary.weightedTotal).toBe(1000)
  })
})

// ── journey ──────────────────────────────────────────────────

describe('computeJourney', () => {
  const stay = (overrides: Partial<StageStayInput> & { clientId: string; toKey: StageKey }): StageStayInput => ({
    enteredAt: at(1),
    exitedAt: null,
    durationMinutes: null,
    ...overrides,
  })

  it('computes median time-in-stage from completed stays only', () => {
    const stays = [
      stay({ clientId: 'a', toKey: 'NEW_LEAD', durationMinutes: 60 }),
      stay({ clientId: 'b', toKey: 'NEW_LEAD', durationMinutes: 120 }),
      stay({ clientId: 'c', toKey: 'NEW_LEAD', durationMinutes: 600 }),
      stay({ clientId: 'd', toKey: 'NEW_LEAD' }), // still sitting there — no duration
    ]
    const journey = computeJourney(stays, outcomes({ a: 'WON', b: 'LOST', c: 'OPEN', d: 'OPEN' }), 2)
    const row = journey.stages.find((s) => s.stageKey === 'NEW_LEAD')!
    expect(row.medianMinutes).toBe(120)
    expect(row.staysMeasured).toBe(3)
    expect(row.entered).toBe(4)
    expect(row.decided).toBe(2)
    expect(row.wonShare).toBe(50)
  })

  it('derives a duration from exitedAt when durationMinutes is missing', () => {
    const stays = [
      stay({ clientId: 'a', toKey: 'QUALIFIED', enteredAt: at(1), exitedAt: at(2) }),
    ]
    const journey = computeJourney(stays, outcomes({ a: 'OPEN' }), 1)
    expect(journey.stages.find((s) => s.stageKey === 'QUALIFIED')!.medianMinutes).toBe(24 * 60)
  })

  it('measures median lead→close from first entry to the CLOSED_WON entry', () => {
    const stays = [
      stay({ clientId: 'a', toKey: 'NEW_LEAD', enteredAt: at(1) }),
      stay({ clientId: 'a', toKey: 'CLOSED_WON', enteredAt: at(11) }),
      stay({ clientId: 'b', toKey: 'NEW_LEAD', enteredAt: at(1) }),
      stay({ clientId: 'b', toKey: 'CLOSED_WON', enteredAt: at(31) }),
    ]
    const journey = computeJourney(stays, outcomes({ a: 'WON', b: 'WON' }), 1)
    expect(journey.medianLeadToCloseDays).toBe(20) // median of 10 and 30
    expect(journey.wonSample).toBe(2)
  })

  it('flags small samples and keeps them out of the drop-off ranking', () => {
    const stays = [
      stay({ clientId: 'a', toKey: 'QUALIFIED' }),
      stay({ clientId: 'b', toKey: 'QUALIFIED' }),
      stay({ clientId: 'c', toKey: 'FOLLOW_UP' }),
    ]
    const journey = computeJourney(
      stays,
      outcomes({ a: 'WON', b: 'LOST', c: 'LOST' }),
      2,
    )
    const qualified = journey.stages.find((s) => s.stageKey === 'QUALIFIED')!
    const followUp = journey.stages.find((s) => s.stageKey === 'FOLLOW_UP')!
    expect(qualified.belowMinimumSample).toBe(false)
    expect(followUp.belowMinimumSample).toBe(true) // n=1 < 2
    expect(journey.biggestDropoffs.map((s) => s.stageKey)).toEqual(['QUALIFIED'])
  })
})

// ── attorney gate + manifest ─────────────────────────────────

describe('computeAttorneyReadiness', () => {
  const requirements = [
    { id: 'req_contract', name: 'Signed solar agreement' },
    { id: 'req_bill', name: 'Utility bill' },
  ]

  it('refuses while any attorney-required document is unapproved', () => {
    const readiness = computeAttorneyReadiness({
      requirements,
      documents: [
        { requirementId: 'req_contract', status: 'APPROVED' },
        { requirementId: 'req_bill', status: 'UNDER_REVIEW' },
      ],
      hasSignedContract: true,
    })
    expect(readiness.ready).toBe(false)
    expect(readiness.requiredApproved).toBe(1)
    expect(readiness.blockers).toHaveLength(1)
    expect(readiness.blockers[0]).toMatch(/Utility bill/)
    expect(readiness.blockers[0]).toMatch(/under review/)
  })

  it('refuses when a required document was never uploaded', () => {
    const readiness = computeAttorneyReadiness({
      requirements,
      documents: [{ requirementId: 'req_contract', status: 'APPROVED' }],
      hasSignedContract: true,
    })
    expect(readiness.ready).toBe(false)
    expect(readiness.blockers[0]).toMatch(/not been requested or uploaded/)
  })

  it('refuses without a signed contract even with every document approved', () => {
    const readiness = computeAttorneyReadiness({
      requirements,
      documents: [
        { requirementId: 'req_contract', status: 'APPROVED' },
        { requirementId: 'req_bill', status: 'APPROVED' },
      ],
      hasSignedContract: false,
    })
    expect(readiness.ready).toBe(false)
    expect(readiness.blockers).toEqual([expect.stringMatching(/signed contract/i)])
  })

  it('approves when every requirement is APPROVED and the contract is signed', () => {
    const readiness = computeAttorneyReadiness({
      requirements,
      documents: [
        { requirementId: 'req_contract', status: 'REJECTED' }, // superseded version
        { requirementId: 'req_contract', status: 'APPROVED' },
        { requirementId: 'req_bill', status: 'APPROVED' },
      ],
      hasSignedContract: true,
    })
    expect(readiness.ready).toBe(true)
    expect(readiness.blockers).toEqual([])
    expect(readiness.requiredApproved).toBe(2)
    expect(readiness.requiredTotal).toBe(2)
  })
})

describe('buildAttorneyManifest', () => {
  const doc = {
    id: 'doc_1',
    fileName: 'agreement.pdf',
    label: 'Solar agreement',
    requirementName: 'Signed solar agreement',
    checksum: 'abc123',
    version: 3,
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    status: 'APPROVED' as const,
  }

  it('lists only APPROVED documents with name, checksum, and version', () => {
    const manifest = buildAttorneyManifest([
      doc,
      { ...doc, id: 'doc_2', status: 'UNDER_REVIEW' },
      { ...doc, id: 'doc_3', status: 'REJECTED' },
    ])
    expect(manifest).toHaveLength(1)
    expect(manifest[0]).toMatchObject({
      id: 'doc_1',
      name: 'Solar agreement',
      requirement: 'Signed solar agreement',
      checksum: 'abc123',
      version: 3,
      status: 'APPROVED',
    })
  })

  it('falls back through label → fileName → requirement for the display name', () => {
    expect(buildAttorneyManifest([{ ...doc, label: null }])[0].name).toBe('agreement.pdf')
    expect(buildAttorneyManifest([{ ...doc, label: null, fileName: null }])[0].name).toBe(
      'Signed solar agreement',
    )
    expect(
      buildAttorneyManifest([{ ...doc, label: null, fileName: null, requirementName: null }])[0].name,
    ).toBe('Document')
  })
})
