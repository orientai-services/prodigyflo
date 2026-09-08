import type { InsightProposal } from '@/lib/ai/provider'

/**
 * Pure insight-engine rules — no database, no clock, no provider. Kept
 * separate from `insights.ts` so both the DAG steps and the mock provider can
 * share one deduplication identity, and so the logic unit-tests without
 * touching Postgres.
 */

/** Whitespace- and case-insensitive title identity for deduplication. */
export function normalizeInsightTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** The (kind, title) identity an insight deduplicates on. */
export function insightDedupeKey(kind: string, title: string): string {
  return `${kind}|${normalizeInsightTitle(title)}`
}

/**
 * Drops proposals whose (kind, title) already exists among the org's open
 * insights, and collapses duplicates within the batch itself (first one wins,
 * order preserved). The same title under a different kind is a different
 * insight and survives.
 */
export function dedupeInsightProposals(
  proposals: InsightProposal[],
  open: { kind: string; title: string }[],
): InsightProposal[] {
  const seen = new Set(open.map((o) => insightDedupeKey(o.kind, o.title)))
  const fresh: InsightProposal[] = []
  for (const proposal of proposals) {
    const key = insightDedupeKey(proposal.kind, proposal.title)
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(proposal)
  }
  return fresh
}

export type KpiDelta = Record<string, { before: number; after: number; change: number }>

/**
 * Numeric-field delta between two KPI snapshots — the measured outcome written
 * back onto an accepted insight. Only keys that are finite numbers in BOTH
 * snapshots appear; everything else (nulls, strings, nested objects) is
 * skipped rather than guessed at.
 */
export function kpiDelta(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
): KpiDelta {
  const delta: KpiDelta = {}
  for (const [key, before] of Object.entries(baseline)) {
    const after = current[key]
    if (
      typeof before === 'number' &&
      Number.isFinite(before) &&
      typeof after === 'number' &&
      Number.isFinite(after)
    ) {
      delta[key] = { before, after, change: Math.round((after - before) * 100) / 100 }
    }
  }
  return delta
}
