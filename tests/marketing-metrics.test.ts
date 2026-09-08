import { describe, expect, it } from 'vitest'
import {
  bucketWeekly,
  costPer,
  deltaPct,
  marketingRange,
  rollupByCampaign,
  rollupBySource,
  rollupFunnel,
  type CampaignStat,
  type MarketingClientRow,
} from '@/lib/marketing-metrics'

// ── fixtures ─────────────────────────────────────────────────

const NOW = new Date(2026, 7, 24, 12) // Aug 24 2026, noon

const client = (overrides: Partial<MarketingClientRow> = {}): MarketingClientRow => ({
  leadSourceId: null,
  campaignId: null,
  createdAt: NOW,
  reachedQualified: false,
  reachedWon: false,
  ...overrides,
})

const SOURCES = [
  { id: 'src_fb', name: 'Facebook', channel: 'facebook', isActive: true },
  { id: 'src_ref', name: 'Referrals', channel: 'referral', isActive: true },
  { id: 'src_old', name: 'Retired list', channel: 'other', isActive: false },
]

const CAMPAIGNS = [
  { id: 'camp_a', name: 'Solar Regret A', channel: 'facebook', sourceName: 'Facebook', status: 'active' },
  { id: 'camp_b', name: 'Brand B', channel: 'google', sourceName: null, status: 'active' },
  { id: 'camp_dead', name: 'Dormant', channel: 'facebook', sourceName: null, status: 'paused' },
]

// ── marketingRange ───────────────────────────────────────────

describe('marketingRange', () => {
  it('defaults to 30 days and rejects unknown values', () => {
    expect(marketingRange(undefined).key).toBe('30')
    expect(marketingRange('all').key).toBe('30')
    expect(marketingRange('7').key).toBe('30')
  })

  it('accepts 60 and 90', () => {
    expect(marketingRange('60').days).toBe(60)
    expect(marketingRange('90').days).toBe(90)
  })

  it('sets from and prevFrom to equal back-to-back windows', () => {
    const r = marketingRange('60', NOW)
    expect(NOW.getTime() - r.from.getTime()).toBe(60 * 86_400_000)
    expect(r.from.getTime() - r.prevFrom.getTime()).toBe(60 * 86_400_000)
    expect(r.label).toBe('Last 60 days')
  })
})

// ── rollupFunnel ─────────────────────────────────────────────

describe('rollupFunnel', () => {
  it('counts leads, qualified, and won with rates', () => {
    const rows = [
      client(),
      client({ reachedQualified: true }),
      client({ reachedQualified: true, reachedWon: true }),
      client(),
    ]
    const f = rollupFunnel(rows)
    expect(f.leads).toBe(4)
    expect(f.qualified).toBe(2)
    expect(f.won).toBe(1)
    expect(f.qualifiedRate).toBe(50)
    expect(f.wonRate).toBe(25)
  })

  it('returns null rates on an empty set, never NaN', () => {
    const f = rollupFunnel([])
    expect(f.leads).toBe(0)
    expect(f.qualifiedRate).toBeNull()
    expect(f.wonRate).toBeNull()
  })
})

// ── rollupBySource ───────────────────────────────────────────

describe('rollupBySource', () => {
  it('groups by source, keeps zero-lead sources, and sorts by volume', () => {
    const rows = [
      client({ leadSourceId: 'src_ref' }),
      client({ leadSourceId: 'src_fb', reachedQualified: true }),
      client({ leadSourceId: 'src_fb', reachedQualified: true, reachedWon: true }),
      client({ leadSourceId: null }), // unattributed — never lands in a source bucket
    ]
    const out = rollupBySource(rows, SOURCES)
    expect(out.map((s) => s.id)).toEqual(['src_fb', 'src_ref', 'src_old'])
    const fb = out[0]
    expect(fb.leads).toBe(2)
    expect(fb.qualified).toBe(2)
    expect(fb.won).toBe(1)
    expect(fb.qualifiedRate).toBe(100)
    expect(fb.wonRate).toBe(50)
    expect(out[2].leads).toBe(0)
    expect(out[2].qualifiedRate).toBeNull()
  })

  it('ignores rows pointing at unknown sources', () => {
    const out = rollupBySource([client({ leadSourceId: 'src_gone' })], SOURCES)
    expect(out.every((s) => s.leads === 0)).toBe(true)
  })
})

// ── rollupByCampaign ─────────────────────────────────────────

describe('rollupByCampaign', () => {
  const stats = new Map<string, CampaignStat>([
    ['camp_a', { spend: 500, impressions: 10_000, clicks: 200, leads: 12 }],
  ])

  it('joins CRM funnel with ad stats and computes unit costs', () => {
    const rows = [
      client({ campaignId: 'camp_a', reachedQualified: true }),
      client({ campaignId: 'camp_a', reachedQualified: true, reachedWon: true }),
      client({ campaignId: 'camp_a' }),
      client({ campaignId: 'camp_b' }),
    ]
    const out = rollupByCampaign(rows, CAMPAIGNS, stats)
    const a = out.find((c) => c.id === 'camp_a')!
    expect(a.leads).toBe(3)
    expect(a.adLeads).toBe(12)
    expect(a.spend).toBe(500)
    expect(a.costPerLead).toBeCloseTo(500 / 3)
    expect(a.costPerQualified).toBe(250)
    expect(a.ctr).toBe(2)
  })

  it('drops campaigns with no activity and null-costs spendless ones', () => {
    const rows = [client({ campaignId: 'camp_b' })]
    const out = rollupByCampaign(rows, CAMPAIGNS, stats)
    expect(out.map((c) => c.id)).toEqual(['camp_a', 'camp_b']) // spend first
    expect(out.find((c) => c.id === 'camp_dead')).toBeUndefined()
    const b = out.find((c) => c.id === 'camp_b')!
    expect(b.costPerLead).toBeNull() // no spend → no CPL, never $0.00
    expect(b.ctr).toBeNull()
  })
})

// ── costPer / deltaPct / bucketWeekly ────────────────────────

describe('costPer', () => {
  it('divides spend by count', () => {
    expect(costPer(100, 4)).toBe(25)
  })
  it('is null with zero spend or zero count', () => {
    expect(costPer(0, 10)).toBeNull()
    expect(costPer(100, 0)).toBeNull()
  })
})

describe('deltaPct', () => {
  it('computes percentage change', () => {
    expect(deltaPct(30, 20)).toBe(50)
    expect(deltaPct(10, 20)).toBe(-50)
  })
  it('is null when there is no prior base', () => {
    expect(deltaPct(5, 0)).toBeNull()
  })
})

describe('bucketWeekly', () => {
  it('buckets dates into weeks, oldest first, covering the whole range', () => {
    const dates = [
      new Date(NOW.getTime() - 1 * 86_400_000), // this week
      new Date(NOW.getTime() - 2 * 86_400_000), // this week
      new Date(NOW.getTime() - 10 * 86_400_000), // last week
      new Date(NOW.getTime() - 29 * 86_400_000), // oldest (partial) bucket
    ]
    const out = bucketWeekly(dates, 30, NOW)
    expect(out).toHaveLength(5) // ceil(30/7)
    expect(out[out.length - 1].count).toBe(2)
    expect(out[out.length - 2].count).toBe(1)
    expect(out[0].count).toBe(1)
    expect(out.reduce((sum, b) => sum + b.count, 0)).toBe(4)
  })

  it('returns all-zero buckets with no dates', () => {
    const out = bucketWeekly([], 60, NOW)
    expect(out).toHaveLength(9)
    expect(out.every((b) => b.count === 0)).toBe(true)
  })
})
