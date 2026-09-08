import { describe, expect, it } from 'vitest'
import type { AssistContext } from './provider'
import { composeCloserBrief, computeCloseScore } from './close-scoring'
import { MockAIProvider } from './mock-provider'

// ─── Fixtures (pure) ─────────────────────────────────────────────────────────

function fixtureContext(overrides: Partial<AssistContext> = {}): AssistContext {
  return {
    client: {
      id: 'c1',
      firstName: 'Ana',
      lastName: 'Serrano',
      email: 'ana@example.com',
      phone: '+17025550111',
      preferredLanguage: 'en',
      preferredContact: 'phone',
      stageName: 'Presentation',
      city: 'Las Vegas',
      state: 'NV',
      estimatedValue: 4000,
      ownerName: 'Rex Owner',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastActivityAt: '2026-08-01T00:00:00.000Z',
    },
    contracts: [
      {
        counterparty: 'SunBeam Solar',
        productType: 'PPA',
        monthlyAmount: 185,
        termMonths: 300,
        escalatorPct: 2.9,
        signedAt: '2024-05-01T00:00:00.000Z',
      },
    ],
    documents: [
      { name: 'Solar contract', status: 'APPROVED', required: true, isAttorneyRequired: false },
      { name: 'Utility bill', status: 'REQUESTED', required: true, isAttorneyRequired: false },
    ],
    creditSummary: { status: 'COMPLETED', scoreBand: 'GOOD', monthlyObligations: 900, derogatoryMarks: 0 },
    consents: [
      { type: 'ELECTRONIC_COMMUNICATION', granted: true },
      { type: 'SOFT_CREDIT_PULL', granted: true },
    ],
    surveyComplete: true,
    survey: { monthlyAmount: 185 },
    engagement: {
      communicationsCount: 6,
      lastInboundAt: '2026-07-30T00:00:00.000Z',
      lastOutboundAt: '2026-07-31T00:00:00.000Z',
      openTasks: 1,
      notes: 2,
    },
    verifiedFields: [],
    intakeValues: [],
    fieldConflicts: [],
    ...overrides,
  }
}

function emptyContext(): AssistContext {
  return fixtureContext({
    contracts: [],
    documents: [],
    creditSummary: null,
    consents: [],
    surveyComplete: false,
    survey: null,
    engagement: { communicationsCount: 0, lastInboundAt: null, lastOutboundAt: null, openTasks: 0, notes: 0 },
    client: { ...fixtureContext().client, stageName: 'New lead', estimatedValue: null },
  })
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

describe('computeCloseScore', () => {
  it('is deterministic: identical context in, identical result out', () => {
    const a = computeCloseScore(fixtureContext())
    const b = computeCloseScore(fixtureContext())
    expect(a).toEqual(b)
  })

  it('stays inside 2..97 even at the extremes', () => {
    const low = computeCloseScore(
      fixtureContext({
        ...emptyContext(),
        fieldConflicts: [
          { field: 'email', a: { source: 'x', value: '1' }, b: { source: 'y', value: '2' } },
          { field: 'phone', a: { source: 'x', value: '1' }, b: { source: 'y', value: '2' } },
          { field: 'name', a: { source: 'x', value: '1' }, b: { source: 'y', value: '2' } },
          { field: 'term', a: { source: 'x', value: '1' }, b: { source: 'y', value: '2' } },
        ],
        consents: [
          { type: 'A', granted: false },
          { type: 'B', granted: false },
          { type: 'C', granted: false },
          { type: 'D', granted: false },
        ],
      }),
    )
    const high = computeCloseScore(
      fixtureContext({
        client: { ...fixtureContext().client, stageName: 'Closing' },
        documents: [{ name: 'Solar contract', status: 'APPROVED', required: true, isAttorneyRequired: false }],
      }),
    )
    expect(low.probability).toBeGreaterThanOrEqual(2)
    expect(low.probability).toBeLessThanOrEqual(97)
    expect(high.probability).toBeGreaterThanOrEqual(2)
    expect(high.probability).toBeLessThanOrEqual(97)
    expect(high.probability).toBeGreaterThan(low.probability)
  })

  it('is explainable: every reason carries its signed weight, capped at 8', () => {
    const r = computeCloseScore(fixtureContext())
    expect(r.reasons.length).toBeGreaterThan(0)
    expect(r.reasons.length).toBeLessThanOrEqual(8)
    for (const reason of r.reasons) expect(reason).toMatch(/\([+-]\d+\)$/)
    // Reasons are the strongest signals first.
    const weights = r.reasons.map((x) => Math.abs(Number(x.match(/\(([+-]\d+)\)$/)![1])))
    expect([...weights].sort((a, b) => b - a)).toEqual(weights)
  })

  it('moves with the evidence: survey, conflicts, and stage depth all matter', () => {
    const base = computeCloseScore(fixtureContext())

    const noSurvey = computeCloseScore(fixtureContext({ surveyComplete: false }))
    expect(noSurvey.probability).toBeLessThan(base.probability)

    const conflicted = computeCloseScore(
      fixtureContext({
        fieldConflicts: [{ field: 'monthly payment', a: { source: 'contract', value: '185' }, b: { source: 'survey', value: '250' } }],
      }),
    )
    expect(conflicted.probability).toBeLessThan(base.probability)

    const early = computeCloseScore(fixtureContext({ client: { ...fixtureContext().client, stageName: 'New lead' } }))
    const closing = computeCloseScore(fixtureContext({ client: { ...fixtureContext().client, stageName: 'Closing' } }))
    expect(closing.probability).toBeGreaterThan(early.probability)
  })

  it('grades confidence by how populated the file is', () => {
    expect(computeCloseScore(fixtureContext()).confidence).toBe('high')
    expect(computeCloseScore(emptyContext()).confidence).toBe('low')
  })
})

// ─── Brief ───────────────────────────────────────────────────────────────────

describe('composeCloserBrief', () => {
  it('is deterministic and returns the full brief shape', () => {
    const a = composeCloserBrief(fixtureContext())
    const b = composeCloserBrief(fixtureContext())
    expect(a).toEqual(b)

    expect(a.situation).toBeTypeOf('string')
    expect(a.situation.length).toBeGreaterThan(0)
    expect(Array.isArray(a.highlights)).toBe(true)
    expect(a.highlights.length).toBeGreaterThan(0)
    expect(a.objections.length).toBeGreaterThan(0)
    for (const o of a.objections) {
      expect(o.objection).toBeTypeOf('string')
      expect(o.response).toBeTypeOf('string')
      expect(o.response.length).toBeGreaterThan(0)
    }
    expect(a.talkingPoints.length).toBeGreaterThan(0)
    expect(a.recommendedNextStep.length).toBeGreaterThan(0)
  })

  it('grounds objections in the contract on file (escalator)', () => {
    const brief = composeCloserBrief(fixtureContext())
    const joined = brief.objections.map((o) => `${o.objection} ${o.response}`).join(' ')
    expect(joined).toContain('2.9%')
  })

  it('flags Spanish preference in highlights and talking points', () => {
    const es = composeCloserBrief(
      fixtureContext({ client: { ...fixtureContext().client, preferredLanguage: 'es' } }),
    )
    expect(es.highlights.join(' ')).toMatch(/Spanish/)
    expect(es.talkingPoints.join(' ')).toMatch(/Spanish/)
  })

  it('recommends finishing the survey when it is incomplete', () => {
    const brief = composeCloserBrief(fixtureContext({ surveyComplete: false }))
    expect(brief.recommendedNextStep).toMatch(/survey/i)
  })
})

// ─── Provider surface ────────────────────────────────────────────────────────

describe('MockAIProvider close-ops methods', () => {
  it('scoreCloseProbability matches the pure engine and strips internals', async () => {
    const provider = new MockAIProvider()
    const scored = await provider.scoreCloseProbability(fixtureContext())
    const pure = computeCloseScore(fixtureContext())
    expect(scored).toEqual({ probability: pure.probability, reasons: pure.reasons, confidence: pure.confidence })
    expect('signals' in scored).toBe(false)
  })

  it('generateCloserBrief matches the pure engine', async () => {
    const provider = new MockAIProvider()
    expect(await provider.generateCloserBrief(fixtureContext())).toEqual(composeCloserBrief(fixtureContext()))
  })
})
