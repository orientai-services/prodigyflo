import 'server-only'
import { getSessionUser } from '@/lib/rbac'
import { loadCallCenterLeadsFor, missingRelation } from './desk'
import { callLeadsForDesk } from './from-rows'

/** Desk rows for the signed-in workspace. Empty or unmigrated tables keep the seed. */
export async function loadCallCenterDesk(): Promise<{ leads: Awaited<ReturnType<typeof loadCallCenterLeadsFor>>; viewerId: string }> {
  const user = await getSessionUser()
  if (!user) return { leads: callLeadsForDesk([]), viewerId: '' }
  try {
    const leads = await loadCallCenterLeadsFor(user.organizationId, user.id)
    return { leads, viewerId: user.id }
  } catch (err) {
    if (missingRelation(err)) return { leads: callLeadsForDesk([]), viewerId: user.id }
    throw err
  }
}
