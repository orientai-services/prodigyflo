import 'server-only'
import { db } from '@/lib/db'

/**
 * The number an account texts from.
 *
 * A deliberately tiny seam — one indexed query, no imports beyond the client —
 * so the SMS adapter can prefer the account's own line without pulling the
 * whole telephony module (with its rbac, audit and step-up dependencies) into
 * the send path.
 *
 * Order: the account's main line, then its oldest active number. Accounts with
 * no number of their own return null and the adapter falls back to whatever
 * From is configured, exactly as before.
 */
export async function accountSendingNumber(organizationId: string): Promise<string | null> {
  const row = await db.phoneNumber.findFirst({
    where: { organizationId, status: 'ACTIVE' },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: { e164: true, capabilities: true },
  })
  if (!row) return null
  // A voice-only line cannot send SMS; fall through rather than fail the send.
  const caps = row.capabilities as { sms?: unknown } | null
  if (caps && 'sms' in caps && caps.sms !== true) return null
  return row.e164
}
