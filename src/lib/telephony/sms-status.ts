import 'server-only'
import { db } from '@/lib/db'
import { failureCodeText } from './carrier-errors'

/**
 * Honest SMS status (docs/TELEPHONY_LIVE.md §2.9). A 201 "queued" from Twilio
 * only means the carrier ACCEPTED the text — the row stays SENT ("Accepted by
 * carrier"). Only Twilio's own callback (or the sweep's fetch) moves it on:
 *
 *   delivered                  → DELIVERED + deliveredAt
 *   undelivered / failed       → FAILED + "<code>: <plain meaning>"
 *   sent / queued / accepted…  → stays SENT, providerStatus recorded
 *
 * Forward-only and idempotent: DELIVERED and FAILED are terminal.
 */

const TERMINAL = new Set(['DELIVERED', 'FAILED', 'READ'])

export type SmsStatusOutcome = 'delivered' | 'failed' | 'pending' | 'ignored'

export async function applySmsStatus(
  communicationId: string,
  input: { status: string | null | undefined; errorCode: string | null | undefined; at?: Date },
): Promise<SmsStatusOutcome> {
  const at = input.at ?? new Date()
  const comm = await db.communication.findUnique({
    where: { id: communicationId },
    select: { id: true, status: true, channel: true, message: { select: { id: true } } },
  })
  if (!comm || comm.channel !== 'SMS' || TERMINAL.has(comm.status)) return 'ignored'
  const status = (input.status ?? '').toLowerCase()

  if (status === 'delivered') {
    await db.communication.update({
      where: { id: comm.id },
      data: {
        status: 'DELIVERED',
        message: comm.message
          ? { update: { deliveredAt: at, providerStatus: status, providerStatusAt: at } }
          : { create: { deliveredAt: at, providerStatus: status, providerStatusAt: at } },
      },
    })
    return 'delivered'
  }

  if (status === 'undelivered' || status === 'failed') {
    const failure = input.errorCode ? failureCodeText(input.errorCode) : 'Delivery failed (no carrier code)'
    await db.communication.update({
      where: { id: comm.id },
      data: {
        status: 'FAILED',
        message: comm.message
          ? { update: { failureCode: failure, providerStatus: status, providerStatusAt: at } }
          : { create: { failureCode: failure, providerStatus: status, providerStatusAt: at } },
      },
    })
    return 'failed'
  }

  if (!status) return 'ignored'
  if (comm.message) {
    await db.message.update({ where: { id: comm.message.id }, data: { providerStatus: status, providerStatusAt: at } })
  }
  return 'pending'
}
