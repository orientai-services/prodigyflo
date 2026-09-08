'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { ForbiddenError, requireUser } from '@/lib/rbac'
import { recordHotLeadReview, type RecordReviewResult } from '@/lib/qualifier'

const reviewSchema = z.object({
  clientId: z.string().min(1),
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().max(2000).optional(),
})

export async function reviewHotLeadAction(raw: unknown): Promise<RecordReviewResult> {
  const parsed = reviewSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const user = await requireUser()
  try {
    const result = await recordHotLeadReview(user, parsed.data)
    if (result.ok) {
      revalidatePath('/sales/qualifier')
      revalidatePath('/sales/hot-leads')
      revalidatePath('/sales')
    }
    return result
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}
