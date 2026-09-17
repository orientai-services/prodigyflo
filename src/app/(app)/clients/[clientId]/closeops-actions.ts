'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ForbiddenError, clientScope, requireUser } from '@/lib/rbac'
import {
  generateBrief,
  markBriefViewed,
  rescoreClient,
  type GenerateBriefResult,
  type MarkBriefViewedResult,
  type RescoreResult,
} from '@/lib/ai/closeops-ai'

const rescoreSchema = z.object({ clientId: z.string().min(1) })

export async function rescoreClientAction(raw: unknown): Promise<RescoreResult> {
  const parsed = rescoreSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const user = await requireUser()
  try {
    const result = await rescoreClient(user, parsed.data.clientId)
    if (result.ok) revalidatePath(`/clients/${parsed.data.clientId}`)
    return result
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}

const generateSchema = z.object({ clientId: z.string().min(1) })

export async function generateBriefAction(raw: unknown): Promise<GenerateBriefResult> {
  const parsed = generateSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const user = await requireUser()
  try {
    const result = await generateBrief(user, parsed.data.clientId)
    if (result.ok) revalidatePath(`/clients/${parsed.data.clientId}`)
    return result
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}

const viewedSchema = z.object({ clientId: z.string().min(1), briefId: z.string().min(1) })

export async function markBriefViewedAction(raw: unknown): Promise<MarkBriefViewedResult> {
  const parsed = viewedSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const user = await requireUser()
  try {
    const result = await markBriefViewed(user, parsed.data.briefId)
    // A first view changes the adoption state shown on the page.
    if (result.ok && !result.alreadyViewed) revalidatePath(`/clients/${parsed.data.clientId}`)
    return result
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}

export type BriefStampResult = { ok: true } | { ok: false; error: string }

const briefStampSchema = z.object({
  clientId: z.string().min(1),
  briefId: z.string().min(1),
  body: z.string().max(8000).optional(),
})

/**
 * Marks the closer brief approved. Writes CloserBrief.content.approved only.
 * Does not set CysReadiness.approvedAt and does not send CYS.
 */
export async function approveBriefAction(raw: unknown): Promise<BriefStampResult> {
  const parsed = briefStampSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }
  const user = await requireUser()
  const row = await db.closerBrief.findFirst({
    where: { id: parsed.data.briefId, clientId: parsed.data.clientId, client: clientScope(user) },
  })
  if (!row) return { ok: false, error: 'Brief not found.' }
  const content =
    row.content && typeof row.content === 'object' && !Array.isArray(row.content)
      ? { ...(row.content as Record<string, unknown>) }
      : {}
  content.approved = true
  await db.closerBrief.update({
    where: { id: row.id },
    data: { content: content as Prisma.InputJsonValue },
  })
  revalidatePath(`/clients/${parsed.data.clientId}`)
  return { ok: true }
}

/** Edits the brief body (situation). Clears approved. Does not touch CYS. */
export async function editBriefAction(raw: unknown): Promise<BriefStampResult> {
  const parsed = briefStampSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }
  const body = parsed.data.body?.trim()
  if (!body) return { ok: false, error: 'Body is required.' }
  const user = await requireUser()
  const row = await db.closerBrief.findFirst({
    where: { id: parsed.data.briefId, clientId: parsed.data.clientId, client: clientScope(user) },
  })
  if (!row) return { ok: false, error: 'Brief not found.' }
  const content =
    row.content && typeof row.content === 'object' && !Array.isArray(row.content)
      ? { ...(row.content as Record<string, unknown>) }
      : {}
  content.situation = body
  content.approved = false
  await db.closerBrief.update({
    where: { id: row.id },
    data: { content: content as Prisma.InputJsonValue },
  })
  revalidatePath(`/clients/${parsed.data.clientId}`)
  return { ok: true }
}
