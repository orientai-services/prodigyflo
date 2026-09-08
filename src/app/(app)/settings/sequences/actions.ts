'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { StageKey } from '@prisma/client'
import { db } from '@/lib/db'
import { ForbiddenError, requirePermission } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'

export type SequenceActionResult = { ok: true; id?: string; message?: string } | { ok: false; error: string }

const stepSchema = z.object({
  delayHours: z.number().int().min(0).max(24 * 90),
  channel: z.enum(['EMAIL', 'SMS']),
  templateKey: z.string().min(1).max(120),
  stopIfReplied: z.boolean(),
})

const sequenceSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1, 'Give the sequence a name.').max(120),
  description: z.string().max(500).optional(),
  isActive: z.boolean(),
  triggerStageKey: z.string().max(60).nullable().optional(),
  steps: z.array(stepSchema).min(1, 'A sequence needs at least one step.').max(20),
})

export async function saveSequenceAction(raw: unknown): Promise<SequenceActionResult> {
  const parsed = sequenceSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, error: first ? first.message : 'Invalid input.' }
  }
  const input = parsed.data

  try {
    const user = await requirePermission('connectors:manage')

    // The trigger stage must exist in one of this organization's pipelines —
    // this also validates the enum value without trusting the client string.
    let triggerStageKey: StageKey | null = null
    if (input.triggerStageKey) {
      const stage = await db.pipelineStage.findFirst({
        where: { pipeline: { organizationId: user.organizationId }, key: input.triggerStageKey as StageKey },
        select: { key: true },
      })
      if (!stage) return { ok: false, error: 'The selected trigger stage does not exist in your pipeline.' }
      triggerStageKey = stage.key
    }

    // Every step must point at an active template of the right channel.
    for (const [i, step] of input.steps.entries()) {
      const template = await db.messageTemplate.findFirst({
        where: {
          organizationId: user.organizationId,
          key: step.templateKey,
          channel: step.channel,
          isActive: true,
        },
        select: { id: true },
      })
      if (!template) {
        return {
          ok: false,
          error: `Step ${i + 1}: no active ${step.channel === 'EMAIL' ? 'email' : 'SMS'} template with key "${step.templateKey}".`,
        }
      }
    }

    if (input.id) {
      const existing = await db.sequence.findFirst({
        where: { id: input.id, organizationId: user.organizationId },
        select: { id: true, name: true },
      })
      if (!existing) return { ok: false, error: 'Sequence not found.' }

      await db.$transaction(async (tx) => {
        await tx.sequence.update({
          where: { id: existing.id },
          data: {
            name: input.name.trim(),
            description: input.description?.trim() || null,
            isActive: input.isActive,
            triggerStageKey,
          },
        })
        await tx.sequenceStep.deleteMany({ where: { sequenceId: existing.id } })
        await tx.sequenceStep.createMany({
          data: input.steps.map((s, position) => ({ sequenceId: existing.id, position, ...s })),
        })
      })

      await recordAudit(user, {
        action: 'sequence.updated',
        entityType: 'Sequence',
        entityId: existing.id,
        summary: `Updated sequence “${input.name.trim()}” (${input.steps.length} step${input.steps.length === 1 ? '' : 's'})`,
        after: { name: input.name.trim(), isActive: input.isActive, triggerStageKey, steps: input.steps },
      })

      revalidatePath('/settings/sequences')
      return { ok: true, id: existing.id, message: 'Sequence saved.' }
    }

    const created = await db.sequence.create({
      data: {
        organizationId: user.organizationId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        isActive: input.isActive,
        triggerStageKey,
        createdById: user.id,
        steps: { create: input.steps.map((s, position) => ({ position, ...s })) },
      },
    })

    await recordAudit(user, {
      action: 'sequence.created',
      entityType: 'Sequence',
      entityId: created.id,
      summary: `Created sequence “${created.name}” (${input.steps.length} step${input.steps.length === 1 ? '' : 's'})`,
      after: { name: created.name, isActive: input.isActive, triggerStageKey, steps: input.steps },
    })

    revalidatePath('/settings/sequences')
    return { ok: true, id: created.id, message: 'Sequence created.' }
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}

export async function deleteSequenceAction(id: string): Promise<SequenceActionResult> {
  try {
    const user = await requirePermission('connectors:manage')
    const sequence = await db.sequence.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } } },
    })
    if (!sequence) return { ok: false, error: 'Sequence not found.' }

    await db.sequence.delete({ where: { id } })
    await recordAudit(user, {
      action: 'sequence.deleted',
      entityType: 'Sequence',
      entityId: id,
      summary: `Deleted sequence “${sequence.name}”${sequence._count.enrollments > 0 ? ` (${sequence._count.enrollments} active enrollment${sequence._count.enrollments === 1 ? '' : 's'} removed)` : ''}`,
      before: { name: sequence.name },
    })

    revalidatePath('/settings/sequences')
    return { ok: true, message: 'Sequence deleted.' }
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}
