import 'server-only'
import type { Prisma } from '@prisma/client'
import { verifyIntakeToken } from '@/lib/call-center/intake-link'
import { intakeLinkTokenFrom } from './scs-packet'

type ScsLeadBinding = {
  id: string
  clientId: string | null
  lockedBy: string | null
  leadAttribution: Prisma.JsonValue | null
}

/** Resolve the signed referral BEFORE creating a Client. Contact similarity
 * never establishes a property identity. Hold the lead row until receipt,
 * Client updates and the link commit, including across different sources.
 */
export async function resolveScsLeadBinding(
  store: Prisma.TransactionClient,
  organizationId: string,
  raw: Record<string, unknown>,
): Promise<ScsLeadBinding | null> {
  const token = intakeLinkTokenFrom(raw)
  if (!token) return null
  const checked = verifyIntakeToken(token)
  if (!checked.ok) return null // The receiver retains its existing rejection audit.
  const rows = await store.$queryRaw<ScsLeadBinding[]>`
    SELECT id, "clientId", "lockedBy", "leadAttribution" FROM "CallCenterLead"
    WHERE id = ${checked.leadId} AND "organizationId" = ${organizationId}
    FOR UPDATE`
  return rows[0] ?? null
}
