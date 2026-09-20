import 'server-only'
import { cache } from 'react'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'

/** Historical notification text must not reveal a client after reassignment. */
export const notificationScope = cache(async (user: SessionUser): Promise<Prisma.NotificationWhereInput> => {
  const base = { userId: user.id, organizationId: user.organizationId }
  if (user.role === 'SUPER_ADMIN') return base
  const clients = await db.client.findMany({ where: clientScope(user), select: { id: true } })
  return { ...base, OR: clients.flatMap(({ id }) => [
    { href: `/clients/${id}` }, { href: { startsWith: `/clients/${id}?` } }, { href: { startsWith: `/clients/${id}#` } },
  ]) }
})
