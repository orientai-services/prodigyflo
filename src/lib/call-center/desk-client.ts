import 'server-only'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'

/**
 * How a dialer user may see the Client a desk lead became
 * (docs/CYS_BRIDGE.md §B2 scope rule).
 *
 * - `inScope`: the Client is inside the user's own scope (SUPER_ADMIN, or the
 *   CLOSER who owns it). Everything on the profile works as on /clients/[id].
 * - not `inScope`: the user holds this lead's lock. They get a read view;
 *   every write (approve brief, upload, request docs, assign) still goes
 *   through requireClientInScope and stays hidden.
 *
 * Null when the lead isn't in the user's workspace, has no Client, or the
 * user neither owns the Client nor holds the lead.
 */
export type DeskClientAccess = { clientId: string; inScope: boolean }

export async function findClientViaDeskLead(user: SessionUser, leadId: string): Promise<DeskClientAccess | null> {
  const lead = await db.callCenterLead.findFirst({
    where: { id: leadId, organizationId: user.organizationId },
    select: { clientId: true, lockedBy: true },
  })
  if (!lead?.clientId) return null
  const client = await db.client.findFirst({
    where: { id: lead.clientId, organizationId: user.organizationId, deletedAt: null },
    select: { id: true },
  })
  if (!client) return null
  const owned = await db.client.findFirst({ where: { AND: [clientScope(user), { id: client.id }] }, select: { id: true } })
  if (owned) return { clientId: client.id, inScope: true }
  if (lead.lockedBy === user.id) return { clientId: client.id, inScope: false }
  return null
}
