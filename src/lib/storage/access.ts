import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'

/**
 * Scope filter for documents: a user reaches a document only through a client
 * they are allowed to see. Every document query goes through this — the same
 * single-source-of-truth rule as clientScope itself.
 */
export function documentScope(user: SessionUser): Prisma.ClientDocumentWhereInput {
  return { client: clientScope(user) }
}

/** Loads one document inside the caller's scope, or null when out of reach. */
export async function findDocumentInScope<T extends Prisma.ClientDocumentInclude>(
  user: SessionUser,
  documentId: string,
  include?: T,
) {
  return db.clientDocument.findFirst({
    where: { AND: [documentScope(user), { id: documentId }] },
    ...(include ? { include } : {}),
  })
}
