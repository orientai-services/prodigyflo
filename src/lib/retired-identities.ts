import 'server-only'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
export const retiredIdentityHash = (kind: string, value: string) => createHash('sha256').update(JSON.stringify([kind, value])).digest('hex')
export class RetiredIntakeError extends Error { constructor() { super('retired_test') } }
export async function isRetiredIdentity(items: [string, string | null | undefined][]): Promise<boolean> {
  const ids = items.filter(([, value]) => Boolean(value)).map(([kind, value]) => retiredIdentityHash(kind, value!))
  return ids.length > 0 && Boolean(await db.retiredIdentity.findFirst({ where: { id: { in: ids } }, select: { id: true } }))
}
