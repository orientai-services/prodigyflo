'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { ForbiddenError, requireUser } from '@/lib/rbac'
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
