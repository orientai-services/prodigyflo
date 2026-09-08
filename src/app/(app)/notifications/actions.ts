'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/rbac'

// Read-state on your own notifications is self-scoped bookkeeping — the bell's
// existing mark-all-read endpoint does not audit it, so these stay consistent.

const setReadSchema = z.object({ id: z.string().min(1), read: z.boolean() })

export async function setNotificationReadAction(input: z.infer<typeof setReadSchema>): Promise<{ ok?: boolean; error?: string }> {
  const parsed = setReadSchema.safeParse(input)
  if (!parsed.success) return { error: 'Invalid input.' }

  const user = await requireUser()
  // updateMany scoped to the caller — a foreign id silently matches nothing.
  await db.notification.updateMany({
    where: { id: parsed.data.id, userId: user.id, organizationId: user.organizationId },
    data: { readAt: parsed.data.read ? new Date() : null },
  })
  revalidatePath('/notifications')
  return { ok: true }
}

export async function markAllNotificationsReadAction(): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireUser()
  await db.notification.updateMany({
    where: { userId: user.id, organizationId: user.organizationId, readAt: null },
    data: { readAt: new Date() },
  })
  revalidatePath('/notifications')
  return { ok: true }
}
