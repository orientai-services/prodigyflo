import { describe, expect, it } from 'vitest'
import type { InsightProposal } from '@/lib/ai/provider'
import {
  dedupeInsightProposals,
  insightDedupeKey,
  kpiDelta,
  normalizeInsightTitle,
} from '@/lib/engine/insight-rules'

const proposal = (kind: InsightProposal['kind'], title: string): InsightProposal => ({
  kind,
  title,
  body: 'body',
  evidence: [{ source: 'clients', ref: 'analytics:stage-counts', text: 'evidence' }],
  score: 50,
})

describe('insight dedupe', () => {
  it('normalizes case and whitespace into one identity', () => {
    expect(normalizeInsightTitle('  Close   Rate is LOW ')).toBe('close rate is low')
    expect(insightDedupeKey('pipeline', 'Close Rate is low')).toBe(
      insightDedupeKey('pipeline', '  close   rate IS low '),
    )
  })

  it('drops proposals already open under the same (kind, title)', () => {
    const fresh = dedupeInsightProposals(
      [proposal('pipeline', 'Close rate is below 25%'), proposal('marketing', 'Cost per lead is above $100')],
      [{ kind: 'pipeline', title: 'close RATE is below 25%' }],
    )
    expect(fresh.map((p) => p.title)).toEqual(['Cost per lead is above $100'])
  })

  it('keeps the same title under a different kind — a different insight', () => {
    const fresh = dedupeInsightProposals(
      [proposal('risk', 'Follow-ups are slipping')],
      [{ kind: 'engagement', title: 'Follow-ups are slipping' }],
    )
    expect(fresh).toHaveLength(1)
  })

  it('collapses duplicates within the batch itself, first one winning, order preserved', () => {
    const fresh = dedupeInsightProposals(
      [
        proposal('pipeline', 'A'),
        proposal('risk', 'B'),
        proposal('pipeline', ' a '),
        proposal('pipeline', 'C'),
      ],
      [],
    )
    expect(fresh.map((p) => p.title)).toEqual(['A', 'B', 'C'])
  })

  it('returns everything untouched when nothing collides', () => {
    const input = [proposal('pipeline', 'A'), proposal('risk', 'B')]
    expect(dedupeInsightProposals(input, [{ kind: 'marketing', title: 'C' }])).toEqual(input)
  })
})

describe('kpiDelta', () => {
  it('computes before/after/change for fields numeric in both snapshots', () => {
    expect(
      kpiDelta(
        { closeRate: 18.5, won: 4, avgDealSize: null, label: 'x' },
        { closeRate: 22.25, won: 6, avgDealSize: 12_000, label: 'y' },
      ),
    ).toEqual({
      closeRate: { before: 18.5, after: 22.25, change: 3.75 },
      won: { before: 4, after: 6, change: 2 },
    })
  })

  it('skips non-finite and missing values instead of guessing', () => {
    expect(kpiDelta({ a: Number.NaN, b: 1, c: 2 }, { a: 1, b: Number.POSITIVE_INFINITY })).toEqual({})
  })
})
