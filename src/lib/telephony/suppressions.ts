import 'server-only'
import type { CallCenterSuppression, Prisma } from '@prisma/client'
import { db } from '@/lib/db'

/**
 * The internal do-not-contact list: ONE row per (organization, number hash),
 * with a pair of columns per channel (smsBlockedAt/Source, callBlockedAt/Source)
 * — the existing unique index stays. No number is stored, only its
 * PHONE_HASH_KEY hash and last four.
 *
 *   STOP            sets the SMS pair (source sms_stop)
 *   "Do not call"   sets the call pair AND the SMS pair (source call_center)
 *   START / UNSTOP  clears the SMS pair only where the source is sms_stop
 *   removal         clears both pairs and stamps removedAt; a later block
 *                   revives the same row instead of adding a second one
 *
 * A legacy row (both pairs null, not removed) blocks both channels; when one
 * of its pairs is set, the other is filled in too so it keeps blocking both.
 */

export type BlockSource = 'sms_stop' | 'sms_stop_review' | 'manual' | 'call_center' | 'import'

export type BlockInput = {
  organizationId: string
  numberHash: string
  last4: string | null
  sms?: BlockSource | null
  call?: BlockSource | null
  reason: string
  note?: string | null
  createdById?: string | null
}

function isLegacy(row: Pick<CallCenterSuppression, 'smsBlockedAt' | 'callBlockedAt' | 'removedAt'>): boolean {
  return !row.removedAt && !row.smsBlockedAt && !row.callBlockedAt
}

export async function blockNumber(input: BlockInput, now = new Date()): Promise<CallCenterSuppression> {
  const existing = await db.callCenterSuppression.findUnique({
    where: { organizationId_numberHash: { organizationId: input.organizationId, numberHash: input.numberHash } },
  })
  if (!existing) {
    return db.callCenterSuppression.create({
      data: {
        organizationId: input.organizationId,
        numberHash: input.numberHash,
        reason: input.reason.slice(0, 200),
        last4: input.last4,
        smsBlockedAt: input.sms ? now : null,
        smsBlockedSource: input.sms ?? null,
        callBlockedAt: input.call ? now : null,
        callBlockedSource: input.call ?? null,
        note: input.note?.slice(0, 500) ?? null,
        createdById: input.createdById ?? null,
      },
    })
  }

  const data: Prisma.CallCenterSuppressionUpdateInput = {}
  const revive = Boolean(existing.removedAt)
  if (revive) {
    data.removedAt = null
    data.removedById = null
    data.reason = input.reason.slice(0, 200)
  }
  if (isLegacy(existing)) {
    // Keep a legacy row blocking both channels once it gets explicit pairs.
    data.smsBlockedAt = existing.createdAt
    data.smsBlockedSource = 'import'
    data.callBlockedAt = existing.createdAt
    data.callBlockedSource = 'import'
  }
  // A manual or call-desk block replaces a pending review; nothing downgrades a real block.
  if (input.sms && (revive || !existing.smsBlockedAt || existing.smsBlockedSource === 'sms_stop_review')) {
    data.smsBlockedAt = now
    data.smsBlockedSource = input.sms
  }
  if (input.call && (revive || !existing.callBlockedAt)) {
    data.callBlockedAt = now
    data.callBlockedSource = input.call
  }
  if (!existing.last4 && input.last4) data.last4 = input.last4
  if (input.note) data.note = input.note.slice(0, 500)
  if (Object.keys(data).length === 0) return existing
  return db.callCenterSuppression.update({ where: { id: existing.id }, data })
}

/**
 * Clear one row's SMS pair. When no call block is left the row is marked
 * removed too — a row with both pairs empty and no removedAt reads as a legacy
 * "block both" row, which is the opposite of what lifting a block means.
 */
export async function clearSmsPair(
  where: { organizationId: string; numberHash?: string; id?: string; smsBlockedSource: BlockSource },
  removedById: string | null,
  now = new Date(),
): Promise<number> {
  const base = { ...where, removedAt: null }
  const [withCall, smsOnly] = await db.$transaction([
    db.callCenterSuppression.updateMany({
      where: { ...base, callBlockedAt: { not: null } },
      data: { smsBlockedAt: null, smsBlockedSource: null },
    }),
    db.callCenterSuppression.updateMany({
      where: { ...base, callBlockedAt: null },
      data: { smsBlockedAt: null, smsBlockedSource: null, removedAt: now, removedById },
    }),
  ])
  return withCall.count + smsOnly.count
}

/** START / UNSTOP: lift only a STOP-made SMS block. Never a call block, a review hold or a manual block. */
export async function clearSmsStop(organizationId: string, numberHash: string, now = new Date()): Promise<boolean> {
  return (await clearSmsPair({ organizationId, numberHash, smsBlockedSource: 'sms_stop' }, null, now)) > 0
}

/** Manager removal: clears both pairs, keeps the row (and its history). */
export async function removeBlock(id: string, organizationId: string, userId: string, note: string, now = new Date()) {
  return db.callCenterSuppression.updateMany({
    where: { id, organizationId, removedAt: null },
    data: {
      removedAt: now,
      removedById: userId,
      smsBlockedAt: null,
      smsBlockedSource: null,
      callBlockedAt: null,
      callBlockedSource: null,
      note: note.slice(0, 500),
    },
  })
}
