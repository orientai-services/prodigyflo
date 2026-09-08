'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { ForbiddenError, requirePermission } from '@/lib/rbac'
import { updateCloseOpsConfig } from '@/lib/closeops'

export type OpsConfigState = { error?: string; ok?: boolean }

const patchSchema = z.object({
  phase: z.coerce.number().int().min(1).max(3).optional(),
  hotLeadThreshold: z.coerce.number().int().min(50).max(100).optional(),
  leakageDays: z.coerce.number().int().min(1).max(30).optional(),
})

function revalidateSales() {
  revalidatePath('/sales')
  revalidatePath('/sales/hot-leads')
  revalidatePath('/sales/ops')
}

/**
 * Applies a close-rate-ops config patch. `updateCloseOpsConfig` re-checks
 * `org:manage`, clamps every value, and writes the audit event.
 */
export async function updateCloseOpsAction(
  _prev: OpsConfigState,
  formData: FormData,
): Promise<OpsConfigState> {
  const raw: Record<string, unknown> = {}
  for (const key of ['phase', 'hotLeadThreshold', 'leakageDays'] as const) {
    const value = formData.get(key)
    if (value !== null && value !== '') raw[key] = value
  }
  const parsed = patchSchema.safeParse(raw)
  if (!parsed.success) return { error: 'Enter values inside the allowed ranges.' }
  if (Object.keys(parsed.data).length === 0) return { error: 'Nothing to change.' }

  try {
    const user = await requirePermission('org:manage')
    await updateCloseOpsConfig(user, parsed.data as Parameters<typeof updateCloseOpsConfig>[1])
    revalidateSales()
    return { ok: true }
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message }
    throw error
  }
}
