import 'server-only'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/rbac'
import { loadCallCenterLeadsFor, missingRelation } from './desk'
import { callLeadsForDesk, withDeskLinks } from './from-rows'
import type { CallLead } from './model'

/** Real texting is on only with a non-mock SMS provider (lib/messaging picks the adapter the same way). */
function smsLive(): boolean {
  return ((process.env.SMS_PROVIDER ?? 'mock').trim().toLowerCase() || 'mock') !== 'mock'
}

/** The SCS link and texting gates for the desk rows (docs/CYS_BRIDGE.md §B1, §B2). */
async function withLinks(organizationId: string, leads: CallLead[]): Promise<CallLead[]> {
  const ids = leads.filter((lead) => lead.persisted).map((lead) => lead.id)
  if (!ids.length) return leads
  const rows = await db.callCenterLead.findMany({
    where: { organizationId, id: { in: ids } },
    select: { id: true, clientId: true, intakeLinkSentAt: true, consentAt: true, consentRevokedAt: true, doNotCallAt: true },
  })
  return withDeskLinks(leads, rows, smsLive())
}

/** Desk rows for the signed-in workspace. Empty or unmigrated tables keep the seed. */
export async function loadCallCenterDesk(): Promise<{ leads: CallLead[]; viewerId: string }> {
  const user = await getSessionUser()
  if (!user) return { leads: callLeadsForDesk([]), viewerId: '' }
  try {
    const leads = await withLinks(user.organizationId, await loadCallCenterLeadsFor(user.organizationId, user.id))
    return { leads, viewerId: user.id }
  } catch (err) {
    if (missingRelation(err)) return { leads: callLeadsForDesk([]), viewerId: user.id }
    throw err
  }
}
