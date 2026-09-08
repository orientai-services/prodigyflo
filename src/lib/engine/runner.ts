import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  MAX_STEP_ATTEMPTS,
  failureCascadeKeys,
  getDag,
  initialStepStatuses,
  isRunSettled,
  promotableStepKeys,
  runOutcome,
  stepRetryBackoffMs,
  type DagStepState,
} from './dag'

/**
 * Claim-based DAG executor, driven by the jobs tick (POST /api/jobs/run,
 * every 5 minutes). Each tick advances a bounded batch of READY steps and
 * returns — a whole DAG is never awaited inline, so the engine always fits
 * inside the tick budget no matter how deep a graph gets. Concurrency-safe by
 * construction: a step is claimed with an atomic updateMany on its READY
 * status, so two overlapping ticks can never run the same step twice.
 *
 * Step bodies (model calls included) run OUTSIDE any transaction; only the
 * bookkeeping afterwards — output write, dependent promotion, run completion —
 * happens in one short $transaction.
 */

/** READY steps advanced per tick, across all runs and orgs. */
const TICK_STEP_BUDGET = 10
/**
 * Wall-clock budget for one tick's step loop. Steps run sequentially and an
 * analyze step is a model call, so ten of them could otherwise outlast the
 * 240s jobs tick (which also runs automations, scoring and digests first).
 * Unspent steps simply stay READY for the next tick five minutes later.
 */
const TICK_TIME_BUDGET_MS = 120_000

export type EngineTickResult = {
  claimed: number
  completed: number
  retried: number
  failed: number
  runsFinished: number
}

/**
 * Creates an EngineRun with one EngineStep row per DAG step (roots READY, the
 * rest PENDING). The run-level `input` is stored on every step row so any step
 * can read it without walking the graph. Execution happens on later ticks.
 */
export async function startRun(
  organizationId: string,
  kind: string,
  input?: Record<string, unknown>,
): Promise<{ id: string }> {
  const dag = getDag(kind)
  if (!dag) throw new Error(`No DAG is registered for kind "${kind}".`)

  const statuses = initialStepStatuses(dag.steps)
  const run = await db.engineRun.create({
    data: {
      organizationId,
      kind,
      status: 'PENDING',
      steps: {
        create: dag.steps.map((s) => ({
          key: s.key,
          dependsOn: s.dependsOn ?? [],
          status: statuses[s.key],
          input: (input ?? undefined) as Prisma.InputJsonValue | undefined,
        })),
      },
    },
    select: { id: true },
  })
  return run
}

/** True when the org has a run of this kind that has not finished yet. */
export async function hasActiveRun(organizationId: string, kind: string): Promise<boolean> {
  const active = await db.engineRun.count({
    where: { organizationId, kind, status: { in: ['PENDING', 'RUNNING'] } },
  })
  return active > 0
}

export async function tickEngine(now: Date = new Date()): Promise<EngineTickResult> {
  const result: EngineTickResult = { claimed: 0, completed: 0, retried: 0, failed: 0, runsFinished: 0 }
  const deadline = Date.now() + TICK_TIME_BUDGET_MS

  const candidates = await db.engineStep.findMany({
    where: { status: 'READY', OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
    orderBy: { id: 'asc' },
    take: TICK_STEP_BUDGET,
    select: { id: true, runId: true, key: true, attempts: true, input: true },
  })

  for (const step of candidates) {
    if (Date.now() >= deadline) break // out of tick budget — the rest stays READY
    // Atomic claim: only the tick that flips READY → RUNNING executes the step.
    const claimed = await db.engineStep.updateMany({
      where: { id: step.id, status: 'READY' },
      data: { status: 'RUNNING', startedAt: now },
    })
    if (claimed.count === 0) continue
    result.claimed += 1

    // First activity marks the run RUNNING; idempotent under concurrency.
    await db.engineRun.updateMany({
      where: { id: step.runId, status: 'PENDING' },
      data: { status: 'RUNNING', startedAt: now },
    })

    const run = await db.engineRun.findUnique({
      where: { id: step.runId },
      select: { id: true, organizationId: true, kind: true },
    })
    if (!run) continue // run deleted underneath us — the step row cascaded away too

    const def = getDag(run.kind)?.steps.find((s) => s.key === step.key)
    if (!def) {
      // A stored step no code defines can never succeed — fail without retry.
      await failStep(
        run.id,
        step.id,
        step.attempts + MAX_STEP_ATTEMPTS,
        `No step "${step.key}" is defined for DAG "${run.kind}".`,
        result,
      )
      continue
    }

    const siblings = await db.engineStep.findMany({
      where: { runId: run.id, status: 'COMPLETED' },
      select: { key: true, output: true },
    })
    const outputs = Object.fromEntries(siblings.map((s) => [s.key, s.output as unknown]))

    // The step body — model calls and all — runs outside any transaction.
    let output: unknown
    try {
      output = await def.run({
        runId: run.id,
        organizationId: run.organizationId,
        kind: run.kind,
        input: step.input as unknown,
        outputs,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await failStep(run.id, step.id, step.attempts + 1, message, result, now)
      continue
    }

    // Success bookkeeping: one short transaction writes the output, promotes
    // dependents whose dependencies are now all COMPLETED, and finishes the
    // run when no step remains non-terminal.
    await db.$transaction(async (tx) => {
      await tx.engineStep.update({
        where: { id: step.id },
        data: {
          status: 'COMPLETED',
          output: (output ?? undefined) as Prisma.InputJsonValue | undefined,
          error: null,
          finishedAt: new Date(),
        },
      })
      const rows = (await tx.engineStep.findMany({
        where: { runId: run.id },
        select: { key: true, dependsOn: true, status: true },
      })) as DagStepState[]

      const promote = promotableStepKeys(rows)
      if (promote.length > 0) {
        await tx.engineStep.updateMany({
          where: { runId: run.id, key: { in: promote }, status: 'PENDING' },
          data: { status: 'READY' },
        })
      } else if (isRunSettled(rows)) {
        // Conditional claim: a run another path already finished (a parallel
        // step's permanent failure marks the run FAILED while this step was
        // still RUNNING) keeps its original outcome, stats and finishedAt.
        const finished = await tx.engineRun.updateMany({
          where: { id: run.id, status: { in: ['PENDING', 'RUNNING'] } },
          data: {
            status: runOutcome(rows),
            finishedAt: new Date(),
            stats: countByStatus(rows) as Prisma.InputJsonValue,
          },
        })
        result.runsFinished += finished.count
      }
    })
    result.completed += 1
  }

  return result
}

function countByStatus(rows: DagStepState[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1
  return counts
}

/**
 * Failure path: retry with exponential backoff up to MAX_STEP_ATTEMPTS, then
 * fail permanently — the step FAILED, every not-yet-started step SKIPPED, and
 * the run FAILED, so a broken step never leaves a run dangling forever.
 */
async function failStep(
  runId: string,
  stepId: string,
  attempts: number,
  error: string,
  result: EngineTickResult,
  now: Date = new Date(),
): Promise<void> {
  if (attempts < MAX_STEP_ATTEMPTS) {
    await db.engineStep.update({
      where: { id: stepId },
      data: {
        status: 'READY',
        attempts,
        error: error.slice(0, 1000),
        nextRunAt: new Date(now.getTime() + stepRetryBackoffMs(attempts)),
      },
    })
    result.retried += 1
    return
  }

  await db.$transaction(async (tx) => {
    await tx.engineStep.update({
      where: { id: stepId },
      data: { status: 'FAILED', attempts, error: error.slice(0, 1000), finishedAt: new Date() },
    })
    const rows = (await tx.engineStep.findMany({
      where: { runId },
      select: { key: true, dependsOn: true, status: true },
    })) as DagStepState[]

    const skip = failureCascadeKeys(rows)
    if (skip.length > 0) {
      await tx.engineStep.updateMany({
        where: { runId, key: { in: skip }, status: { in: ['PENDING', 'READY'] } },
        data: { status: 'SKIPPED' },
      })
    }
    // Conditional claim, like the success path: only the first permanent
    // failure in a run writes the run-level outcome.
    const finished = await tx.engineRun.updateMany({
      where: { id: runId, status: { in: ['PENDING', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        error: error.slice(0, 1000),
        stats: countByStatus(
          rows.map((r) => (skip.includes(r.key) ? { ...r, status: 'SKIPPED' as const } : r)),
        ) as Prisma.InputJsonValue,
      },
    })
    result.runsFinished += finished.count
  })
  result.failed += 1
}
