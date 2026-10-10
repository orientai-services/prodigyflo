import { describe, expect, it } from 'vitest'
import { buildTree, type TreeAd } from './tree'
import type { MetricSums } from './metrics'

const sums = (spend: number, leads = 0, impressions = spend * 100, linkClicks = spend): MetricSums => ({
  spend, impressions, reach: Math.round(impressions * 0.6), clicks: linkClicks + 1, linkClicks, leads, landingPageViews: 0, frequency: null,
})

const ad = (externalId: string, campaignId: string, adSetId: string | null, over: Partial<TreeAd> = {}): TreeAd => ({
  id: `l_${externalId}`, externalId, campaignId, adSetId, name: `Ad ${externalId}`, status: 'ACTIVE', effectiveStatus: 'ACTIVE', removed: false,
  thumbnailUrl: 'https://x.test/t.jpg', headline: 'H', body: 'B', cta: 'Learn more', linkUrl: 'https://www.example.com/p?q=1', ...over,
})

const base = () => ({
  campaigns: [
    { id: 'c1', externalId: '61', name: 'C1', status: 'ACTIVE', objective: 'OUTCOME_LEADS', dailyBudget: 50, lifetimeBudget: null },
    { id: 'c2', externalId: '62', name: 'C2', status: 'PAUSED', objective: null, dailyBudget: null, lifetimeBudget: 1000 },
  ],
  adSets: [
    { id: 's1', externalId: '71', campaignId: 'c1', name: 'S1', status: 'ACTIVE', dailyBudget: 30, lifetimeBudget: null },
    { id: 's2', externalId: '72', campaignId: 'c2', name: 'S2', status: 'PAUSED', dailyBudget: null, lifetimeBudget: null },
  ],
  ads: [
    ad('81', 'c1', 's1'),
    ad('82', 'c1', 's1'),
    ad('83', 'c2', 's2', { effectiveStatus: 'ARCHIVED', status: 'ARCHIVED' }),
    ad('84', 'c2', 's2', { removed: true }), // removed with no spend in the window: hidden
    ad('85', 'c2', 's2', { removed: true }), // removed but spent: kept so totals add up
  ],
})

describe('buildTree', () => {
  it('ratio of sums at every level; the archived ad and a remainder row make it add up', () => {
    const adSums = new Map<string, MetricSums>([['81', sums(100, 5)], ['82', sums(50, 0)], ['83', sums(20, 1)], ['85', sums(5, 0)]])
    const account = sums(180, 7)
    const { tree, treeSums } = buildTree({ ...base(), adSums, account })

    const c1 = tree.find((n) => n.kind === 'campaign' && n.id === 'c1')
    expect(c1 && c1.kind === 'campaign' ? c1.metrics.spend : 0).toBe(150)
    expect(c1 && c1.kind === 'campaign' ? c1.metrics.cpl : 0).toBe(30) // 150 / 5, not the average of ad CPLs
    expect(c1 && c1.kind === 'campaign' ? c1.metrics.reach : 0).toBeNull() // reach never sums

    const c2 = tree.find((n) => n.kind === 'campaign' && n.id === 'c2')
    const c2Ads = c2 && c2.kind === 'campaign' ? c2.adSets[0].ads : []
    expect(c2Ads.map((a) => a.externalId).sort()).toEqual(['83', '85'])
    expect(c2Ads.find((a) => a.externalId === '83')!.removed).toBe(true)

    const rest = tree[tree.length - 1]
    expect(rest.kind).toBe('remainder')
    expect(rest.metrics.spend).toBe(5)
    expect(rest.name).toBe('Removed or archived ads')

    const total = tree.reduce((a, n) => a + n.metrics.spend, 0)
    expect(Math.round(total * 100) / 100).toBe(account.spend)
    expect(Math.round(treeSums.spend * 100) / 100).toBe(account.spend)
  })
  it('no remainder row when the tree already equals the account total', () => {
    const adSums = new Map<string, MetricSums>([['81', sums(100)], ['82', sums(80)]])
    const { tree } = buildTree({ ...base(), adSums, account: sums(180) })
    expect(tree.some((n) => n.kind === 'remainder')).toBe(false)
  })
  it('creative carries the link host only', () => {
    const { tree } = buildTree({ ...base(), adSums: new Map([['81', sums(1)]]), account: sums(1) })
    const c1 = tree.find((n) => n.kind === 'campaign' && n.id === 'c1')
    const a = c1 && c1.kind === 'campaign' ? c1.adSets[0].ads.find((x) => x.externalId === '81')! : null
    expect(a?.creative.linkHost).toBe('example.com')
    expect(JSON.stringify(a)).not.toContain('?q=1')
  })
})
