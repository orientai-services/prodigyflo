'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ForbiddenError, findClientInScope, requirePermission } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

function asError(err: unknown): ActionResult {
  if (err instanceof ForbiddenError) return { ok: false, error: err.message }
  throw err
}

// ─── Scheduled messages ("Send later") ───────────────────────────────────────

const scheduleSchema = z
  .object({
    clientId: z.string().min(1),
    channel: z.enum(['EMAIL', 'SMS']),
    templateId: z.string().min(1).optional(),
    subject: z.string().max(300).optional(),
    body: z.string().max(10_000).optional(),
    sendAt: z.coerce.date(),
  })
  .refine((v) => Boolean(v.templateId) || Boolean(v.body?.trim()), {
    message: 'Pick a template or write a message.',
    path: ['body'],
  })

export async function scheduleMessageAction(raw: unknown): Promise<ActionResult> {
  const parsed = scheduleSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, error: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid input.' }
  }
  const input = parsed.data

  if (input.sendAt.getTime() < Date.now() + 60_000) {
    return { ok: false, error: 'Pick a time at least a minute in the future — or just send now.' }
  }

  try {
    const user = await requirePermission('communications:send')
    const client = await findClientInScope(user, input.clientId)
    if (!client) return { ok: false, error: 'This client is not in your scope.' }

    // Free-form messages are stored raw; a template is stored by KEY so edits
    // to the template between now and send time are honoured.
    let templateKey: string | null = null
    if (input.templateId) {
      const template = await db.messageTemplate.findFirst({
        where: { id: input.templateId, organizationId: user.organizationId, isActive: true, channel: input.channel },
        select: { key: true },
      })
      if (!template) return { ok: false, error: 'Template not found, inactive, or wrong channel.' }
      templateKey = template.key
    } else if (input.channel === 'EMAIL' && !input.subject?.trim()) {
      return { ok: false, error: 'Email requires a subject line.' }
    }

    const scheduled = await db.scheduledMessage.create({
      data: {
        organizationId: user.organizationId,
        clientId: client.id,
        userId: user.id,
        channel: input.channel,
        templateKey,
        subject: templateKey ? null : (input.subject?.trim() || null),
        body: templateKey ? null : (input.body?.trim() || null),
        sendAt: input.sendAt,
      },
    })

    await recordAudit(user, {
      action: 'scheduled_message.created',
      entityType: 'ScheduledMessage',
      entityId: scheduled.id,
      summary: `Scheduled a ${input.channel.toLowerCase()} to ${client.firstName} ${client.lastName} for ${input.sendAt.toLocaleString('en-US')}`,
      after: { channel: input.channel, templateKey, sendAt: input.sendAt },
    })

    revalidatePath(`/clients/${client.id}`)
    return { ok: true, message: 'Message scheduled.' }
  } catch (err) {
    return asError(err)
  }
}

export async function cancelScheduledMessageAction(id: string): Promise<ActionResult> {
  try {
    const user = await requirePermission('communications:send')
    const scheduled = await db.scheduledMessage.findFirst({
      where: { id, organizationId: user.organizationId },
    })
    if (!scheduled) return { ok: false, error: 'Scheduled message not found.' }

    const client = await findClientInScope(user, scheduled.clientId)
    if (!client) return { ok: false, error: 'This client is not in your scope.' }
    if (scheduled.status !== 'PENDING') {
      return { ok: false, error: `This message is already ${scheduled.status.toLowerCase()} and cannot be cancelled.` }
    }

    await db.scheduledMessage.update({ where: { id }, data: { status: 'CANCELLED' } })
    await recordAudit(user, {
      action: 'scheduled_message.cancelled',
      entityType: 'ScheduledMessage',
      entityId: id,
      summary: `Cancelled the scheduled ${scheduled.channel.toLowerCase()} to ${client.firstName} ${client.lastName}`,
    })

    revalidatePath(`/clients/${scheduled.clientId}`)
    return { ok: true, message: 'Scheduled message cancelled.' }
  } catch (err) {
    return asError(err)
  }
}

// ─── Sequence enrollment ─────────────────────────────────────────────────────

export async function enrollClientAction(raw: { clientId: string; sequenceId: string }): Promise<ActionResult> {
  const parsed = z.object({ clientId: z.string().min(1), sequenceId: z.string().min(1) }).safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }
  const { clientId, sequenceId } = parsed.data

  try {
    const user = await requirePermission('communications:send')
    const client = await findClientInScope(user, clientId)
    if (!client) return { ok: false, error: 'This client is not in your scope.' }

    const sequence = await db.sequence.findFirst({
      where: { id: sequenceId, organizationId: user.organizationId, isActive: true },
      include: { steps: { orderBy: { position: 'asc' }, take: 1 } },
    })
    if (!sequence) return { ok: false, error: 'Sequence not found or inactive.' }
    const firstStep = sequence.steps[0]
    if (!firstStep) return { ok: false, error: 'This sequence has no steps yet — add steps before enrolling anyone.' }

    const existing = await db.sequenceEnrollment.findUnique({
      where: { sequenceId_clientId: { sequenceId, clientId } },
    })
    if (existing?.status === 'ACTIVE') {
      return { ok: false, error: `${client.firstName} is already enrolled in “${sequence.name}”.` }
    }

    const nextRunAt = new Date(Date.now() + firstStep.delayHours * 3_600_000)
    const enrollment = existing
      ? await db.sequenceEnrollment.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE', currentStep: 0, nextRunAt, stoppedReason: null, enrolledById: user.id },
        })
      : await db.sequenceEnrollment.create({
          data: { sequenceId, clientId, status: 'ACTIVE', currentStep: 0, nextRunAt, enrolledById: user.id },
        })

    await recordAudit(user, {
      action: existing ? 'sequence_enrollment.restarted' : 'sequence_enrollment.created',
      entityType: 'SequenceEnrollment',
      entityId: enrollment.id,
      summary: `Enrolled ${client.firstName} ${client.lastName} in “${sequence.name}”`,
      after: { sequenceId, clientId, nextRunAt },
    })

    revalidatePath(`/clients/${clientId}`)
    return {
      ok: true,
      message: `Enrolled in “${sequence.name}” — first step ${firstStep.delayHours === 0 ? 'goes out on the next run' : `in ${firstStep.delayHours}h`}.`,
    }
  } catch (err) {
    return asError(err)
  }
}

export async function stopEnrollmentAction(enrollmentId: string): Promise<ActionResult> {
  try {
    const user = await requirePermission('communications:send')
    const enrollment = await db.sequenceEnrollment.findFirst({
      where: { id: enrollmentId, sequence: { organizationId: user.organizationId } },
      include: { sequence: { select: { name: true } } },
    })
    if (!enrollment) return { ok: false, error: 'Enrollment not found.' }

    const client = await findClientInScope(user, enrollment.clientId)
    if (!client) return { ok: false, error: 'This client is not in your scope.' }
    if (enrollment.status !== 'ACTIVE') {
      return { ok: false, error: `This enrollment is already ${enrollment.status.toLowerCase()}.` }
    }

    await db.sequenceEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'STOPPED', nextRunAt: null, stoppedReason: `Stopped manually by ${user.name}.` },
    })
    await recordAudit(user, {
      action: 'sequence_enrollment.stopped',
      entityType: 'SequenceEnrollment',
      entityId: enrollmentId,
      summary: `Stopped “${enrollment.sequence.name}” for ${client.firstName} ${client.lastName}`,
    })

    revalidatePath(`/clients/${enrollment.clientId}`)
    return { ok: true, message: 'Sequence stopped for this client.' }
  } catch (err) {
    return asError(err)
  }
}
