import 'server-only'
import { db } from '@/lib/db'
import { applyMovement, InsufficientFundsError } from './billing'
import { formatE164 } from './provider'
import { money } from './pricing'

/**
 * The monthly rent on every line, charged by the job runner.
 *
 * Two behaviours, and the difference is the whole point of the two billing
 * modes:
 *
 *  - AGENCY_CARD: the carrier already billed the agency's card, so the renewal
 *    only writes the ledger entry that makes that spend visible.
 *  - WALLET: the balance is debited. If it will not cover the month, the line
 *    is SUSPENDED and its admins are told — never released. A released number
 *    is gone forever and a customer who is three days late on a top-up should
 *    not lose the number printed on their trucks.
 *
 * A suspended line comes back the moment the wallet is funded
 * (see resumeSuspendedNumbers, called from the top-up action).
 *
 * Renewal dates advance from the DUE date, not from now, so a late run never
 * silently skips a month; the loop is bounded so a very overdue row catches up
 * over a few ticks rather than minting a year of charges at once.
 */

export const MAX_CATCHUP_MONTHS = 3

function addMonths(date: Date, months: number): Date {
  const next = new Date(date)
  next.setMonth(next.getMonth() + months)
  return next
}

export type RenewalSummary = {
  charged: number
  suspended: number
  skipped: number
}

export async function renewNumbers(now: Date = new Date()): Promise<RenewalSummary> {
  const summary: RenewalSummary = { charged: 0, suspended: 0, skipped: 0 }

  const due = await db.phoneNumber.findMany({
    where: { status: 'ACTIVE', nextRenewalAt: { lte: now } },
    orderBy: { nextRenewalAt: 'asc' },
    take: 200,
    select: {
      id: true,
      organizationId: true,
      e164: true,
      friendlyName: true,
      monthlyCostCents: true,
      nextRenewalAt: true,
    },
  })

  for (const number of due) {
    const dueAt = number.nextRenewalAt ?? now
    let periods = 0
    let cursor = dueAt
    while (cursor <= now && periods < MAX_CATCHUP_MONTHS) {
      periods += 1
      cursor = addMonths(dueAt, periods)
    }
    const amountCents = number.monthlyCostCents * periods
    if (amountCents <= 0) {
      await db.phoneNumber.update({ where: { id: number.id }, data: { nextRenewalAt: cursor } })
      summary.skipped += 1
      continue
    }

    try {
      await db.$transaction(async (tx) => {
        await applyMovement(tx, {
          organizationId: number.organizationId,
          kind: 'NUMBER_MONTHLY',
          amountCents,
          signedAmountCents: -amountCents,
          description: `${formatE164(number.e164)} — ${number.friendlyName} (${periods === 1 ? 'monthly' : `${periods} months`})`,
          phoneNumberId: number.id,
        })
        await tx.phoneNumber.update({ where: { id: number.id }, data: { nextRenewalAt: cursor } })
      })
      summary.charged += 1
    } catch (err) {
      if (!(err instanceof InsufficientFundsError)) throw err
      await db.phoneNumber.update({ where: { id: number.id }, data: { status: 'SUSPENDED' } })
      await notifySuspension(number.organizationId, number.e164, number.friendlyName, amountCents)
      summary.suspended += 1
    }
  }

  return summary
}

async function notifySuspension(
  organizationId: string,
  e164: string,
  friendlyName: string,
  amountCents: number,
): Promise<void> {
  const admins = await db.user.findMany({
    where: {
      organizationId,
      isActive: true,
      deletedAt: null,
      role: { permissions: { some: { permission: { key: 'telephony:manage' } } } },
    },
    select: { id: true },
  })
  if (admins.length === 0) return
  await db.notification.createMany({
    data: admins.map((a) => ({
      organizationId,
      userId: a.id,
      kind: 'SYSTEM' as const,
      title: 'A phone line is suspended',
      body: `${formatE164(e164)} (${friendlyName}) needs ${money(amountCents)} to renew. Calls and texts to it stop until the balance is topped up — the number is still yours.`,
      href: '/settings/phone-numbers',
    })),
  })
  await db.auditEvent.create({
    data: {
      organizationId,
      actorLabel: 'Telephony renewal',
      action: 'telephony.number_suspended',
      entityType: 'PhoneNumber',
      summary: `${formatE164(e164)} suspended — balance did not cover ${money(amountCents)}`,
    },
  })
}

/**
 * Brings suspended lines back after a top-up. Charges the month that was
 * missed, so nobody gets a free period by letting the balance lapse.
 */
export async function resumeSuspendedNumbers(organizationId: string, now: Date = new Date()): Promise<number> {
  const suspended = await db.phoneNumber.findMany({
    where: { organizationId, status: 'SUSPENDED' },
    select: { id: true, e164: true, friendlyName: true, monthlyCostCents: true, nextRenewalAt: true },
  })

  let resumed = 0
  for (const number of suspended) {
    try {
      await db.$transaction(async (tx) => {
        if (number.monthlyCostCents > 0) {
          await applyMovement(tx, {
            organizationId,
            kind: 'NUMBER_MONTHLY',
            amountCents: number.monthlyCostCents,
            signedAmountCents: -number.monthlyCostCents,
            description: `${formatE164(number.e164)} — ${number.friendlyName} (resumed)`,
            phoneNumberId: number.id,
          })
        }
        await tx.phoneNumber.update({
          where: { id: number.id },
          data: { status: 'ACTIVE', nextRenewalAt: addMonths(now, 1) },
        })
      })
      resumed += 1
    } catch (err) {
      if (err instanceof InsufficientFundsError) break
      throw err
    }
  }
  return resumed
}
