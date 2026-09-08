'use server'

import { revalidatePath } from 'next/cache'
import { StageKey } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { ForbiddenError, canAny, requirePermission, requireUser } from '@/lib/rbac'
import {
  addNoteToClients,
  bulkMoveClients,
  canDeleteSavedFilter,
  reassignClients,
  type BulkRowResult,
} from '@/lib/reporting'

export type BulkActionResult = {
  ok?: boolean
  error?: string
  results?: BulkRowResult[]
  moved?: number
  failed?: number
}

function fail(error: unknown): BulkActionResult {
  if (error instanceof ForbiddenError) return { error: error.message }
  throw error
}

function summarise(results: BulkRowResult[]): Pick<BulkActionResult, 'moved' | 'failed'> {
  return {
    moved: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  }
}

const idList = z.array(z.string().min(1)).min(1, 'Select at least one client.').max(200)

// ── Bulk stage change ────────────────────────────────────────────────────────

const bulkStageSchema = z.object({
  clientIds: idList,
  toStageKey: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
})

export async function bulkStageAction(input: z.infer<typeof bulkStageSchema>): Promise<BulkActionResult> {
  const parsed = bulkStageSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.' }
  if (!(parsed.data.toStageKey in StageKey)) return { error: 'Unknown stage.' }

  try {
    const user = await requirePermission('clients:advance_stage')
    const results = await bulkMoveClients(
      user,
      parsed.data.clientIds,
      parsed.data.toStageKey as StageKey,
      parsed.data.reason || undefined,
    )
    const { moved, failed } = summarise(results)
    await recordAudit(user, {
      action: 'clients.bulk_stage_changed',
      entityType: 'Client',
      summary: `Bulk move to ${parsed.data.toStageKey}: ${moved} moved, ${failed} blocked`,
      after: { toStageKey: parsed.data.toStageKey, moved, failed },
    })
    revalidatePath('/clients')
    revalidatePath('/board')
    return { ok: true, results, moved, failed }
  } catch (error) {
    return fail(error)
  }
}

// ── Bulk / single reassignment ───────────────────────────────────────────────

const reassignSchema = z.object({
  clientIds: idList,
  /** Empty string unassigns. */
  ownerId: z.string().trim(),
})

export async function bulkReassignAction(input: z.infer<typeof reassignSchema>): Promise<BulkActionResult> {
  const parsed = reassignSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.' }

  try {
    const user = await requirePermission('clients:reassign')
    const results = await reassignClients(user, parsed.data.clientIds, parsed.data.ownerId || null)
    const { moved, failed } = summarise(results)
    if (parsed.data.clientIds.length > 1) {
      await recordAudit(user, {
        action: 'clients.bulk_reassigned',
        entityType: 'Client',
        summary: `Bulk reassignment: ${moved} updated, ${failed} skipped`,
        after: { ownerId: parsed.data.ownerId || null, moved, failed },
      })
    }
    revalidatePath('/clients')
    revalidatePath('/board')
    return { ok: true, results, moved, failed }
  } catch (error) {
    return fail(error)
  }
}

// ── Bulk tag note ────────────────────────────────────────────────────────────

const noteSchema = z.object({
  clientIds: idList,
  note: z.string().trim().min(1, 'Write a note first.').max(2000),
})

export async function bulkNoteAction(input: z.infer<typeof noteSchema>): Promise<BulkActionResult> {
  const parsed = noteSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.' }

  try {
    const user = await requirePermission('clients:update')
    const results = await addNoteToClients(user, parsed.data.clientIds, parsed.data.note)
    const { moved, failed } = summarise(results)
    await recordAudit(user, {
      action: 'clients.bulk_note_added',
      entityType: 'Client',
      summary: `Bulk note on ${moved} client${moved === 1 ? '' : 's'}`,
      after: { count: moved, failed },
    })
    revalidatePath('/clients')
    return { ok: true, results, moved, failed }
  } catch (error) {
    return fail(error)
  }
}

// ── Saved filters ────────────────────────────────────────────────────────────

/** Only real /clients filter keys are persisted — nothing else round-trips. */
const FILTER_KEYS = ['q', 'stage', 'owner', 'team', 'status', 'sort'] as const

const saveFilterSchema = z.object({
  name: z.string().trim().min(1, 'Give this view a name.').max(60),
  params: z.record(z.string(), z.string().max(200)),
  isShared: z.boolean().default(false),
})

export type SavedFilterActionResult = {
  ok?: boolean
  error?: string
  filter?: { id: string; name: string; params: Record<string, string>; isShared: boolean; mine: boolean }
}

export async function saveFilterAction(input: z.infer<typeof saveFilterSchema>): Promise<SavedFilterActionResult> {
  const parsed = saveFilterSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' }

  const user = await requireUser()
  if (!canAny(user, ['clients:read_assigned', 'clients:read_team', 'clients:read_region', 'clients:read_all'])) {
    return { error: 'You do not have permission to view clients.' }
  }

  const params = Object.fromEntries(
    Object.entries(parsed.data.params).filter(
      ([key, value]) => (FILTER_KEYS as readonly string[]).includes(key) && value,
    ),
  )
  if (Object.keys(params).length === 0) {
    return { error: 'Set at least one filter before saving the view.' }
  }

  // Saving under an existing name updates that view rather than duplicating it.
  const existing = await db.savedFilter.findFirst({
    where: { organizationId: user.organizationId, userId: user.id, route: '/clients', name: parsed.data.name },
  })

  const filter = existing
    ? await db.savedFilter.update({
        where: { id: existing.id },
        data: { params, isShared: parsed.data.isShared },
      })
    : await db.savedFilter.create({
        data: {
          organizationId: user.organizationId,
          userId: user.id,
          route: '/clients',
          name: parsed.data.name,
          params,
          isShared: parsed.data.isShared,
        },
      })

  await recordAudit(user, {
    action: existing ? 'saved_filter.updated' : 'saved_filter.created',
    entityType: 'SavedFilter',
    entityId: filter.id,
    summary: `${parsed.data.isShared ? 'Shared' : 'Personal'} view “${filter.name}” on /clients`,
    after: { params, isShared: parsed.data.isShared },
  })

  revalidatePath('/clients')
  return {
    ok: true,
    filter: { id: filter.id, name: filter.name, params, isShared: filter.isShared, mine: true },
  }
}

export async function deleteFilterAction(input: { id: string }): Promise<SavedFilterActionResult> {
  const id = z.string().min(1).safeParse(input?.id)
  if (!id.success) return { error: 'Invalid input.' }

  const user = await requireUser()
  const filter = await db.savedFilter.findFirst({
    where: { id: id.data, organizationId: user.organizationId, route: '/clients' },
  })
  if (!filter) return { error: 'That saved view no longer exists.' }
  if (!canDeleteSavedFilter(user, filter)) {
    return { error: 'Only the person who saved this view (or a user manager) can delete it.' }
  }

  await db.savedFilter.delete({ where: { id: filter.id } })
  await recordAudit(user, {
    action: 'saved_filter.deleted',
    entityType: 'SavedFilter',
    entityId: filter.id,
    summary: `Deleted view “${filter.name}” on /clients`,
  })

  revalidatePath('/clients')
  return { ok: true }
}
