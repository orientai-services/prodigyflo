import 'server-only'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { readSecret } from '@/lib/call-center/contact'
import { phoneHash, PhoneHashKeyMissingError } from './compliance-core'
import { toE164 } from './provider'

/**
 * One-off after the telephony migration (§2.14): give every Call Center lead
 * that has a stored phone but no phoneHash its hash, so the do-not-call list,
 * consent and inbound-caller dedupe can find it. Phones stored by older code
 * are bare digits (7025551234); they go through toE164 first. Nothing is
 * rewritten except phoneHash, and only counts are reported — never numbers.
 * Dry run unless `execute`. Idempotent.
 */

export type BackfillCounts = { scanned: number; hashed: number; unreadable: number; unnormalizable: number; dryRun: boolean }

export async function backfillLeadPhoneHashes(opts: { execute: boolean; organizationId?: string; batch?: number }): Promise<BackfillCounts> {
  if (!process.env.PHONE_HASH_KEY) throw new PhoneHashKeyMissingError()
  const counts: BackfillCounts = { scanned: 0, hashed: 0, unreadable: 0, unnormalizable: 0, dryRun: !opts.execute }
  const batch = opts.batch ?? 500
  let cursor: string | undefined
  for (;;) {
    const rows = await db.callCenterLead.findMany({
      where: {
        phoneHash: null,
        phoneSecret: { not: Prisma.DbNull },
        ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: batch,
      select: { id: true, phoneSecret: true },
    })
    if (rows.length === 0) break
    for (const row of rows) {
      counts.scanned += 1
      const phone = readSecret(row.phoneSecret)
      if (!phone) {
        counts.unreadable += 1
        continue
      }
      const e164 = toE164(phone)
      if (!e164) {
        counts.unnormalizable += 1
        continue
      }
      if (opts.execute) {
        await db.callCenterLead.updateMany({ where: { id: row.id, phoneHash: null }, data: { phoneHash: phoneHash(e164) } })
      }
      counts.hashed += 1
    }
    cursor = rows[rows.length - 1].id
    if (rows.length < batch) break
  }
  return counts
}
