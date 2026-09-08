import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { clientScope, getSessionUser, userScope } from '@/lib/rbac'

/** Global search. Every query is constrained by the caller's data scope. */
export async function GET(request: Request) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ results: [] }, { status: 401 })

  const term = new URL(request.url).searchParams.get('q')?.trim() ?? ''
  if (term.length < 2) return NextResponse.json({ results: [] })

  if (user.role === 'CLIENT') return NextResponse.json({ results: [] })

  const [clients, users] = await Promise.all([
    db.client.findMany({
      where: {
        AND: [
          clientScope(user),
          {
            OR: [
              { firstName: { contains: term, mode: 'insensitive' } },
              { lastName: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
              { phone: { contains: term } },
            ],
          },
        ],
      },
      select: {
        id: true, firstName: true, lastName: true, email: true,
        currentStage: { select: { name: true } },
      },
      take: 7,
      orderBy: { lastActivityAt: 'desc' },
    }),
    user.permissions.has('users:read')
      ? db.user.findMany({
          where: {
            AND: [
              userScope(user),
              { OR: [{ name: { contains: term, mode: 'insensitive' } }, { email: { contains: term, mode: 'insensitive' } }] },
            ],
          },
          select: { id: true, name: true, email: true, role: { select: { name: true } } },
          take: 4,
        })
      : Promise.resolve([]),
  ])

  return NextResponse.json({
    results: [
      ...clients.map((c) => ({
        id: c.id,
        kind: 'client' as const,
        label: `${c.firstName} ${c.lastName}`,
        sublabel: c.currentStage.name,
        href: `/clients/${c.id}`,
      })),
      ...users.map((u) => ({
        id: u.id,
        kind: 'user' as const,
        label: u.name,
        sublabel: u.role.name,
        // No per-user detail page exists; deep-link the list with the row highlighted.
        href: `/settings/users?highlight=${u.id}`,
      })),
    ],
  })
}
