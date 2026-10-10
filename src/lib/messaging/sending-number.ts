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
 * Order: the account's main line, then its other active numbers, oldest first
 * — the first one that can text. A voice-only main line no longer hides an
 * SMS-capable second line.
 *
 * `accountSid` keeps the line on the carrier account the text is sent from:
 * only lines recorded on that account (or older rows with no account noted)
 * qualify. Accounts with no texting line of their own return null, and the
 * adapter refuses the send rather than borrowing anyone else's number.
 */
export async function accountSendingNumber(
  organizationId: string,
  opts: { accountSid?: string | null } = {},
): Promise<string | null> {
  const rows = await db.phoneNumber.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      ...(opts.accountSid ? { OR: [{ providerAccountSid: opts.accountSid }, { providerAccountSid: null }] } : {}),
    },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    take: 50,
    select: { e164: true, capabilities: true },
  })
  return rows.find((row) => canText(row.capabilities))?.e164 ?? null
}

/** A line can text unless the carrier said it can't (no capabilities on file = assume it can). */
function canText(capabilities: unknown): boolean {
  const caps = capabilities as { sms?: unknown } | null
  return !(caps && typeof caps === 'object' && 'sms' in caps && caps.sms !== true)
}
