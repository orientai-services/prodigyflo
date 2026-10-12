import 'server-only'
import { getSessionUser } from '@/lib/rbac'
import { loadCallCenterDeskFor, missingRelation } from './desk'
import { callLeadsForDesk, withDeskLinks } from './from-rows'
import type { CallLead } from './model'

/** Real texting is on only with a non-mock SMS provider (lib/messaging picks the adapter the same way). */
function smsLive(): boolean {
  return ((process.env.SMS_PROVIDER ?? 'mock').trim().toLowerCase() || 'mock') !== 'mock'
}

/** Desk rows for the signed-in workspace. Empty or unmigrated tables keep the seed. */
export async function loadCallCenterDesk(): Promise<{ leads: CallLead[]; viewerId: string }> {
  const user = await getSessionUser()
  if (!user) return { leads: callLeadsForDesk([]), viewerId: '' }
  try {
    // The SCS link and texting gates for the desk rows (docs/CYS_BRIDGE.md §B1, §B2),
    // read with the rows themselves.
    const { leads, links } = await loadCallCenterDeskFor(user.organizationId, user.id)
    return { leads: withDeskLinks(leads, links, smsLive()), viewerId: user.id }
  } catch (err) {
    if (missingRelation(err)) return { leads: callLeadsForDesk([]), viewerId: user.id }
    throw err
  }
}
