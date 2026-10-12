'use server'

import { requireUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { provisionLink } from './link'

/**
 * "Link your SunOff account" on the Team chat card (docs/CYS_BRIDGE.md §F D2).
 * Acts only for the signed-in user. Lane handoff's provisionSunoffUser() does
 * the real work (match by email, else create the SunOff user and email them);
 * ./link.ts is the seam.
 */
export async function linkSunoffAccount(): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser()
  const res = await provisionLink(user.id)
  if (!res.ok) return { ok: false, error: res.error }
  await recordAudit(user, {
    action: 'chat.account_linked',
    entityType: 'User',
    entityId: user.id,
    summary: res.created ? 'Created and linked a SunOff account for the team chat' : 'Linked a SunOff account for the team chat',
    after: { sunoffUser: `u${res.sunoffUserId}`, created: res.created },
  }).catch(() => undefined)
  return { ok: true }
}
