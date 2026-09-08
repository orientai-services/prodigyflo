'use server'

import { revalidatePath } from 'next/cache'
import type { StageKey } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { ForbiddenError, requireUser } from '@/lib/rbac'
import { getRecoverableLead } from '@/lib/recovery'
import { moveClientToStage, StageTransitionError } from '@/lib/stage-transitions'

/**
 * Re-engage a stalled lead — the one mutation the recovery product performs.
 *
 * A server action is a public POST, so it re-checks the session AND that the
 * client is inside the caller's clientScope (getRecoverableLead is scoped and
 * returns null otherwise) before touching anything. It prefers a real stage
 * move into a live follow-up; if that transition is awkward (blocked, the stage
 * is absent, or the caller can't advance stages) it falls back to re-activating
 * the lead in place. Either way the lead leaves the recyclable pool. Safe to
 * run more than once — an already-live lead is a no-op that still reports ok.
 */

type Result = { ok: true } | { ok: false; error: string }

const LIVE_TARGETS: StageKey[] = ['FOLLOW_UP', 'APPOINTMENT_SCHEDULING']

export async function recoverLeadAction(input: { clientId: string }): Promise<Result> {
  const user = await requireUser()

  const clientId = input.clientId?.trim()
  if (!clientId) return { ok: false, error: 'Missing lead reference.' }

  const lead = await getRecoverableLead(user, clientId)
  if (!lead) return { ok: false, error: 'That lead is not available to recover.' }

  // Preferred path — move into a live follow-up stage if the pipeline allows it.
  for (const target of LIVE_TARGETS) {
    try {
      await moveClientToStage({
        user,
        clientId,
        toStageKey: target,
        reason: 'Recovery restarted',
      })
      await recordAudit(user, {
        action: 'lead.recovery_started',
        entityType: 'Client',
        entityId: clientId,
        summary: `Recovery started — moved to ${target}`,
      })
      revalidatePath('/recovery')
      revalidatePath('/recovery/leads')
      return { ok: true }
    } catch (e) {
      // A blocked/missing transition or a missing advance permission is expected
      // here — fall through to the in-place re-activation. Anything else is real.
      if (e instanceof StageTransitionError || e instanceof ForbiddenError) continue
      throw e
    }
  }

  // Fallback — re-activate in place and refresh activity so it exits the pool.
  const now = new Date()
  await db.client.update({
    where: { id: clientId },
    data: { status: 'ACTIVE', stageEnteredAt: now, lastActivityAt: now },
  })
  await recordAudit(user, {
    action: 'lead.recovery_started',
    entityType: 'Client',
    entityId: clientId,
    summary: 'Recovery started — re-engaged in place',
  })
  revalidatePath('/recovery')
  revalidatePath('/recovery/leads')
  return { ok: true }
}
