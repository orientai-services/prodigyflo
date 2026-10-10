import { addSums, computeMetrics, ZERO_SUMS, type Metrics, type MetricSums } from './metrics'
import { linkHost, safeThumbnail } from './creative'

/**
 * Campaign → ad set → ad tree (B5). Campaign and ad set numbers are the ratio
 * of the sums of their ads. When the account total is more than the tree total
 * (spend on ads Meta no longer lists, or rounding across levels), the tree ends
 * with a "Removed or archived ads" row so it always sums to the account total.
 */

export type AdFlags = { zeroLeadStreakDays: number; highFrequency: boolean; lowCtr: boolean }

export type AdNode = {
  id: string
  externalId: string
  name: string
  status: string
  effectiveStatus: string | null
  removed: boolean
  metrics: Metrics
  creative: { thumbnailUrl: string | null; headline: string | null; body: string | null; cta: string | null; linkHost: string | null }
  flags: AdFlags
}
export type AdSetNode = {
  id: string
  externalId: string
  name: string
  status: string
  dailyBudget: number | null
  lifetimeBudget: number | null
  metrics: Metrics
  ads: AdNode[]
}
export type CampaignNode = {
  kind: 'campaign'
  id: string
  externalId: string
  name: string
  status: string
  objective: string | null
  dailyBudget: number | null
  lifetimeBudget: number | null
  metrics: Metrics
  adSets: AdSetNode[]
}
export type RemainderNode = { kind: 'remainder'; name: 'Removed or archived ads'; metrics: Metrics }

export type TreeCampaign = {
  id: string; externalId: string; name: string; status: string; objective: string | null
  dailyBudget: number | null; lifetimeBudget: number | null
}
export type TreeAdSet = {
  id: string; externalId: string; campaignId: string; name: string; status: string
  dailyBudget: number | null; lifetimeBudget: number | null
}
export type TreeAd = {
  id: string; externalId: string; campaignId: string; adSetId: string | null; name: string; status: string
  effectiveStatus: string | null; removed: boolean
  thumbnailUrl: string | null; headline: string | null; body: string | null; cta: string | null; linkUrl: string | null
}

const NO_FLAGS: AdFlags = { zeroLeadStreakDays: 0, highFrequency: false, lowCtr: false }

export function buildTree(input: {
  campaigns: TreeCampaign[]
  adSets: TreeAdSet[]
  ads: TreeAd[]
  /** Window sums per ad external id (MetaInsightSummary, level AD). */
  adSums: Map<string, MetricSums>
  adFlags?: Map<string, AdFlags>
  /** Window sums for the account (MetaInsightSummary, level ACCOUNT). */
  account: MetricSums
}): { tree: (CampaignNode | RemainderNode)[]; treeSums: MetricSums } {
  const flags = input.adFlags ?? new Map<string, AdFlags>()
  const adsBySet = new Map<string, TreeAd[]>()
  const looseByCampaign = new Map<string, TreeAd[]>()
  for (const ad of input.ads) {
    const sums = input.adSums.get(ad.externalId)
    // A removed ad with nothing in this window is noise; one with spend stays so totals add up.
    if (ad.removed && !(sums && sums.spend > 0)) continue
    if (ad.adSetId) adsBySet.set(ad.adSetId, [...(adsBySet.get(ad.adSetId) ?? []), ad])
    else looseByCampaign.set(ad.campaignId, [...(looseByCampaign.get(ad.campaignId) ?? []), ad])
  }

  const adNode = (ad: TreeAd): { node: AdNode; sums: MetricSums } => {
    const sums = input.adSums.get(ad.externalId) ?? ZERO_SUMS
    return {
      sums,
      node: {
        id: ad.id,
        externalId: ad.externalId,
        name: ad.name,
        status: ad.status,
        effectiveStatus: ad.effectiveStatus,
        removed: ad.removed || ad.effectiveStatus === 'ARCHIVED' || ad.effectiveStatus === 'DELETED',
        metrics: computeMetrics(sums),
        creative: {
          thumbnailUrl: safeThumbnail(ad.thumbnailUrl),
          headline: ad.headline,
          body: ad.body,
          cta: ad.cta,
          linkHost: linkHost(ad.linkUrl),
        },
        flags: flags.get(ad.externalId) ?? NO_FLAGS,
      },
    }
  }

  let treeSums: MetricSums = { ...ZERO_SUMS, reach: null }
  const campaigns: CampaignNode[] = []
  for (const c of input.campaigns) {
    let cSums: MetricSums = { ...ZERO_SUMS, reach: null }
    const adSets: AdSetNode[] = []
    for (const s of input.adSets.filter((x) => x.campaignId === c.id)) {
      let sSums: MetricSums = { ...ZERO_SUMS, reach: null }
      const ads: AdNode[] = []
      for (const ad of adsBySet.get(s.id) ?? []) {
        const { node, sums } = adNode(ad)
        ads.push(node)
        sSums = addSums(sSums, sums)
      }
      ads.sort((a, b) => b.metrics.spend - a.metrics.spend)
      adSets.push({
        id: s.id, externalId: s.externalId, name: s.name, status: s.status,
        dailyBudget: s.dailyBudget, lifetimeBudget: s.lifetimeBudget, metrics: computeMetrics(sSums), ads,
      })
      cSums = addSums(cSums, sSums)
    }
    const loose = looseByCampaign.get(c.id) ?? []
    if (loose.length) {
      let lSums: MetricSums = { ...ZERO_SUMS, reach: null }
      const ads = loose.map((ad) => {
        const r = adNode(ad)
        lSums = addSums(lSums, r.sums)
        return r.node
      })
      adSets.push({
        id: `${c.id}:no-ad-set`, externalId: '', name: 'Ads without an ad set', status: 'unknown',
        dailyBudget: null, lifetimeBudget: null, metrics: computeMetrics(lSums), ads,
      })
      cSums = addSums(cSums, lSums)
    }
    adSets.sort((a, b) => b.metrics.spend - a.metrics.spend)
    campaigns.push({
      kind: 'campaign', id: c.id, externalId: c.externalId, name: c.name, status: c.status, objective: c.objective,
      dailyBudget: c.dailyBudget, lifetimeBudget: c.lifetimeBudget, metrics: computeMetrics(cSums), adSets,
    })
    treeSums = addSums(treeSums, cSums)
  }
  campaigns.sort((a, b) => b.metrics.spend - a.metrics.spend)

  const tree: (CampaignNode | RemainderNode)[] = [...campaigns]
  const gap = Math.round((input.account.spend - treeSums.spend) * 100) / 100
  if (gap >= 0.01) {
    const rest: MetricSums = {
      spend: gap,
      impressions: Math.max(0, input.account.impressions - treeSums.impressions),
      reach: null,
      clicks: Math.max(0, input.account.clicks - treeSums.clicks),
      linkClicks: Math.max(0, input.account.linkClicks - treeSums.linkClicks),
      leads: Math.max(0, input.account.leads - treeSums.leads),
      landingPageViews: Math.max(0, input.account.landingPageViews - treeSums.landingPageViews),
      frequency: null,
    }
    tree.push({ kind: 'remainder', name: 'Removed or archived ads', metrics: computeMetrics(rest) })
    treeSums = addSums(treeSums, rest)
  }
  return { tree, treeSums }
}
