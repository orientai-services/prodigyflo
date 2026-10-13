import { afterEach, describe, expect, it, vi } from 'vitest'
import { allowedAccountsForOrg } from './allowlist'
import { buildTree, type TreeAd } from './tree'
import { onlyAccount, rangeText, reportAccount, spentCounterText, totalsOfRows } from './scope'
import type { MetricSums } from './metrics'

vi.mock('server-only', () => ({}))

const BOUND = 'cmtx2mtf7000004lb2so1n1qe'
const SCS = 'act_1742876583597558'
const FOREIGN = 'act_999000111222333' // the test-only fake foreign account

afterEach(() => vi.unstubAllEnvs())

function bindProd() {
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('META_ADS_ORG_ID', BOUND)
  vi.stubEnv('META_ALLOWED_AD_ACCOUNTS', SCS)
}

describe('reportAccount', () => {
  it('reports only the allowlisted account, never another one', () => {
    bindProd()
    const allowed = allowedAccountsForOrg(BOUND)
    expect(allowed).toEqual([SCS])
    expect(reportAccount(allowed, SCS)).toBe(SCS)
    expect(reportAccount(allowed, FOREIGN)).toBeNull()
    expect(reportAccount(allowed, null)).toBeNull()
    expect(reportAccount(allowedAccountsForOrg('some_other_org'), SCS)).toBeNull()
  })
})

describe('onlyAccount', () => {
  it('drops rows stored for any other ad account', () => {
    const rows = [
      { adAccountId: SCS, spend: 341.69 },
      { adAccountId: FOREIGN, spend: 999 },
      { adAccountId: null, spend: 5 },
    ]
    const kept = onlyAccount(rows, SCS)
    expect(kept).toEqual([{ adAccountId: SCS, spend: 341.69 }])
    expect(kept.reduce((a, r) => a + r.spend, 0)).toBe(341.69)
  })
})

const sums = (spend: number, leads = 0): MetricSums => ({
  spend, impressions: Math.round(spend * 33), reach: null, clicks: 3, linkClicks: 2, leads, landingPageViews: 1, frequency: null,
})
const ad = (externalId: string, campaignId: string, adSetId: string, over: Partial<TreeAd> = {}): TreeAd => ({
  id: `l_${externalId}`, externalId, campaignId, adSetId, name: externalId, status: 'ACTIVE', effectiveStatus: 'ACTIVE', removed: false,
  thumbnailUrl: null, headline: null, body: null, cta: null, linkUrl: null, ...over,
})

describe('totalsOfRows (the bottom row of the ads table)', () => {
  const campaigns = [
    { id: 'c1', externalId: '61', name: 'C1', status: 'PAUSED', objective: null, dailyBudget: null, lifetimeBudget: null },
    { id: 'c2', externalId: '62', name: 'C2', status: 'PAUSED', objective: null, dailyBudget: null, lifetimeBudget: null },
  ]
  const adSets = [
    { id: 's1', externalId: '71', campaignId: 'c1', name: 'S1', status: 'PAUSED', dailyBudget: null, lifetimeBudget: null },
    { id: 's2', externalId: '72', campaignId: 'c2', name: 'S2', status: 'PAUSED', dailyBudget: null, lifetimeBudget: null },
  ]
  const ads = [ad('a1', 'c1', 's1'), ad('a2', 'c1', 's1'), ad('a3', 'c2', 's2')]

  it('equals the sum of the rows shown above it, to the cent', () => {
    const adSums = new Map([['a1', sums(100.1, 1)], ['a2', sums(0.2)], ['a3', sums(241.39, 2)]])
    const { tree } = buildTree({ campaigns, adSets, ads, adSums, account: sums(341.69, 3) })
    const t = totalsOfRows(tree)
    const rowSpend = tree.reduce((a, r) => a + r.metrics.spend, 0)
    expect(t.spend).toBe(Math.round(rowSpend * 100) / 100)
    expect(t.spend).toBe(341.69)
    expect(t.leads).toBe(tree.reduce((a, r) => a + r.metrics.leads, 0))
    expect(t.impressions).toBe(tree.reduce((a, r) => a + r.metrics.impressions, 0))
  })

  it('includes the removed-ads row so it still matches the account total', () => {
    const adSums = new Map([['a1', sums(100)], ['a3', sums(200)]])
    const { tree } = buildTree({ campaigns, adSets, ads, adSums, account: sums(341.69) })
    expect(tree.at(-1)?.kind).toBe('remainder')
    expect(totalsOfRows(tree).spend).toBe(341.69)
  })

  it('is zero for an empty table', () => {
    expect(totalsOfRows([]).spend).toBe(0)
  })
})

describe('labels', () => {
  it('names the period with calendar days', () => {
    expect(rangeText(new Date('2026-09-13T00:00:00Z'), new Date('2026-10-12T00:00:00Z'))).toBe('Sep 13 – Oct 12')
    expect(rangeText('2026-10-13', '2026-10-13')).toBe('Oct 13')
    expect(rangeText(null, '2026-10-13')).toBeNull()
  })

  it("never calls Meta's amount_spent 'all time' while a spending limit is set", () => {
    expect(spentCounterText(500).label).toBe('Spent toward account limit')
    expect(spentCounterText(500).label).not.toMatch(/all time/i)
    expect(spentCounterText(null).label).toMatch(/all time/i)
  })
})
