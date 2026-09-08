'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { ForbiddenError, requireUser } from '@/lib/rbac'
import { getCallLogContext, logCall } from '@/lib/call-log'
import { FUNNEL_STEPS } from '@/lib/adherence'

/**
 * Server actions for the Log-call dialog (log-call-dialog.tsx). Everything the
 * client sends is re-validated here; logCall() then re-checks permission and
 * client scope again before writing.
 */

export type LogCallActionResult = {
  ok?: boolean
  error?: string
  adherencePct?: number | null
}

const stepKeys = FUNNEL_STEPS.map((s) => s.key) as [string, ...string[]]

const logCallSchema = z.object({
  clientId: z.string().min(1),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  outcome: z.enum(['CONNECTED', 'VOICEMAIL', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'DECLINED', 'FAILED']),
  durationMinutes: z.coerce.number().min(0, 'Duration cannot be negative.').max(600, 'That is over 10 hours — check the duration.'),
  summary: z.string().trim().min(1, 'Write a short summary of the call.').max(4000),
  adherence: z.array(z.object({ step: z.enum(stepKeys), done: z.boolean() })).max(FUNNEL_STEPS.length),
  voicemailLeft: z.boolean(),
})

export async function logCallAction(raw: unknown): Promise<LogCallActionResult> {
  const parsed = logCallSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  }

  try {
    const user = await requireUser()
    const result = await logCall(user, {
      ...parsed.data,
      adherence: parsed.data.adherence as { step: (typeof FUNNEL_STEPS)[number]['key']; done: boolean }[],
    })
    revalidatePath(`/clients/${parsed.data.clientId}`)
    revalidatePath('/performance')
    return { ok: true, adherencePct: result.adherencePct }
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message }
    throw error
  }
}

export type CallLogContextResult = { ok: true; briefViewed: boolean } | { ok: false; error: string }

const contextSchema = z.object({ clientId: z.string().min(1) })

export async function callLogContextAction(raw: unknown): Promise<CallLogContextResult> {
  const parsed = contextSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  try {
    const user = await requireUser()
    const context = await getCallLogContext(user, parsed.data.clientId)
    return { ok: true, briefViewed: context.briefViewed }
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: error.message }
    throw error
  }
}
