import Link from 'next/link'
import type { NotificationKind, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { cn } from '@/lib/utils'
import { MarkAllReadButton, NotificationList, type NotificationItem } from './notification-list'

export const metadata = { title: 'Notifications' }

const PAGE_SIZE = 30

/** Enum order doubles as display order. */
const KIND_LABELS: Record<NotificationKind, string> = {
  ASSIGNMENT: 'Assignments',
  APPOINTMENT: 'Appointments',
  DOCUMENT: 'Documents',
  SUBMISSION: 'Submissions',
  SLA_WARNING: 'SLA warnings',
  MESSAGE: 'Messages',
  SYSTEM: 'System',
}

const pill = (active: boolean) =>
  cn(
    'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
    active ? 'bg-primary text-primary-foreground border-transparent' : 'text-muted-foreground hover:bg-muted',
  )

export default async function NotificationsPage({ searchParams }: PageProps<'/notifications'>) {
  const user = await requireUser()
  const params = await searchParams

  const str = (v: string | string[] | undefined) => (typeof v === 'string' && v ? v : undefined)
  const filter = str(params.filter) === 'unread' ? 'unread' : 'all'
  const kindParam = str(params.kind)
  const kind = kindParam && kindParam in KIND_LABELS ? (kindParam as NotificationKind) : undefined
  const page = Math.max(1, Number(str(params.page) ?? 1) || 1)

  // Notifications are strictly the caller's own — never cross-user.
  const own: Prisma.NotificationWhereInput = { userId: user.id, organizationId: user.organizationId }
  const scope: Prisma.NotificationWhereInput = { ...own, ...(filter === 'unread' ? { readAt: null } : {}) }
  const where: Prisma.NotificationWhereInput = { ...scope, ...(kind ? { kind } : {}) }

  const [rows, total, kindCounts, allCount, unreadCount] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.notification.count({ where }),
    db.notification.groupBy({ by: ['kind'], where: scope, _count: { _all: true } }),
    db.notification.count({ where: own }),
    db.notification.count({ where: { ...own, readAt: null } }),
  ])

  const countByKind = new Map(kindCounts.map((k) => [k.kind, k._count._all]))
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const hrefFor = (next: { filter?: 'all' | 'unread'; kind?: NotificationKind | null; page?: number }) => {
    const sp = new URLSearchParams()
    if ((next.filter ?? filter) === 'unread') sp.set('filter', 'unread')
    const k = next.kind === undefined ? kind : (next.kind ?? undefined)
    if (k) sp.set('kind', k)
    if (next.page && next.page > 1) sp.set('page', String(next.page))
    const qs = sp.toString()
    return qs ? `/notifications?${qs}` : '/notifications'
  }

  const items: NotificationItem[] = rows.map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    href: n.href,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  }))

  return (
    <>
      <PageHeader
        title="Notifications"
        description={
          unreadCount > 0
            ? `${unreadCount.toLocaleString()} unread of ${allCount.toLocaleString()}`
            : `${allCount.toLocaleString()} notification${allCount === 1 ? '' : 's'}, all read`
        }
        actions={unreadCount > 0 ? <MarkAllReadButton /> : undefined}
      >
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <Link href={hrefFor({ filter: 'all', page: 1 })} className={pill(filter === 'all')}>
            All
            <span className="ml-1 tabular-nums opacity-70">{allCount}</span>
          </Link>
          <Link href={hrefFor({ filter: 'unread', page: 1 })} className={pill(filter === 'unread')}>
            Unread
            <span className="ml-1 tabular-nums opacity-70">{unreadCount}</span>
          </Link>

          {kindCounts.length > 0 && <span className="bg-border mx-1 h-4 w-px" aria-hidden />}

          {(Object.keys(KIND_LABELS) as NotificationKind[])
            .filter((k) => (countByKind.get(k) ?? 0) > 0 || k === kind)
            .map((k) => (
              <Link
                key={k}
                href={k === kind ? hrefFor({ kind: null, page: 1 }) : hrefFor({ kind: k, page: 1 })}
                className={pill(k === kind)}
              >
                {KIND_LABELS[k]}
                <span className="ml-1 tabular-nums opacity-70">{countByKind.get(k) ?? 0}</span>
              </Link>
            ))}
        </div>
      </PageHeader>

      {items.length === 0 ? (
        <EmptyState
          icon="BellOff"
          title={filter === 'unread' || kind ? 'Nothing matches these filters' : 'Nothing here yet'}
          description={
            filter === 'unread' || kind
              ? 'Try switching back to All or clearing the kind filter.'
              : 'New assignments, qualifier decisions, nurture confirmations, document and submission updates, and digests land here as they happen.'
          }
          action={
            filter === 'unread' || kind ? (
              <Button variant="outline" size="sm" render={<Link href="/notifications" />}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <NotificationList items={items} />

          {pageCount > 1 && (
            <nav className="flex items-center justify-between border-t px-4 py-3 sm:px-6" aria-label="Pagination">
              <p className="text-muted-foreground text-xs">
                Page {page} of {pageCount}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  render={<Link href={hrefFor({ page: page - 1 })} />}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pageCount}
                  render={<Link href={hrefFor({ page: page + 1 })} />}
                >
                  Next
                </Button>
              </div>
            </nav>
          )}
        </>
      )}
    </>
  )
}
