import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAIProvider } from '@/lib/ai/mock-provider'
import type { GenerateInsightsInput } from '@/lib/ai/provider'

// Mock generateInsights must be a pure function of its input: no clock, no
// RNG. Same input → identical output, even across different wall-clock times.

const baseInput = (): GenerateInsightsInput => ({
  kpis: {
    core: {
      closeRate: 12,
      won: 3,
      lost: 9,
      medianSpeedToContactHours: 40,
    },
    marketing: { costPerLead: 180.5 },
  },
  snippets: [
    { source: 'clients', ref: 'analytics:stage-counts', text: 'Clients by pipeline stage — New lead: 12.' },
    { source: 'clients', ref: 'client:c1', text: 'Jane Doe is 30h over the 24h SLA in "Qualified".' },
    { source: 'metrics', ref: 'marketing:ads-30d', text: 'Ad performance — spend $2000, cost per lead $180.50.' },
    { source: 'pastInsights', ref: 'insight:i1', text: '[ACCEPTED] (pipeline) Older insight — body.' },
  ],
  priorFeedback: [],
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MockAIProvider.generateInsights', () => {
  const provider = new MockAIProvider()

  it('is deterministic: the same input yields the identical result', async () => {
    const a = await provider.generateInsights(baseInput())
    const b = await provider.generateInsights(baseInput())
    expect(b).toEqual(a)
  })

  it('is clock-independent: the output does not change with the system time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const early = await provider.generateInsights(baseInput())
    vi.setSystemTime(new Date('2030-06-15T12:34:56Z'))
    const late = await provider.generateInsights(baseInput())
    expect(late).toEqual(early)
  })

  it('grounds every proposal in the input: cited evidence comes from the snippets', async () => {
    const input = baseInput()
    const { insights } = await provider.generateInsights(input)
    expect(insights.length).toBeGreaterThan(0)
    expect(insights.length).toBeLessThanOrEqual(8)
    const refs = new Set(input.snippets.map((s) => s.ref))
    for (const insight of insights) {
      expect(insight.evidence.length).toBeGreaterThan(0)
      for (const cited of insight.evidence) expect(refs.has(cited.ref)).toBe(true)
      expect(insight.score).toBeGreaterThanOrEqual(0)
      expect(insight.score).toBeLessThanOrEqual(100)
    }
  })

  it('honors the learning loop: a previously DISMISSED (kind, title) is never re-proposed', async () => {
    const first = await provider.generateInsights(baseInput())
    const target = first.insights[0]
    expect(target).toBeDefined()

    const withFeedback = baseInput()
    withFeedback.priorFeedback = [
      {
        kind: target.kind,
        title: ` ${target.title.toUpperCase()} `, // dedupe identity is case/whitespace-insensitive
        status: 'DISMISSED',
        reviewNote: 'Not actionable for us.',
        outcome: null,
      },
    ]
    const second = await provider.generateInsights(withFeedback)
    expect(second.insights.map((i) => i.title)).not.toContain(target.title)
    // ACCEPTED feedback must not suppress anything.
    const accepted = baseInput()
    accepted.priorFeedback = [
      { kind: target.kind, title: target.title, status: 'ACCEPTED', reviewNote: null, outcome: null },
    ]
    expect((await provider.generateInsights(accepted)).insights).toEqual(first.insights)
  })

  it('falls back to a single low-score operations note when no KPI trips a threshold', async () => {
    const calm = baseInput()
    calm.kpis = {
      core: { closeRate: 60, won: 9, lost: 1, medianSpeedToContactHours: 2 },
      marketing: { costPerLead: 20 },
    }
    calm.snippets = [calm.snippets[0], calm.snippets[2]] // no at-risk client snippets
    const { insights } = await new MockAIProvider().generateInsights(calm)
    expect(insights).toHaveLength(1)
    expect(insights[0].kind).toBe('operations')
  })
})
