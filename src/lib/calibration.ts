import 'server-only'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'
import type { CloseOpsConfig } from '@/lib/closeops'

/**
 * AI calibration & trust — is the probability-to-close score actually honest?
 *
 * A model can be *discriminating* (ranks leads well) yet *miscalibrated* (its
 * 90% is really a 60%). This module answers the second question: over deals we
 * already know the outcome of, do leads the AI scored at X% actually close X%
 * of the time?
 *
 * IMPORTANT HONESTY NOTE, surfaced verbatim in the UI: there is no historical
 * score table. `Client.aiCloseProbability` is the LAST score computed, and
 * scoring stops at terminal stages — so for a closed deal it is the score
 * recorded near close, a reasonable proxy for "what the model believed", not a
 * frozen at-first-touch prediction. Everything here is a lower bound on trust:
 * a model that looks calibrated on near-close scores has, at best, earned that
 * much confidence.
 *
 * Every scoring/bucketing function is pure so the math is transparent, testable,
 * and rendered without a chart library.
 */

// ── Pure calibration math ────────────────────────────────────────────────────

/** One decided, scored deal: the score it carried and whether it actually won. */
export type CalRow = { probability: number; won: boolean }

export type CalBucket = {
  /** Human range label, e.g. "90–100". */
  label: string
  lo: number
  hi: number
  n: number
  /** Average predicted probability of deals in the bin (0-100). Null when empty. */
  predicted: number | null
  /** Actual win rate of deals in the bin (0-100). Null when empty. */
  actual: number | null
  /** actual − predicted (signed): positive = model under-sold, negative = over-sold. */
  gap: number | null
}

const round1 = (n: number) => Math.round(n * 10) / 10
const clampProb = (p: number) => (p < 0 ? 0 : p > 100 ? 100 : p)

/** Bin index 0-9 for a 0-100 probability; the top bin (90-100) is inclusive of 100. */
function binIndex(probability: number): number {
  const p = clampProb(probability)
  return p >= 100 ? 9 : Math.floor(p / 10)
}

/**
 * Ten 10-point deciles (0–9, 10–19, … 90–100). Every bin is returned even when
 * empty so the reliability chart keeps a stable x-axis.
 */
export function bucketize(rows: CalRow[]): CalBucket[] {
  const bins: CalRow[][] = Array.from({ length: 10 }, () => [])
  for (const r of rows) bins[binIndex(r.probability)].push(r)
  return bins.map((bin, i) => {
    const lo = i * 10
    const hi = i === 9 ? 100 : i * 10 + 9
    const n = bin.length
    if (n === 0) return { label: `${lo}–${hi}`, lo, hi, n: 0, predicted: null, actual: null, gap: null }
    const predicted = bin.reduce((s, r) => s + clampProb(r.probability), 0) / n
    const actual = (bin.filter((r) => r.won).length / n) * 100
    return {
      label: `${lo}–${hi}`,
      lo,
      hi,
      n,
      predicted: round1(predicted),
      actual: round1(actual),
      gap: round1(actual - predicted),
    }
  })
}

/**
 * Brier score: mean squared error between predicted probability and outcome.
 * 0 is perfect, 0.25 is a coin flip, 1 is confidently wrong. Null with no data.
 */
export function brierScore(rows: CalRow[]): number | null {
  if (rows.length === 0) return null
  const sse = rows.reduce((s, r) => {
    const p = clampProb(r.probability) / 100
    const o = r.won ? 1 : 0
    return s + (p - o) * (p - o)
  }, 0)
  return Math.round((sse / rows.length) * 10000) / 10000
}

export type CalibrationVerdict =
  | 'well-calibrated'
  | 'over-confident'
  | 'under-confident'
  | 'insufficient'

export type CalibrationSummary = {
  n: number
  /** Mean predicted probability across all deals (0-100). */
  meanPredicted: number | null
  /** Actual overall win rate across all deals (0-100). */
  meanActual: number | null
  /** meanActual − meanPredicted: how far reality sits from the model's average claim. */
  averageGap: number | null
  verdict: CalibrationVerdict
}

/** Inside this signed-point band the model reads as trustworthy on average. */
export const WELL_CALIBRATED_BAND = 5

/** Overall verdict from the signed average gap. */
export function calibrationSummary(rows: CalRow[]): CalibrationSummary {
  const n = rows.length
  if (n === 0) {
    return { n: 0, meanPredicted: null, meanActual: null, averageGap: null, verdict: 'insufficient' }
  }
  const meanPredicted = rows.reduce((s, r) => s + clampProb(r.probability), 0) / n
  const meanActual = (rows.filter((r) => r.won).length / n) * 100
  const averageGap = meanActual - meanPredicted
  const verdict: CalibrationVerdict =
    Math.abs(averageGap) <= WELL_CALIBRATED_BAND
      ? 'well-calibrated'
      : averageGap < 0
        ? 'over-confident'
        : 'under-confident'
  return {
    n,
    meanPredicted: round1(meanPredicted),
    meanActual: round1(meanActual),
    averageGap: round1(averageGap),
    verdict,
  }
}

export type ThresholdAdvice = {
  currentThreshold: number
  currentCohortN: number
  /** Actual close rate of leads scored at/above the current threshold (0-100). */
  currentActualPct: number | null
  /** True when leads above the cut actually close at least as often as the cut claims. */
  currentIsHonest: boolean | null
  /** Lowest score cut whose cohort is self-consistent (actual ≥ cut), or null if none. */
  suggestedThreshold: number | null
  suggestedCohortN: number
  suggestedActualPct: number | null
  rationale: string
}

/** Candidate hot-lead cuts to test the data against. */
const THRESHOLD_CANDIDATES = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95]
/** A cut needs at least this many decided deals above it to be judged. */
const MIN_COHORT = 5

function cohortActualPct(rows: CalRow[], threshold: number): { n: number; pct: number | null } {
  const cohort = rows.filter((r) => clampProb(r.probability) >= threshold)
  if (cohort.length === 0) return { n: 0, pct: null }
  return { n: cohort.length, pct: round1((cohort.filter((r) => r.won).length / cohort.length) * 100) }
}

/**
 * True when at least one deal is scored right at a candidate cut (within its
 * 5-point step). Keeps a suggestion anchored to real data instead of sliding
 * into an empty gap below where the scores actually cluster.
 */
function hasDataAtCut(rows: CalRow[], threshold: number): boolean {
  return rows.some((r) => {
    const p = clampProb(r.probability)
    return p >= threshold && p < threshold + 5
  })
}

/**
 * Does the current hot-lead threshold correspond to a sensible actual close
 * rate, and what cut does the data actually support?
 *
 * "Honest/self-consistent" = leads at/above the cut close at least as often as
 * the cut number claims. The suggestion is the LOWEST such cut with enough
 * sample — the widest hot queue you can trust — because raising a cut needlessly
 * throws away workable leads.
 */
export function thresholdAdvice(rows: CalRow[], currentThreshold: number): ThresholdAdvice {
  const current = cohortActualPct(rows, currentThreshold)
  const currentIsHonest =
    current.n === 0 || current.pct === null ? null : current.pct >= currentThreshold

  let suggestedThreshold: number | null = null
  let suggestedCohortN = 0
  let suggestedActualPct: number | null = null
  for (const t of THRESHOLD_CANDIDATES) {
    const c = cohortActualPct(rows, t)
    if (c.n >= MIN_COHORT && c.pct !== null && c.pct >= t && hasDataAtCut(rows, t)) {
      suggestedThreshold = t
      suggestedCohortN = c.n
      suggestedActualPct = c.pct
      break
    }
  }

  let rationale: string
  if (suggestedThreshold === null) {
    rationale =
      'No score cut in this data produces a cohort that closes at least as often as the cut implies — the model reads hot at the top. Work leads by relative rank, not the raw score.'
  } else if (suggestedThreshold === currentThreshold) {
    rationale = `Leads at ${currentThreshold}%+ actually close ${current.pct}% of the time — the current ${currentThreshold}% hot-lead cut is trustworthy.`
  } else if (suggestedThreshold < currentThreshold) {
    rationale = `The cut can safely drop to ${suggestedThreshold}%: leads there still close ${suggestedActualPct}% of the time, widening the hot queue without lowering its honesty.`
  } else {
    rationale = `Leads at ${currentThreshold}%+ only close ${current.pct ?? 0}% of the time; tighten the cut to ${suggestedThreshold}%, where they actually close ${suggestedActualPct}% — the score runs hot below that.`
  }

  return {
    currentThreshold,
    currentCohortN: current.n,
    currentActualPct: current.pct,
    currentIsHonest,
    suggestedThreshold,
    suggestedCohortN,
    suggestedActualPct,
    rationale,
  }
}

// ── Query ────────────────────────────────────────────────────────────────────

export type CloserCalibration = {
  ownerId: string
  name: string
  n: number
  /** Null until the closer clears the minimum sample. */
  brier: number | null
  gap: number | null
  verdict: CalibrationVerdict
  /** False → the UI shows "not enough data" instead of the numbers. */
  enoughData: boolean
}

/** Below this per-closer sample, one lucky win swings the numbers too far to trust. */
export const MIN_CLOSER_SAMPLE = 8

export type CalibrationResult = {
  /** Decided, scored deals in scope — the sample the whole page rests on. */
  n: number
  won: number
  lost: number
  buckets: CalBucket[]
  brier: number | null
  summary: CalibrationSummary
  threshold: ThresholdAdvice
  perCloser: CloserCalibration[]
  hotLeadThreshold: number
}

/**
 * Calibration over the caller's client scope: terminal, scored clients with a
 * decided deal. A manager sees their team, an admin the org — `clientScope`
 * decides, never this function.
 */
export async function getCalibration(
  user: SessionUser,
  config: CloseOpsConfig,
): Promise<CalibrationResult> {
  // The outcome is the terminal STAGE, not a Deal row: a client reaching
  // CLOSED_LOST is a loss whether or not a Deal was ever written (deals are
  // created on the way to a win, so requiring one would drop every loss and
  // make the curve read 100%). The stage is the authoritative outcome.
  const clients = await db.client.findMany({
    where: {
      AND: [
        clientScope(user),
        { aiCloseProbability: { not: null } },
        { currentStage: { key: { in: ['CLOSED_WON', 'CLOSED_LOST'] } } },
      ],
    },
    select: {
      aiCloseProbability: true,
      ownerId: true,
      owner: { select: { name: true } },
      currentStage: { select: { key: true } },
    },
  })

  type Row = CalRow & { ownerId: string | null; ownerName: string | null }
  const rows: Row[] = clients
    .filter((c) => typeof c.aiCloseProbability === 'number')
    .map((c) => ({
      probability: c.aiCloseProbability as number,
      won: c.currentStage.key === 'CLOSED_WON',
      ownerId: c.ownerId,
      ownerName: c.owner?.name ?? null,
    }))

  const calRows: CalRow[] = rows.map((r) => ({ probability: r.probability, won: r.won }))

  // Per-closer calibration.
  const byOwner = new Map<string, { name: string; rows: CalRow[] }>()
  for (const r of rows) {
    if (!r.ownerId) continue
    const acc = byOwner.get(r.ownerId) ?? { name: r.ownerName ?? 'Unassigned', rows: [] }
    acc.rows.push({ probability: r.probability, won: r.won })
    byOwner.set(r.ownerId, acc)
  }
  const perCloser: CloserCalibration[] = [...byOwner.entries()]
    .map(([ownerId, { name, rows: ownerRows }]) => {
      const enoughData = ownerRows.length >= MIN_CLOSER_SAMPLE
      const summary = calibrationSummary(ownerRows)
      return {
        ownerId,
        name,
        n: ownerRows.length,
        brier: enoughData ? brierScore(ownerRows) : null,
        gap: enoughData ? summary.averageGap : null,
        verdict: enoughData ? summary.verdict : 'insufficient',
        enoughData,
      }
    })
    // Best-calibrated (lowest Brier) first; closers without enough data sink to the bottom.
    .sort((a, b) => {
      if (a.enoughData !== b.enoughData) return a.enoughData ? -1 : 1
      if (a.brier !== null && b.brier !== null && a.brier !== b.brier) return a.brier - b.brier
      return a.name.localeCompare(b.name)
    })

  return {
    n: calRows.length,
    won: calRows.filter((r) => r.won).length,
    lost: calRows.filter((r) => !r.won).length,
    buckets: bucketize(calRows),
    brier: brierScore(calRows),
    summary: calibrationSummary(calRows),
    threshold: thresholdAdvice(calRows, config.hotLeadThreshold),
    perCloser,
    hotLeadThreshold: config.hotLeadThreshold,
  }
}

// ── Display helpers (pure) ───────────────────────────────────────────────────

export const VERDICT_LABEL: Record<CalibrationVerdict, string> = {
  'well-calibrated': 'Well calibrated',
  'over-confident': 'Over-confident',
  'under-confident': 'Under-confident',
  insufficient: 'Not enough data',
}

/**
 * One-line plain-English reading of a verdict + gap, for the headline card.
 * `gap` is actual − predicted in points.
 */
export function verdictNarrative(verdict: CalibrationVerdict, gap: number | null): string {
  if (verdict === 'insufficient' || gap === null) {
    return 'Not enough closed, scored deals yet to judge the model.'
  }
  if (verdict === 'well-calibrated') {
    return `The score tracks reality within ${Math.abs(gap)} points — its probabilities can be read at face value.`
  }
  if (verdict === 'over-confident') {
    return `Deals close about ${Math.abs(gap)} points LESS often than the score claims — discount the top of the range.`
  }
  return `Deals close about ${Math.abs(gap)} points MORE often than the score claims — the model is leaving confidence on the table.`
}
