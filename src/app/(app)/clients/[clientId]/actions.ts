'use server'

import { revalidatePath } from 'next/cache'
import { StageKey, type TaskPriority } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { recordAudit, redactForAudit } from '@/lib/audit'
import { normaliseEmail, normalisePhone } from '@/lib/dedupe'
import {
  ForbiddenError,
  canSeeInternal,
  clientScope,
  findClientInScope,
  requirePermission,
  userScope,
} from '@/lib/rbac'
import { StageTransitionError, moveClientToStage } from '@/lib/stage-transitions'

export type ActionResult = {
  ok?: boolean
  error?: string
  blockers?: string[]
  fieldErrors?: Record<string, string>
}

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) out[String(issue.path[0] ?? '_')] = issue.message
  return out
}

function fail(error: unknown): ActionResult {
  if (error instanceof StageTransitionError) return { error: error.message, blockers: error.blockers }
  if (error instanceof ForbiddenError) return { error: error.message }
  throw error
}

// ── Stage ────────────────────────────────────────────────────────────────────

const REASON_FIELD: Partial<Record<StageKey, 'lostReason' | 'holdReason' | 'disqualifiedReason'>> = {
  CLOSED_LOST: 'lostReason',
  ON_HOLD: 'holdReason',
  NOT_QUALIFIED: 'disqualifiedReason',
}

const advanceSchema = z.object({
  clientId: z.string().min(1),
  toStageKey: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
  note: z.string().trim().max(2000).optional(),
})

export async function advanceStageAction(input: z.infer<typeof advanceSchema>): Promise<ActionResult> {
  const parsed = advanceSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.', fieldErrors: fieldErrorsFrom(parsed.error) }

  try {
    const user = await requirePermission('clients:advance_stage')
    const client = await findClientInScope(user, parsed.data.clientId)
    if (!client) return { error: 'Client not found or out of your scope.' }

    if (!(parsed.data.toStageKey in StageKey)) return { error: 'Unknown stage.' }
    const toKey = parsed.data.toStageKey as StageKey
    const reason = parsed.data.reason || undefined

    // Terminal-ish targets require their reason on the client record itself.
    const reasonField = REASON_FIELD[toKey]
    if (reasonField) {
      if (!reason) return { error: 'A reason is required for this stage.', fieldErrors: { reason: 'Required' } }
      await db.client.update({ where: { id: client.id }, data: { [reasonField]: reason } })
    }

    await moveClientToStage({
      user,
      clientId: client.id,
      toStageKey: toKey,
      reason,
      note: parsed.data.note || undefined,
    })

    revalidatePath(`/clients/${client.id}`)
    return { ok: true }
  } catch (error) {
    return fail(error)
  }
}

// ── Overview ─────────────────────────────────────────────────────────────────

const overviewSchema = z.object({
  clientId: z.string().min(1),
  firstName: z.string().trim().min(1, 'First name is required.').max(80),
  lastName: z.string().trim().min(1, 'Last name is required.').max(80),
  email: z.string().trim().email('Enter a valid email address.'),
  phone: z.string().trim().min(7, 'Enter a valid phone number.').max(25),
  preferredLanguage: z.string().trim().max(10).default('en'),
  preferredContact: z.enum(['phone', 'email', 'sms']).default('phone'),
  estimatedValue: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? Number(v.replace(/[$,]/g, '')) : null))
    .refine((v) => v === null || (Number.isFinite(v) && v >= 0), 'Enter a valid amount.'),
  ownerId: z.string().trim().optional(),
  leadSourceId: z.string().trim().optional(),
  line1: z.string().trim().max(120).optional(),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(40).optional(),
  postalCode: z.string().trim().max(12).optional(),
})

export async function updateOverviewAction(input: unknown): Promise<ActionResult> {
  const parsed = overviewSchema.safeParse(input)
  if (!parsed.success) return { error: 'Please fix the highlighted fields.', fieldErrors: fieldErrorsFrom(parsed.error) }
  const data = parsed.data

  try {
    const user = await requirePermission('clients:update')
    const client = await findClientInScope(user, data.clientId)
    if (!client) return { error: 'Client not found or out of your scope.' }
    const primaryAddress = await db.clientAddress.findFirst({
      where: { clientId: client.id },
      orderBy: { isPrimary: 'desc' },
    })

    // The legacy overview form cannot bypass the assignment/calendar transaction.
    if (data.ownerId !== undefined && (data.ownerId || null) !== client.ownerId) {
      return { error: 'Use Assign Closer on the client profile to transfer this client and upcoming appointments together.' }
    }

    if (data.line1 && (!data.city || !data.state || !data.postalCode)) {
      return {
        error: 'Please fix the highlighted fields.',
        fieldErrors: { city: 'City, state and postal code are required with an address.' },
      }
    }

    const before = {
      firstName: client.firstName,
      lastName: client.lastName,
      email: client.email,
      phone: client.phone,
      preferredLanguage: client.preferredLanguage,
      preferredContact: client.preferredContact,
      estimatedValue: client.estimatedValue?.toString() ?? null,
      ownerId: client.ownerId,
      leadSourceId: client.leadSourceId,
    }
    const after = {
      firstName: data.firstName,
      lastName: data.lastName,
      email: normaliseEmail(data.email),
      phone: normalisePhone(data.phone),
      preferredLanguage: data.preferredLanguage,
      preferredContact: data.preferredContact,
      estimatedValue: data.estimatedValue,
      leadSourceId: data.leadSourceId || null,
    }

    await db.$transaction(async (tx) => {
      await tx.client.update({
        where: { id: client.id },
        data: { ...after, lastActivityAt: new Date() },
      })
      if (data.line1) {
        const primary = primaryAddress
        const address = {
          line1: data.line1,
          line2: data.line2 || null,
          city: data.city!,
          state: data.state!,
          postalCode: data.postalCode!,
        }
        if (primary) {
          await tx.clientAddress.update({ where: { id: primary.id }, data: address })
        } else {
          await tx.clientAddress.create({ data: { clientId: client.id, isPrimary: true, ...address } })
        }
        const source=await tx.externalDocumentImport.findFirst({where:{clientId:client.id,sourceLeadId:{not:null}},select:{sourceLeadId:true}})
        await (await import('@/lib/property-records/jobs')).queuePropertyRecords({organizationId:user.organizationId,clientId:client.id,sourceLeadId:source?.sourceLeadId??undefined,address:{line1:address.line1,city:address.city,state:address.state,postal_code:address.postalCode}},tx)
      }
      if(data.firstName!==client.firstName||data.lastName!==client.lastName||data.line1&&(data.line1!==primaryAddress?.line1||data.city!==primaryAddress?.city||data.state!==primaryAddress?.state||data.postalCode!==primaryAddress?.postalCode)) {
        await tx.documentExtraction.updateMany({where:{provider:'records',document:{clientId:client.id}},data:{sourceActive:false}})
        await tx.externalDocumentImport.updateMany({where:{clientId:client.id,analysisPending:true},data:{analysisPending:false,analysisError:'Client identity/property changed; current evidence must be reviewed again.'}})
      }
    })
    try {(await import('next/server')).after(async()=>{await (await import('@/lib/records-analyzer/continuation')).requestRecordsContinuation({clientId:client.id})})} catch { /* durable scheduler */ }

    await recordAudit(user, {
      action: 'client.updated',
      entityType: 'Client',
      entityId: client.id,
      summary: `Edited contact details for ${data.firstName} ${data.lastName}`,
      before: redactForAudit(before),
      after: redactForAudit(after),
    })

    revalidatePath(`/clients/${client.id}`)
    return { ok: true }
  } catch (error) {
    return fail(error)
  }
}

// ── Tasks ────────────────────────────────────────────────────────────────────

const createTaskSchema = z.object({
  clientId: z.string().min(1),
  title: z.string().trim().min(1, 'A task needs a title.').max(200),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  assigneeId: z.string().trim().optional(),
  dueAt: z.string().trim().optional(),
})

export async function createTaskAction(input: unknown): Promise<ActionResult> {
  const parsed = createTaskSchema.safeParse(input)
  if (!parsed.success) return { error: 'Please fix the highlighted fields.', fieldErrors: fieldErrorsFrom(parsed.error) }
  const data = parsed.data

  try {
    const user = await requirePermission('clients:update')
    const client = await findClientInScope(user, data.clientId)
    if (!client) return { error: 'Client not found or out of your scope.' }

    let dueAt: Date | null = null
    if (data.dueAt) {
      dueAt = new Date(data.dueAt)
      if (Number.isNaN(dueAt.getTime())) return { error: 'Invalid due date.', fieldErrors: { dueAt: 'Invalid date' } }
    }

    if (data.assigneeId) {
      const assignee = await db.user.findFirst({ where: { AND: [userScope(user), { id: data.assigneeId }] } })
      if (!assignee) return { error: 'That assignee is not available to you.' }
    }

    const task = await db.task.create({
      data: {
        clientId: client.id,
        createdById: user.id,
        assigneeId: data.assigneeId || user.id,
        title: data.title,
        description: data.description || null,
        priority: data.priority as TaskPriority,
        dueAt,
      },
    })
    await db.client.update({ where: { id: client.id }, data: { lastActivityAt: new Date() } })

    await recordAudit(user, {
      action: 'task.created',
      entityType: 'Task',
      entityId: task.id,
      summary: `Task "${data.title}" created for ${client.firstName} ${client.lastName}`,
      after: { title: data.title, priority: data.priority, dueAt, assigneeId: task.assigneeId },
    })

    revalidatePath(`/clients/${client.id}`)
    return { ok: true }
  } catch (error) {
    return fail(error)
  }
}

const taskRefSchema = z.object({ clientId: z.string().min(1), taskId: z.string().min(1) })

async function loadScopedTask(user: Awaited<ReturnType<typeof requirePermission>>, clientId: string, taskId: string) {
  return db.task.findFirst({
    where: { id: taskId, clientId, client: clientScope(user) },
    include: { assignee: { select: { name: true } } },
  })
}

export async function completeTaskAction(input: unknown): Promise<ActionResult> {
  const parsed = taskRefSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.' }

  try {
    const user = await requirePermission('clients:update')
    const task = await loadScopedTask(user, parsed.data.clientId, parsed.data.taskId)
    if (!task) return { error: 'Task not found or out of your scope.' }
    if (task.status === 'COMPLETED') return { ok: true }

    await db.task.update({
      where: { id: task.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    await recordAudit(user, {
      action: 'task.completed',
      entityType: 'Task',
      entityId: task.id,
      summary: `Task "${task.title}" completed`,
      before: { status: task.status },
      after: { status: 'COMPLETED' },
    })

    revalidatePath(`/clients/${parsed.data.clientId}`)
    return { ok: true }
  } catch (error) {
    return fail(error)
  }
}

export async function reopenTaskAction(input: unknown): Promise<ActionResult> {
  const parsed = taskRefSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.' }

  try {
    const user = await requirePermission('clients:update')
    const task = await loadScopedTask(user, parsed.data.clientId, parsed.data.taskId)
    if (!task) return { error: 'Task not found or out of your scope.' }

    await db.task.update({ where: { id: task.id }, data: { status: 'OPEN', completedAt: null } })
    await recordAudit(user, {
      action: 'task.reopened',
      entityType: 'Task',
      entityId: task.id,
      summary: `Task "${task.title}" reopened`,
      before: { status: task.status },
      after: { status: 'OPEN' },
    })

    revalidatePath(`/clients/${parsed.data.clientId}`)
    return { ok: true }
  } catch (error) {
    return fail(error)
  }
}

const reassignTaskSchema = taskRefSchema.extend({ assigneeId: z.string().min(1) })

export async function reassignTaskAction(input: unknown): Promise<ActionResult> {
  const parsed = reassignTaskSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.' }

  try {
    const user = await requirePermission('clients:update')
    const task = await loadScopedTask(user, parsed.data.clientId, parsed.data.taskId)
    if (!task) return { error: 'Task not found or out of your scope.' }

    const assignee = await db.user.findFirst({
      where: { AND: [userScope(user), { id: parsed.data.assigneeId }] },
      select: { id: true, name: true },
    })
    if (!assignee) return { error: 'That assignee is not available to you.' }

    await db.task.update({ where: { id: task.id }, data: { assigneeId: assignee.id } })
    await recordAudit(user, {
      action: 'task.reassigned',
      entityType: 'Task',
      entityId: task.id,
      summary: `Task "${task.title}" reassigned to ${assignee.name}`,
      before: { assignee: task.assignee?.name ?? null },
      after: { assignee: assignee.name },
    })

    revalidatePath(`/clients/${parsed.data.clientId}`)
    return { ok: true }
  } catch (error) {
    return fail(error)
  }
}

const dueDateSchema = taskRefSchema.extend({ dueAt: z.string().trim() })

export async function setTaskDueDateAction(input: unknown): Promise<ActionResult> {
  const parsed = dueDateSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.' }

  try {
    const user = await requirePermission('clients:update')
    const task = await loadScopedTask(user, parsed.data.clientId, parsed.data.taskId)
    if (!task) return { error: 'Task not found or out of your scope.' }

    const dueAt = parsed.data.dueAt ? new Date(parsed.data.dueAt) : null
    if (dueAt && Number.isNaN(dueAt.getTime())) return { error: 'Invalid date.' }

    await db.task.update({ where: { id: task.id }, data: { dueAt } })
    await recordAudit(user, {
      action: 'task.due_date_changed',
      entityType: 'Task',
      entityId: task.id,
      summary: `Follow-up date ${dueAt ? 'set' : 'cleared'} on "${task.title}"`,
      before: { dueAt: task.dueAt },
      after: { dueAt },
    })

    revalidatePath(`/clients/${parsed.data.clientId}`)
    return { ok: true }
  } catch (error) {
    return fail(error)
  }
}

// ── Notes ────────────────────────────────────────────────────────────────────

const noteSchema = z.object({
  clientId: z.string().min(1),
  body: z.string().trim().min(1, 'Write something first.').max(5000),
  isInternal: z.boolean().default(true),
})

export async function addNoteAction(input: unknown): Promise<ActionResult> {
  const parsed = noteSchema.safeParse(input)
  if (!parsed.success) return { error: 'Please fix the highlighted fields.', fieldErrors: fieldErrorsFrom(parsed.error) }

  try {
    const user = await requirePermission('clients:update')
    const client = await findClientInScope(user, parsed.data.clientId)
    if (!client) return { error: 'Client not found or out of your scope.' }

    // Someone who cannot read internal notes cannot write one either.
    const isInternal = canSeeInternal(user) ? parsed.data.isInternal : false

    const note = await db.note.create({
      data: { clientId: client.id, authorId: user.id, body: parsed.data.body, isInternal },
    })
    await db.client.update({ where: { id: client.id }, data: { lastActivityAt: new Date() } })

    await recordAudit(user, {
      action: 'note.created',
      entityType: 'Note',
      entityId: note.id,
      summary: `${isInternal ? 'Internal' : 'Client-visible'} note added for ${client.firstName} ${client.lastName}`,
      after: { isInternal, length: parsed.data.body.length },
    })

    revalidatePath(`/clients/${client.id}`)
    return { ok: true }
  } catch (error) {
    return fail(error)
  }
}
