import 'server-only'
import { getCloseOpsConfig, getCloseOpsMetrics, phaseDef } from '@/lib/closeops'
import { getOverdueSummary } from '@/lib/reporting'
import { getHygieneReport } from '@/lib/hygiene'
import { getScoreboard } from '@/lib/scoreboard'
import { getQualifierCoverage } from '@/lib/qualifier'
import type { SessionUser } from '@/lib/rbac'

/**
 * The Attention feed — the synthesis layer over every operating metric.
 *
 * The phase dashboards, scoreboard, hygiene report and qualifier queue each
 * answer "how are we doing on X?". This module answers the one question a
 * manager actually opens the app with: "what needs a decision from me right
 * now?" It re-reads the SAME scoped reports (never a fresh raw query, so
 * clientScope is always enforced upstream), runs a small pure detector over
 * each, and returns only the items that are genuinely off-target.
 *
 * Every detector is a pure `(numbers) -> item | null` function so the "is this
 * worth surfacing, and how loud?" judgement is transparent and unit-tested.
 * getAttentionItems only orchestrates: fetch in parallel, guard each report,
 * run the detectors, sort. It never throws because one report came back empty.
 */

export type AttentionSeverity = 'critical' | 'warning' | 'info'

export type AttentionCategory =
  | 'leakage'
  | 'close-rate'
  | 'brief-adoption'
  | 'overdue'
  | 'sla'
  | 'qualifier'
  | 'hygiene'
  | 'coverage'

export type AttentionItem = {
  /** Stable id for the detector — one item per detector, so also a de-dupe key. */
  key: string
  severity: AttentionSeverity
  title: string
  /** One concrete sentence carrying the actual number. */
  detail: string
  /** The magnitude behind the item, when it is a countable pile. */
  count?: number
  /** Where the manager goes to act on it. */
  href: string
  category: AttentionCategory
}

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Below this many decided leads the close rate is too noisy to judge. */
export const CLOSE_RATE_MIN_SAMPLE = 10
/** AI Brief adoption target: a brief viewed before every call. */
export const BRIEF_ADOPTION_TARGET = 80
/** Hygiene score at or above this reads as a healthy book. */
export const HYGIENE_HEALTHY_SCORE = 80
/** Window the "closer gone cold" detector looks back over. */
export const COLD_CLOSER_RANGE_DAYS = 30

// ── Pure detectors (unit-tested in attention.test.ts) ────────────────────────

/**
 * Live leads leaking past the phase's leakage ceiling. Warning over the target,
 * critical once leakage runs to twice the ceiling.
 */
export function leakageItem(input: {
  leakagePct: number | null
  leakingCount: number
  liveCount: number
  leakageDays: number
  targetPct: number
}): AttentionItem | null {
  const { leakagePct, leakingCount, liveCount, leakageDays, targetPct } = input
  if (leakagePct === null || leakingCount <= 0) return null
  if (leakagePct <= targetPct) return null
  const severity: AttentionSeverity = leakagePct >= targetPct * 2 ? 'critical' : 'warning'
  return {
    key: 'lead-leakage',
    severity,
    title: 'Lead leakage above target',
    detail: `${leakingCount} of ${liveCount} live leads (${leakagePct}%) have gone untouched past the ${leakageDays}-day window — over the ${targetPct}% phase ceiling.`,
    count: leakingCount,
    href: '/sales/huddle',
    category: 'leakage',
  }
}

/**
 * Close rate on qualified leads sitting under the phase target, but only once
 * enough deals have actually been decided to trust the number.
 */
export function closeRateItem(input: {
  closeRatePct: number | null
  decided: number
  targetPct: number
  minSample?: number
}): AttentionItem | null {
  const { closeRatePct, decided, targetPct } = input
  const minSample = input.minSample ?? CLOSE_RATE_MIN_SAMPLE
  if (closeRatePct === null || decided < minSample) return null
  if (closeRatePct >= targetPct) return null
  return {
    key: 'close-rate',
    severity: 'warning',
    title: 'Close rate below phase target',
    detail: `Qualified leads are closing at ${closeRatePct}% against the ${targetPct}% phase target (n=${decided} decided).`,
    href: '/performance',
    category: 'close-rate',
  }
}

/**
 * AI Brief adoption under target when there are calls to judge it on. A steep
 * miss (under 60% of target) reads as a warning, a modest one as info.
 */
export function briefAdoptionItem(input: {
  adoptionPct: number | null
  callsTotal: number
  target?: number
}): AttentionItem | null {
  const target = input.target ?? BRIEF_ADOPTION_TARGET
  const { adoptionPct, callsTotal } = input
  if (adoptionPct === null || callsTotal <= 0) return null
  if (adoptionPct >= target) return null
  const severity: AttentionSeverity = adoptionPct < target * 0.6 ? 'warning' : 'info'
  return {
    key: 'brief-adoption',
    severity,
    title: 'AI Brief adoption below target',
    detail: `Closers viewed an AI Brief before only ${adoptionPct}% of ${callsTotal} calls — the target is a brief on every call.`,
    href: '/performance',
    category: 'brief-adoption',
  }
}

/** Open follow-up tasks past their due date. Louder the taller the pile. */
export function overdueItem(input: { overdueTasks: number }): AttentionItem | null {
  const { overdueTasks } = input
  if (overdueTasks <= 0) return null
  const severity: AttentionSeverity =
    overdueTasks >= 20 ? 'critical' : overdueTasks >= 8 ? 'warning' : 'info'
  return {
    key: 'overdue-tasks',
    severity,
    title: 'Overdue follow-ups piling up',
    detail: `${overdueTasks} follow-up ${overdueTasks === 1 ? 'task is' : 'tasks are'} past due across your book.`,
    count: overdueTasks,
    href: '/reports/overdue',
    category: 'overdue',
  }
}

/** Active clients whose stage SLA expired with no activity since the deadline. */
export function slaItem(input: { slaExpired: number }): AttentionItem | null {
  const { slaExpired } = input
  if (slaExpired <= 0) return null
  return {
    key: 'sla-expired',
    severity: 'warning',
    title: 'Clients past their stage SLA',
    detail: `${slaExpired} active ${slaExpired === 1 ? 'client has' : 'clients have'} blown the SLA for their current stage with no touch since.`,
    count: slaExpired,
    href: '/reports/overdue',
    category: 'sla',
  }
}

/** Hot leads with no fresh qualifier approval waiting in the queue. */
export function qualifierItem(input: { awaiting: number }): AttentionItem | null {
  const { awaiting } = input
  if (awaiting <= 0) return null
  return {
    key: 'qualifier-review',
    severity: 'info',
    title: 'Hot leads awaiting qualifier review',
    detail: `${awaiting} hot ${awaiting === 1 ? 'lead is' : 'leads are'} in the queue without a fresh qualifier approval.`,
    count: awaiting,
    href: '/sales/qualifier',
    category: 'qualifier',
  }
}

/** Overall data-hygiene score under the healthy line. */
export function hygieneItem(input: { score: number; threshold?: number }): AttentionItem | null {
  const threshold = input.threshold ?? HYGIENE_HEALTHY_SCORE
  if (input.score >= threshold) return null
  return {
    key: 'data-hygiene',
    severity: 'warning',
    title: 'Data hygiene needs a cleanup',
    detail: `The book's hygiene score is ${input.score}/100, below the ${threshold} healthy line.`,
    href: '/sales/hygiene',
    category: 'hygiene',
  }
}

/** A closer holding live pipeline but who logged no calls in the range. */
export function coldCloserItem(input: {
  coldCount: number
  sampleName: string | null
  rangeDays: number
}): AttentionItem | null {
  const { coldCount, sampleName, rangeDays } = input
  if (coldCount <= 0) return null
  const who = coldCount === 1 ? `${sampleName ?? 'A closer'} has` : `${coldCount} closers have`
  return {
    key: 'cold-closer',
    severity: 'info',
    title: coldCount === 1 ? 'A closer has gone quiet' : 'Closers have gone quiet',
    detail: `${who} live pipeline but logged no calls in the last ${rangeDays} days.`,
    count: coldCount,
    href: '/performance',
    category: 'coverage',
  }
}

// ── Sorting ──────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 }

/** Critical → warning → info, then the biggest pile first inside each band. */
export function sortAttentionItems(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.count ?? 0) - (a.count ?? 0),
  )
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * The attention feed for the caller, scoped exactly as every other sales view:
 * a manager sees their team, an admin the org — the underlying reports carry
 * clientScope, this only reads them. Every report is guarded so one empty or
 * failing source never takes the whole feed down.
 */
export async function getAttentionItems(user: SessionUser): Promise<AttentionItem[]> {
  const config = await getCloseOpsConfig(user.organizationId)
  const def = phaseDef(config.phase)
  const coldFrom = new Date(Date.now() - COLD_CLOSER_RANGE_DAYS * 86_400_000)

  const [metrics, overdue, hygiene, coverage, scoreboard] = await Promise.all([
    getCloseOpsMetrics(user, config).catch(() => null),
    getOverdueSummary(user).catch(() => null),
    getHygieneReport(user).catch(() => null),
    getQualifierCoverage(user, config).catch(() => null),
    getScoreboard(user, config, coldFrom).catch(() => []),
  ])

  const candidates: (AttentionItem | null)[] = []

  if (metrics) {
    candidates.push(
      leakageItem({
        leakagePct: metrics.leadLeakagePct,
        leakingCount: metrics.leakingCount,
        liveCount: metrics.liveCount,
        leakageDays: config.leakageDays,
        targetPct: def.targets.leadLeakageMaxPct,
      }),
      closeRateItem({
        closeRatePct: metrics.closeRatePct,
        decided: metrics.qualifiedWon + metrics.qualifiedLost,
        targetPct: def.targets.closeRatePct,
      }),
      briefAdoptionItem({
        adoptionPct: metrics.briefAdoptionPct,
        callsTotal: metrics.callsTotal,
      }),
    )
  }

  if (overdue) {
    candidates.push(
      overdueItem({ overdueTasks: overdue.overdueTasks }),
      slaItem({ slaExpired: overdue.slaExpired }),
    )
  }

  // The Lead Qualifier is a Phase 2+ workflow; in Phase 1 an unreviewed hot lead
  // is expected, not a call to action.
  if (coverage && config.phase >= 2) {
    candidates.push(qualifierItem({ awaiting: coverage.needsReview + coverage.stale }))
  }

  if (hygiene) {
    candidates.push(hygieneItem({ score: hygiene.score }))
  }

  const cold = scoreboard.filter((r) => r.pipeline > 0 && r.calls === 0)
  candidates.push(
    coldCloserItem({
      coldCount: cold.length,
      sampleName: cold[0]?.name ?? null,
      rangeDays: COLD_CLOSER_RANGE_DAYS,
    }),
  )

  return sortAttentionItems(candidates.filter((i): i is AttentionItem => i !== null))
}
