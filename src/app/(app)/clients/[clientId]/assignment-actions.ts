'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { ForbiddenError, canAny, requireUser } from '@/lib/rbac'
import {
  ASSIGNMENT_PANEL_PERMISSIONS,
  applyAssignment,
  dismissAssignmentSuggestion,
  getAssignmentPanelData,
  getAssignmentSuggestion,
  type ApplyAssignmentResult,
  type AssignmentPanelData,
  type DismissSuggestionResult,
  type SuggestionResult,
} from '@/lib/assignment'

export type PanelLoadResult =
  | { ok: true; data: AssignmentPanelData }
  | { ok: false; error: string }

const loadSchema = z.object({ clientId: z.string().min(1) })

/** Loads everything the panel renders. Access is re-checked on every call. */
export async function loadAssignmentPanelAction(raw: unknown): Promise<PanelLoadResult> {
  const parsed = loadSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const user = await requireUser()
  // Same gate as getAssignmentPanelData: internal AI analysis (staff names,
  // scores, disqualifiers) never reaches CLIENT or DOCUMENT_COLLECTOR sessions.
  if (!canAny(user, [...ASSIGNMENT_PANEL_PERMISSIONS])) {
    return { ok: false, error: 'You do not have permission to view assignment analysis.' }
  }

  try {
    const data = await getAssignmentPanelData(user, parsed.data.clientId)
    if (!data) return { ok: false, error: 'Client not found or out of your scope.' }
    return { ok: true, data }
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}

const suggestSchema = z.object({ clientId: z.string().min(1) })

export async function suggestCloserAction(raw: unknown): Promise<SuggestionResult> {
  const parsed = suggestSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const user = await requireUser()
  try {
    const result = await getAssignmentSuggestion(user, parsed.data.clientId)
    if (result.ok) revalidatePath(`/clients/${parsed.data.clientId}`)
    return result
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}

const applySchema = z.object({
  clientId: z.string().min(1),
  assigneeId: z.string().min(1),
  recommendationId: z.string().min(1).optional(),
  overrideReason: z.string().max(500).optional(),
})

export async function applyCloserAction(raw: unknown): Promise<ApplyAssignmentResult> {
  const parsed = applySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const user = await requireUser()
  try {
    const result = await applyAssignment(user, parsed.data)
    if (result.ok) revalidatePath(`/clients/${parsed.data.clientId}`)
    return result
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}

const dismissSchema = z.object({
  clientId: z.string().min(1),
  recommendationId: z.string().min(1),
})

export async function dismissSuggestionAction(raw: unknown): Promise<DismissSuggestionResult> {
  const parsed = dismissSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const user = await requireUser()
  try {
    const result = await dismissAssignmentSuggestion(user, parsed.data)
    if (result.ok) revalidatePath(`/clients/${parsed.data.clientId}`)
    return result
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}
