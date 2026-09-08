'use server'

import { revalidatePath } from 'next/cache'
import { StageKey } from '@prisma/client'
import { z } from 'zod'
import { ForbiddenError, findClientInScope, requirePermission } from '@/lib/rbac'
import { StageTransitionError, moveClientToStage } from '@/lib/stage-transitions'

export type MoveCardResult = {
  ok?: boolean
  error?: string
  blockers?: string[]
}

const moveSchema = z.object({
  clientId: z.string().min(1),
  toStageKey: z.string().min(1),
})

/**
 * The board's drop handler. Delegates entirely to the gated single-client
 * transition — the board never gets to skip a pipeline rule.
 */
export async function moveCardAction(input: z.infer<typeof moveSchema>): Promise<MoveCardResult> {
  const parsed = moveSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.' }
  if (!(parsed.data.toStageKey in StageKey)) return { error: 'Unknown stage.' }

  try {
    const user = await requirePermission('clients:advance_stage')
    const client = await findClientInScope(user, parsed.data.clientId)
    if (!client) return { error: 'Client not found or outside your scope.' }

    await moveClientToStage({
      user,
      clientId: client.id,
      toStageKey: parsed.data.toStageKey as StageKey,
    })

    revalidatePath('/board')
    revalidatePath('/clients')
    return { ok: true }
  } catch (error) {
    if (error instanceof StageTransitionError) return { error: error.message, blockers: error.blockers }
    if (error instanceof ForbiddenError) return { error: error.message }
    throw error
  }
}
