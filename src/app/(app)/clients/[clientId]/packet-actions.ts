'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { ForbiddenError, requireUser } from '@/lib/rbac'
import { recordCloserYes } from '@/lib/packet/data'

const schema = z.object({ clientId: z.string().min(1) })

export async function closerYesAction(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }
  const user = await requireUser()
  try {
    const result = await recordCloserYes(parsed.data.clientId, { id: user.id, name: user.name ?? user.email })
    if (result.ok) revalidatePath(`/clients/${parsed.data.clientId}`)
    return result
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}
