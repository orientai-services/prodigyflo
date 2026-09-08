/**
 * DAG engine — definitions and pure graph logic.
 *
 * DAGs are defined in code via `defineDag()`; the database (EngineRun +
 * EngineStep) holds execution state only, never definitions. The functions in
 * this file are pure so readiness promotion, failure cascade, and cycle
 * rejection are unit-testable without a database; the claim-based executor
 * that drives them lives in `runner.ts`.
 */

export type DagStepStatus = 'PENDING' | 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED'

export type DagStepContext = {
  runId: string
  organizationId: string
  kind: string
  /** Run-level input, stored on every step row at startRun. */
  input: unknown
  /** Outputs of every COMPLETED step in this run so far, keyed by step key. */
  outputs: Record<string, unknown>
}

export type DagStepDef = {
  key: string
  dependsOn?: string[]
  /**
   * Executes the step and returns its JSON-serializable output. Model calls
   * belong here — the runner never wraps `run()` in a transaction, so a slow
   * AI response can never hold a database transaction open.
   */
  run: (ctx: DagStepContext) => Promise<unknown>
}

export type DagDef = {
  kind: string
  steps: DagStepDef[]
}

/** A step's graph-relevant execution state, as stored on its EngineStep row. */
export type DagStepState = {
  key: string
  dependsOn: string[]
  status: DagStepStatus
}

export const TERMINAL_STEP_STATUSES: ReadonlySet<DagStepStatus> = new Set([
  'COMPLETED',
  'FAILED',
  'SKIPPED',
])

export const MAX_STEP_ATTEMPTS = 3

/** 15 min, 30 min, 60 min … after the 1st, 2nd, 3rd failed attempt. */
export function stepRetryBackoffMs(attemptsSoFar: number): number {
  return 15 * 60_000 * 2 ** Math.max(0, attemptsSoFar - 1)
}

/**
 * Validates a step graph: unique keys, known dependencies, no cycles.
 * Returns a topological order (roots first); throws on any defect so a bad
 * DAG is rejected at definition time, long before a run is created.
 */
export function validateDagSteps(steps: { key: string; dependsOn?: string[] }[]): string[] {
  const keys = new Set<string>()
  for (const step of steps) {
    if (keys.has(step.key)) throw new Error(`DAG defines step "${step.key}" twice.`)
    keys.add(step.key)
  }
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!keys.has(dep)) {
        throw new Error(`Step "${step.key}" depends on unknown step "${dep}".`)
      }
      if (dep === step.key) throw new Error(`Step "${step.key}" depends on itself.`)
    }
  }

  // Kahn's algorithm: whatever cannot be ordered is part of a cycle.
  const remainingDeps = new Map(steps.map((s) => [s.key, new Set(s.dependsOn ?? [])]))
  const order: string[] = []
  while (remainingDeps.size > 0) {
    const ready = [...remainingDeps.entries()].filter(([, deps]) => deps.size === 0).map(([key]) => key)
    if (ready.length === 0) {
      throw new Error(`DAG contains a cycle involving: ${[...remainingDeps.keys()].join(', ')}.`)
    }
    for (const key of ready) {
      order.push(key)
      remainingDeps.delete(key)
      for (const deps of remainingDeps.values()) deps.delete(key)
    }
  }
  return order
}

/** Initial row statuses for a new run: roots are READY, everything else PENDING. */
export function initialStepStatuses(
  steps: { key: string; dependsOn?: string[] }[],
): Record<string, Extract<DagStepStatus, 'PENDING' | 'READY'>> {
  return Object.fromEntries(
    steps.map((s) => [s.key, (s.dependsOn ?? []).length === 0 ? 'READY' : 'PENDING']),
  ) as Record<string, 'PENDING' | 'READY'>
}

/** Keys of PENDING steps whose dependencies have all COMPLETED — promote to READY. */
export function promotableStepKeys(steps: DagStepState[]): string[] {
  const completed = new Set(steps.filter((s) => s.status === 'COMPLETED').map((s) => s.key))
  return steps
    .filter((s) => s.status === 'PENDING' && s.dependsOn.every((d) => completed.has(d)))
    .map((s) => s.key)
}

/**
 * Keys to mark SKIPPED once a step has permanently FAILED: everything that has
 * not started (PENDING or READY). A concurrently RUNNING step finishes on its
 * own; COMPLETED work is never rewritten.
 */
export function failureCascadeKeys(steps: DagStepState[]): string[] {
  return steps.filter((s) => s.status === 'PENDING' || s.status === 'READY').map((s) => s.key)
}

/** True when every step has reached a terminal status — the run can finish. */
export function isRunSettled(steps: DagStepState[]): boolean {
  return steps.every((s) => TERMINAL_STEP_STATUSES.has(s.status))
}

/** Final run status for a settled step set. */
export function runOutcome(steps: DagStepState[]): 'COMPLETED' | 'FAILED' {
  return steps.some((s) => s.status === 'FAILED' || s.status === 'SKIPPED') ? 'FAILED' : 'COMPLETED'
}

// ─── Registry ────────────────────────────────────────────────────────────────

const DAGS = new Map<string, DagDef>()

/**
 * Registers a code-defined DAG under its kind. Validation runs here, so an
 * invalid graph fails at module load — never mid-run. Re-registering the same
 * kind replaces it (dev hot reload).
 */
export function defineDag(def: DagDef): DagDef {
  validateDagSteps(def.steps)
  DAGS.set(def.kind, def)
  return def
}

export function getDag(kind: string): DagDef | undefined {
  return DAGS.get(kind)
}
