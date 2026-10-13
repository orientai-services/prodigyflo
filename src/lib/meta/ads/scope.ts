import { addSums, computeMetrics, ZERO_SUMS, type Metrics, type MetricSums } from './metrics'
import type { CampaignNode, RemainderNode } from './tree'

/**
 * One ad account per view (owner rule, 2026-10-13): every number on the Ads
 * tab belongs to the one approved ad account, and says which period it covers.
 * Pure helpers, shared by the read model and its tests.
 */

/**
 * The account a report may read: `candidate` only when it is on `allowed`
 * (the workspace's allowlist, see allowedAccountsForOrg), else null.
 */
export function reportAccount(allowed: readonly string[], candidate: string | null | undefined): string | null {
  if (!candidate) return null
  return allowed.includes(candidate) ? candidate : null
}

/**
 * Belt and braces after the query: drops any row whose ad account isn't the
 * reported one, so a row stored for another account can never be summed in.
 */
export function onlyAccount<T extends { adAccountId: string | null }>(rows: readonly T[], account: string): T[] {
  return rows.filter((r) => r.adAccountId === account)
}

/** The bottom "Total" row of the ads table: the sum of the rows shown above it, nothing else. */
export function totalsOfRows(rows: readonly (CampaignNode | RemainderNode)[]): Metrics {
  let s: MetricSums = { ...ZERO_SUMS, reach: null }
  for (const r of rows) {
    const m = r.metrics
    s = addSums(s, {
      spend: m.spend, impressions: m.impressions, reach: null, clicks: m.clicks, linkClicks: m.linkClicks,
      leads: m.leads, landingPageViews: m.landingPageViews, frequency: null,
    })
  }
  return computeMetrics(s)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'YYYY-MM-DD' (or a Date holding that calendar day at UTC midnight) → 'Sep 13'. */
export function shortDay(d: string | Date): string {
  const iso = typeof d === 'string' ? d : d.toISOString().slice(0, 10)
  const [, m, day] = iso.split('-').map(Number)
  return `${MONTHS[m - 1]} ${day}`
}

/** "Sep 13 – Oct 12" for a summary's date range; null when Meta gave none. */
export function rangeText(start: string | Date | null | undefined, stop: string | Date | null | undefined): string | null {
  if (!start || !stop) return null
  const a = shortDay(start)
  const b = shortDay(stop)
  return a === b ? a : `${a} – ${b}`
}

/**
 * Meta's `amount_spent` is the spend counted toward the account spending
 * limit: it restarts at $0 whenever the limit is reset, so with a limit set it
 * is NOT all-time spend. Without a limit it is the account's lifetime total.
 */
export function spentCounterText(spendCap: number | null): { label: string; tip: string } {
  if (spendCap !== null) {
    return {
      label: 'Spent toward account limit',
      tip:
        "Meta's running count toward the account spending limit. It starts again at $0 whenever the limit is reset, so it is usually lower than all-time spend.",
    }
  }
  return { label: 'Spent all time (Meta billing)', tip: "Meta's lifetime spend counter for this ad account." }
}
