/**
 * Pure view logic for the Prodigy Engine UI.
 *
 * Everything here converts persisted engine state (Insight `evidence` and
 * `outcome` Json, EngineStep rows) into serializable view shapes and
 * presentation decisions. No database, no Prisma types — so it unit-tests in
 * isolation and nothing Prisma-shaped ever crosses the RSC boundary.
 */

// ─── Insight evidence ────────────────────────────────────────────────────────

export type InsightCitationView = { source: string; ref: string; text: string }

/** Safely reads the persisted evidence Json into displayable citations. */
export function parseCitations(evidence: unknown): InsightCitationView[] {
  if (!Array.isArray(evidence)) return []
  const out: InsightCitationView[] = []
  for (const item of evidence) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const { source, ref, text } = item as Record<string, unknown>
    if (typeof text !== 'string' || text.trim().length === 0) continue
    out.push({
      source: typeof source === 'string' && source ? source : 'context',
      ref: typeof ref === 'string' ? ref : '',
      text,
    })
  }
  return out
}

// ─── Measured outcomes ───────────────────────────────────────────────────────

export type OutcomeDeltaView = { key: string; before: number; after: number; change: number }
export type OutcomeView = { measuredAt: string | null; deltas: OutcomeDeltaView[] }

const MAX_OUTCOME_DELTAS = 4

/**
 * Reads the measure step's persisted outcome Json
 * ({ measuredAt, delta: { kpi: { before, after, change } } }) into a view:
 * loudest KPI movements first, capped, unchanged KPIs dropped when anything
 * actually moved. Returns null when nothing measurable was stored.
 */
export function parseOutcome(outcome: unknown): OutcomeView | null {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return null
  const raw = outcome as Record<string, unknown>
  const measuredAt = typeof raw.measuredAt === 'string' ? raw.measuredAt : null

  const deltas: OutcomeDeltaView[] = []
  const delta = raw.delta
  if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
    for (const [key, value] of Object.entries(delta as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const { before, after, change } = value as Record<string, unknown>
      if (
        typeof before !== 'number' ||
        typeof after !== 'number' ||
        typeof change !== 'number' ||
        !Number.isFinite(change)
      ) {
        continue
      }
      deltas.push({ key, before, after, change })
    }
  }

  deltas.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
  const moved = deltas.filter((d) => d.change !== 0)
  return {
    measuredAt,
    deltas: (moved.length > 0 ? moved : deltas).slice(0, MAX_OUTCOME_DELTAS),
  }
}

/** "+3.2" / "-1" / "0" — explicit sign so a delta chip reads at a glance. */
export function formatChange(change: number): string {
  return change > 0 ? `+${change}` : String(change)
}

// ─── Step tracker ────────────────────────────────────────────────────────────

export type StepStatusView = 'PENDING' | 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED'
export type StepView = { key: string; status: StepStatusView; attempts: number; error: string | null }

/** Canonical insight_scan pipeline order for the horizontal tracker. */
export const INSIGHT_STEP_ORDER = ['collect', 'retrieve', 'analyze', 'persist', 'measure'] as const

/**
 * Sorts steps into canonical pipeline order; keys outside the canonical list
 * (a future DAG kind) keep their stored order after the known ones.
 */
export function orderSteps<T extends { key: string }>(steps: T[]): T[] {
  const rank = new Map<string, number>(INSIGHT_STEP_ORDER.map((k, i) => [k, i]))
  return steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => {
      const ra = rank.get(a.step.key)
      const rb = rank.get(b.step.key)
      if (ra !== undefined && rb !== undefined) return ra - rb
      if (ra !== undefined) return -1
      if (rb !== undefined) return 1
      return a.index - b.index
    })
    .map((e) => e.step)
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'muted'

/** Semantic token per step status: done=success, in flight=warning, broken=danger. */
export function stepTone(status: string): StatusTone {
  switch (status) {
    case 'COMPLETED':
      return 'success'
    case 'RUNNING':
    case 'READY':
      return 'warning'
    case 'FAILED':
      return 'danger'
    default:
      return 'muted' // PENDING, SKIPPED
  }
}

/** Semantic token for a whole run's status pill. */
export function runTone(status: string): StatusTone {
  switch (status) {
    case 'COMPLETED':
      return 'success'
    case 'FAILED':
      return 'danger'
    case 'RUNNING':
      return 'warning'
    default:
      return 'muted' // PENDING
  }
}

// ─── Misc formatting ─────────────────────────────────────────────────────────

/** "42s" / "3m 12s" / "1h 05m" between two ISO timestamps; null when unknowable. */
export function runDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (!startedAt || !finishedAt) return null
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** Clamps a stored score into the 0–100 integer the meter renders. */
export function clampScore(score: number | null): number | null {
  if (score === null || !Number.isFinite(score)) return null
  return Math.min(100, Math.max(0, Math.round(score)))
}

/**
 * Kind chip classes — tokens only. Risk and operations borrow the semantic
 * danger/warning tints (they flag exposure); the growth kinds read as brand.
 */
export function kindChipClass(kind: string): string {
  switch (kind) {
    case 'risk':
      return 'bg-danger/10 text-danger'
    case 'operations':
      return 'bg-warning/10 text-warning'
    case 'pipeline':
    case 'marketing':
      return 'bg-primary/10 text-primary'
    default:
      return 'bg-muted text-muted-foreground' // engagement, documents, unknown
  }
}
