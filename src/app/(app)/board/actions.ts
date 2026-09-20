'use server'

import { revalidatePath } from 'next/cache'
import { AppointmentStatus, AppointmentType, StageKey } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { applyAssignment } from '@/lib/assignment'
import { DESK_TIMEZONE, civilDate, timeLabel, zonedDate } from '@/lib/daily-desk'
import { ForbiddenError, clientScope, findClientInScope, requirePermission, requireUser } from '@/lib/rbac'
import { StageTransitionError, checkTransition, moveClientToStage } from '@/lib/stage-transitions'

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
    revalidatePath('/pipeline')
    revalidatePath('/clients')
    return { ok: true }
  } catch (error) {
    if (error instanceof StageTransitionError) return { error: error.message, blockers: error.blockers }
    if (error instanceof ForbiddenError) return { error: error.message }
    throw error
  }
}

export type DeskActionResult = { ok?: boolean; error?: string }

const assignSchema = z.object({
  clientId: z.string().min(1),
  closerId: z.string().min(1),
  note: z.string().max(500).optional(),
})

/** Calendar assign. Same write path as the client-profile closer action. */
export async function assignDeskCloserAction(
  input: z.infer<typeof assignSchema>,
): Promise<DeskActionResult> {
  const parsed = assignSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.' }

  try {
    const user = await requireUser()
    const result = await applyAssignment(user, {
      clientId: parsed.data.clientId,
      assigneeId: parsed.data.closerId,
    })
    if (!result.ok) return { error: result.error }

    const note = parsed.data.note?.trim()
    if (note) {
      await db.note.create({
        data: {
          clientId: parsed.data.clientId,
          authorId: user.id,
          body: note,
          isInternal: true,
        },
      })
    }

    revalidateDesk()
    return { ok: true }
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message }
    throw error
  }
}

const bookSchema = z.object({
  clientId: z.string().min(1),
  appointmentId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().min(1).optional(),
})

/**
 * Book or reschedule on the existing Appointment model.
 * Default time is 10:00 in the client timezone (fallback America/Los_Angeles).
 * Stage only advances when the pipeline already allows APPOINTMENT_SCHEDULED.
 */
export async function bookAppointmentAction(
  input: z.infer<typeof bookSchema>,
): Promise<DeskActionResult> {
  const parsed = bookSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.' }

  try {
    const user = await requirePermission('appointments:manage')
    const client = await findClientInScope(user, parsed.data.clientId)
    if (!client) return { error: 'Client not found or outside your scope.' }

    const organization = await db.organization.findUnique({ where: { id: user.organizationId }, select: { timezone: true } })
    const tz = organization?.timezone || DESK_TIMEZONE
    let startsAt: Date
    try { startsAt = zonedDate(parsed.data.date, parsed.data.time, tz) } catch { return { error: 'Invalid appointment time.' } }
    if (!Number.isFinite(startsAt.getTime()) || civilDate(startsAt, tz) !== parsed.data.date || timeLabel(startsAt, tz) !== parsed.data.time) return { error: 'That local time does not exist. Choose another time.' }
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000)
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${client.id} FOR UPDATE`
      const current = await tx.client.findFirst({ where: { AND: [clientScope(user), { id: client.id }] } })
      if (!current) throw new ForbiddenError('This client is no longer assigned to you.')
      if (parsed.data.appointmentId) {
        const updated = await tx.appointment.updateMany({
          where: { id: parsed.data.appointmentId, clientId: current.id, status: { in: ['SCHEDULED', 'CONFIRMED'] } },
          data: { startsAt, endsAt, timezone: tz, ownerId: current.ownerId },
        })
        if (updated.count !== 1) throw new ForbiddenError('This appointment is no longer available to reschedule.')
      } else {
        await tx.appointment.create({ data: { clientId: current.id, ownerId: current.ownerId, type: AppointmentType.PRESENTATION, status: AppointmentStatus.SCHEDULED, startsAt, endsAt, timezone: tz } })
      }
    })

    await maybeAdvanceToScheduled(user, client.id)

    revalidateDesk()
    return { ok: true }
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message }
    throw error
  }
}

const noShowSchema = z.object({ clientId: z.string().min(1), appointmentId: z.string().min(1) })

/** Marks the next live appointment NO_SHOW. Does not invent a new stage. */
export async function markNoShowAction(
  input: z.infer<typeof noShowSchema>,
): Promise<DeskActionResult> {
  const parsed = noShowSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.' }

  try {
    const user = await requirePermission('appointments:manage')
    const client = await findClientInScope(user, parsed.data.clientId)
    if (!client) return { error: 'Client not found or outside your scope.' }

    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${client.id} FOR UPDATE`
      const current = await tx.client.findFirst({ where: { AND: [clientScope(user), { id: client.id }] } })
      if (!current) throw new ForbiddenError('This client is no longer assigned to you.')
      const updated = await tx.appointment.updateMany({
        where: { id: parsed.data.appointmentId, clientId: client.id, status: { in: ['SCHEDULED', 'CONFIRMED'] } },
        data: { status: AppointmentStatus.NO_SHOW, noShowRecordedAt: new Date(), outcome: 'No show' },
      })
      if (updated.count !== 1) throw new ForbiddenError('No live appointment to mark.')
    })

    revalidateDesk()
    return { ok: true }
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message }
    throw error
  }
}

function revalidateDesk() {
  revalidatePath('/board')
  revalidatePath('/pipeline')
  revalidatePath('/clients')
}

async function maybeAdvanceToScheduled(
  user: Awaited<ReturnType<typeof requirePermission>>,
  clientId: string,
) {
  if (!user.permissions.has('clients:advance_stage')) return
  const client = await db.client.findFirst({
    where: { id: clientId },
    include: { currentStage: true },
  })
  if (!client) return
  if (client.currentStage.key === 'APPOINTMENT_SCHEDULED') return

  const to = await db.pipelineStage.findFirst({
    where: { pipelineId: client.pipelineId, key: 'APPOINTMENT_SCHEDULED' },
  })
  if (!to) return
  const check = await checkTransition(client, client.currentStage, to)
  if (!check.allowed) return
  await moveClientToStage({ user, clientId, toStageKey: 'APPOINTMENT_SCHEDULED' })
}
