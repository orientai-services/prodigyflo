'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { ForbiddenError, requireUser } from '@/lib/rbac'
import {
  runAssist,
  reviewAssist,
  runDraftAssist,
  type AssistView,
  type DraftAssistResult,
} from '@/lib/ai/assists'

export type AssistActionResult =
  | { ok: true; item: AssistView }
  | { ok: false; error: string }

const runSchema = z.object({
  clientId: z.string().min(1),
  kind: z.enum(['summary', 'next_actions', 'discrepancies', 'qualification']),
})

export async function runAssistAction(raw: unknown): Promise<AssistActionResult> {
  const parsed = runSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const user = await requireUser()
  try {
    const result = await runAssist(user, parsed.data)
    if (result.ok) revalidatePath(`/clients/${parsed.data.clientId}`)
    return result
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}

export type ReviewActionResult =
  | { ok: true; effect: 'tasks_created' | 'note_pinned' | 'recorded'; count: number }
  | { ok: false; error: string }

const reviewSchema = z.object({
  clientId: z.string().min(1),
  recommendationId: z.string().min(1),
  decision: z.enum(['accept', 'dismiss']),
})

export async function reviewAssistAction(raw: unknown): Promise<ReviewActionResult> {
  const parsed = reviewSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const user = await requireUser()
  try {
    const result = await reviewAssist(user, {
      recommendationId: parsed.data.recommendationId,
      decision: parsed.data.decision,
    })
    if (result.ok) revalidatePath(`/clients/${parsed.data.clientId}`)
    return result
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}

const draftSchema = z.object({
  clientId: z.string().min(1),
  channel: z.enum(['EMAIL', 'SMS']),
  intent: z.enum(['follow_up', 'documents', 'appointment', 're_engage']).default('follow_up'),
})

export async function draftMessageAction(raw: unknown): Promise<DraftAssistResult> {
  const parsed = draftSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const user = await requireUser()
  try {
    // Drafts create a PENDING_REVIEW recommendation row but change nothing on
    // the page, so no revalidate is needed — the caller receives the draft.
    return await runDraftAssist(user, parsed.data)
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}
