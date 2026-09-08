import 'server-only'
import type { Client, PipelineStage, StageKey } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { ForbiddenError, type SessionUser } from '@/lib/rbac'
import { enrollOnStageChange } from '@/lib/automation/triggers'

export class StageTransitionError extends Error {
  constructor(
    message: string,
    readonly blockers: string[] = [],
  ) {
    super(message)
    this.name = 'StageTransitionError'
  }
}

/** Reachable from anywhere — pausing or losing a client is never gated. */
const UNIVERSAL_TARGETS: StageKey[] = ['ON_HOLD', 'CLOSED_LOST']

export type TransitionCheck = {
  allowed: boolean
  blockers: string[]
  /** Non-blocking notes: incomplete checklist items the mover should see. */
  warnings: string[]
}

/**
 * Validates a move against the stage's configured gates.
 *
 * Gates live on the PipelineStage row, so an admin editing required fields or
 * allowed transitions changes behaviour here without a code change.
 */
export async function checkTransition(
  client: Client,
  from: PipelineStage,
  to: PipelineStage,
): Promise<TransitionCheck> {
  const blockers: string[] = []
  const warnings: string[] = []

  const allowedTargets = [...from.allowedNextKeys, ...UNIVERSAL_TARGETS]
  if (from.key !== to.key && !allowedTargets.includes(to.key)) {
    blockers.push(`“${from.name}” cannot move directly to “${to.name}”.`)
  }

  // Required fields are named on the *destination* stage.
  const record = client as unknown as Record<string, unknown>
  for (const field of to.requiredFields) {
    const value = record[field]
    if (value === null || value === undefined || value === '') {
      blockers.push(`“${to.name}” requires ${humanField(field)}.`)
    }
  }

  // Consent must exist before any credit stage. This is a compliance gate, not
  // a convenience check, so it is enforced regardless of stage configuration.
  if (to.key === 'CREDIT_PULL_PENDING' || to.key === 'CREDIT_PULL_COMPLETED') {
    const consent = await db.consent.findFirst({
      where: { clientId: client.id, type: 'SOFT_CREDIT_PULL', granted: true, revokedAt: null },
    })
    if (!consent) {
      blockers.push('A recorded soft-credit-pull consent is required before any credit stage.')
    }
  }

  // A submission cannot be prepared until every required document is approved.
  if (to.key === 'DEAL_READY_FOR_SUBMISSION' || to.key === 'SUBMITTED') {
    const outstanding = await db.clientDocument.count({
      where: {
        clientId: client.id,
        status: { not: 'APPROVED' },
        requirement: { isRequired: true },
      },
    })
    if (outstanding > 0) {
      blockers.push(`${outstanding} required document${outstanding === 1 ? '' : 's'} still outstanding.`)
    }
  }

  const checklist = (to.checklist ?? []) as { key: string; label: string }[]
  if (Array.isArray(checklist) && checklist.length > 0) {
    warnings.push(`${checklist.length} checklist item${checklist.length === 1 ? '' : 's'} to confirm in “${to.name}”.`)
  }

  return { allowed: blockers.length === 0, blockers, warnings }
}

function humanField(field: string): string {
  const map: Record<string, string> = {
    lostReason: 'a loss reason',
    holdReason: 'a hold reason',
    disqualifiedReason: 'a disqualification reason',
    firstName: 'a first name',
    lastName: 'a last name',
    phone: 'a phone number',
    email: 'an email address',
  }
  return map[field] ?? `“${field}”`
}

const TERMINAL_STATUS: Partial<Record<StageKey, Client['status']>> = {
  CLOSED_WON: 'CLOSED_WON',
  CLOSED_LOST: 'CLOSED_LOST',
  NOT_QUALIFIED: 'DISQUALIFIED',
  ON_HOLD: 'ON_HOLD',
}

/**
 * Moves a client to a new stage, closing the previous StageHistory row and
 * opening the next one. Everything happens in one transaction so a client can
 * never end up in a stage without a matching history entry.
 */
export async function moveClientToStage({
  user,
  clientId,
  toStageKey,
  reason,
  note,
  automated = false,
}: {
  user: SessionUser
  clientId: string
  toStageKey: StageKey
  reason?: string
  note?: string
  automated?: boolean
}) {
  if (!user.permissions.has('clients:advance_stage')) throw new ForbiddenError()

  const client = await db.client.findFirst({
    where: { id: clientId, organizationId: user.organizationId, deletedAt: null },
    include: { currentStage: true },
  })
  if (!client) throw new StageTransitionError('Client not found.')

  const to = await db.pipelineStage.findFirst({
    where: { pipelineId: client.pipelineId, key: toStageKey },
  })
  if (!to) throw new StageTransitionError('That stage does not exist in this pipeline.')
  if (to.id === client.currentStageId) return client

  const check = await checkTransition(client, client.currentStage, to)
  if (!check.allowed) {
    throw new StageTransitionError('This move is blocked.', check.blockers)
  }

  const now = new Date()
  const enteredAt = client.stageEnteredAt

  const updated = await db.$transaction(async (tx) => {
    await tx.stageHistory.updateMany({
      where: { clientId: client.id, toKey: client.currentStage.key, exitedAt: null },
      data: {
        exitedAt: now,
        durationMinutes: Math.max(0, Math.round((now.getTime() - enteredAt.getTime()) / 60000)),
      },
    })

    await tx.stageHistory.create({
      data: {
        clientId: client.id,
        stageId: to.id,
        fromKey: client.currentStage.key,
        toKey: to.key,
        enteredAt: now,
        changedById: user.id,
        automated,
        reason: reason ?? null,
        note: note ?? null,
      },
    })

    return tx.client.update({
      where: { id: client.id },
      data: {
        currentStageId: to.id,
        stageEnteredAt: now,
        lastActivityAt: now,
        ...(TERMINAL_STATUS[to.key] ? { status: TERMINAL_STATUS[to.key] } : { status: 'ACTIVE' }),
      },
    })
  })

  await recordAudit(user, {
    action: 'client.stage_changed',
    entityType: 'Client',
    entityId: client.id,
    summary: `${client.currentStage.name} → ${to.name}`,
    before: { stage: client.currentStage.key },
    after: { stage: to.key, reason: reason ?? null, automated },
  })

  await enrollOnStageChange(client.id, to.key)

  return updated
}
