'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { ForbiddenError, requirePermission } from '@/lib/rbac'
import { startInsightScan } from './insights'

/**
 * Server actions for the insight engine. Server actions are public POST
 * endpoints, so every one re-gates permissions on its first line and pins
 * every query to the caller's organization. Reviews claim the row atomically
 * (updateMany on PENDING_REVIEW), so two concurrent clicks record exactly one
 * verdict — and that verdict feeds the next run's retrieval.
 */

export type InsightReviewResult = { ok: true } | { ok: false; error: string }

const reviewSchema = z.object({
  insightId: z.string().min(1),
  note: z.string().max(2000).optional(),
})

async function reviewInsight(
  decision: 'accept' | 'dismiss',
  raw: unknown,
): Promise<InsightReviewResult> {
  let user
  try {
    user = await requirePermission('ai:review')
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }

  const parsed = reviewSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }
  const note = parsed.data.note?.trim() || null

  const insight = await db.insight.findFirst({
    where: { id: parsed.data.insightId, organizationId: user.organizationId },
    select: { id: true, kind: true, title: true, status: true },
  })
  if (!insight) return { ok: false, error: 'Insight not found.' }

  // Atomic claim: only the request that flips PENDING_REVIEW records the verdict.
  const claimed = await db.insight.updateMany({
    where: { id: insight.id, organizationId: user.organizationId, status: 'PENDING_REVIEW' },
    data: {
      status: decision === 'accept' ? 'ACCEPTED' : 'DISMISSED',
      reviewedById: user.id,
      reviewedAt: new Date(),
      reviewNote: note,
    },
  })
  if (claimed.count === 0) return { ok: false, error: 'This insight was already reviewed.' }

  await recordAudit(user, {
    action: decision === 'accept' ? 'insight.accepted' : 'insight.dismissed',
    entityType: 'Insight',
    entityId: insight.id,
    summary: `${decision === 'accept' ? 'Accepted' : 'Dismissed'} insight "${insight.title}" (${insight.kind})${note ? ' with a review note' : ''}`,
    after: { decision, hasNote: note !== null },
  })

  revalidatePath('/engine')
  revalidatePath('/dashboard')
  return { ok: true }
}

/** Accepts an insight (optional review note). The note and later measured
 *  outcome condition every future scan's generation. */
export async function acceptInsightAction(raw: unknown): Promise<InsightReviewResult> {
  return reviewInsight('accept', raw)
}

/** Dismisses an insight (optional review note). Dismissed (kind, title) pairs
 *  are never proposed again. */
export async function dismissInsightAction(raw: unknown): Promise<InsightReviewResult> {
  return reviewInsight('dismiss', raw)
}

export type RunScanActionResult = { ok: true; runId: string } | { ok: false; error: string }

/** Starts an insight scan on demand (the /engine "Run now" button). */
export async function runInsightScanAction(): Promise<RunScanActionResult> {
  let user
  try {
    user = await requirePermission('ai:run')
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }

  const result = await startInsightScan(user)
  if (!result.ok) return result

  await recordAudit(user, {
    action: 'engine.run_started',
    entityType: 'EngineRun',
    entityId: result.runId,
    summary: 'Started an insight scan manually',
  })
  revalidatePath('/engine')
  return result
}
