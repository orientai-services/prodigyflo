import Link from 'next/link'
import { ArrowDownLeft, Mail, MessageSquareText, Phone, ShieldAlert, StickyNote } from 'lucide-react'
import type { CommunicationChannel } from '@prisma/client'
import { db } from '@/lib/db'
import { can, clientScope, requirePermissionPage } from '@/lib/rbac'
import { dateTime, relativeTime } from '@/lib/format'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/empty-state'

export const metadata = { title: 'Inbox' }

const CHANNEL_ICON: Partial<Record<CommunicationChannel, typeof Mail>> = {
  EMAIL: Mail,
  SMS: MessageSquareText,
  IMESSAGE: MessageSquareText,
  CALL: Phone,
}

function channelLabel(channel: CommunicationChannel): string {
  if (channel === 'EMAIL') return 'Email'
  if (channel === 'SMS') return 'SMS'
  if (channel === 'IMESSAGE') return 'iMessage'
  return channel.toLowerCase().replace(/_/g, ' ')
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePermissionPage('communications:read')
  const params = await searchParams
  const filter = params.filter === 'unanswered' ? 'unanswered' : 'all'

  const [inbound, unmatchedNotifications] = await Promise.all([
    db.communication.findMany({
      where: { direction: 'INBOUND', client: { is: clientScope(user) } },
      orderBy: { occurredAt: 'desc' },
      take: 100,
      include: {
        client: { select: { id: true, firstName: true, lastName: true } },
        message: { select: { fromMasked: true, optOutDetected: true } },
      },
    }),
    can(user, 'users:manage')
      ? db.notification.findMany({
          where: { userId: user.id, kind: 'MESSAGE', title: { startsWith: 'Unmatched inbound' } },
          orderBy: { createdAt: 'desc' },
          take: 10,
        })
      : Promise.resolve([]),
  ])

  // "Unanswered" = nothing OUTBOUND on that client since the inbound arrived.
  const clientIds = [...new Set(inbound.map((c) => c.clientId))]
  const lastOutbound = clientIds.length
    ? await db.communication.groupBy({
        by: ['clientId'],
        where: { clientId: { in: clientIds }, direction: 'OUTBOUND' },
        _max: { occurredAt: true },
      })
    : []
  const lastOutboundAt = new Map(lastOutbound.map((g) => [g.clientId, g._max.occurredAt]))
  const isUnanswered = (c: (typeof inbound)[number]) => {
    const out = lastOutboundAt.get(c.clientId)
    return !out || out.getTime() < c.occurredAt.getTime()
  }

  const unansweredCount = inbound.filter(isUnanswered).length
  const rows = filter === 'unanswered' ? inbound.filter(isUnanswered) : inbound

  const filterTabs = [
    { key: 'all', label: `All (${inbound.length})`, href: '/inbox' },
    { key: 'unanswered', label: `Unanswered (${unansweredCount})`, href: '/inbox?filter=unanswered' },
  ]

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Every reply your clients send back — email and SMS — across the clients you can see, newest first."
      >
        <div className="mt-3 flex gap-1 rounded-md border p-0.5 text-sm" role="tablist" aria-label="Inbox filter">
          {filterTabs.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              role="tab"
              aria-selected={filter === t.key}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                filter === t.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </PageHeader>

      <div className="space-y-4 p-4 sm:p-6">
        {unmatchedNotifications.length > 0 && (
          <div className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <ShieldAlert className="size-4 text-amber-600 dark:text-amber-400" />
              Unmatched inbound messages
            </p>
            <p className="text-muted-foreground text-xs">
              These arrived from senders that do not match any client on file. Create the client (or fix the contact
              details on an existing one) and the next message will thread automatically.
            </p>
            <ul className="space-y-1.5">
              {unmatchedNotifications.map((n) => (
                <li key={n.id} className="rounded-md border bg-background p-2.5 text-sm">
                  <span className="font-medium">{n.title}</span>
                  {n.body && <span className="text-muted-foreground"> — {n.body}</span>}
                  <span className="text-muted-foreground ml-1 text-xs" title={dateTime(n.createdAt)}>
                    {relativeTime(n.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {rows.length === 0 ? (
          filter === 'unanswered' ? (
            <EmptyState
              icon="CheckCheck"
              title="All caught up"
              description="Every inbound message has an outbound reply after it. Nice."
            />
          ) : (
            <EmptyState
              icon="Inbox"
              title="No inbound messages yet"
              description="When a client replies to an email or texts back, the message lands here and on their conversation timeline."
            />
          )
        ) : (
          <ol className="space-y-2">
            {rows.map((c) => {
              const Icon = CHANNEL_ICON[c.channel] ?? StickyNote
              const unanswered = isUnanswered(c)
              const snippet = (c.body ?? '').replace(/\s+/g, ' ').trim()
              return (
                <li key={c.id}>
                  <Link
                    href={`/clients/${c.clientId}?tab=communications`}
                    className="bg-surface-raised shadow-e1 hover:border-ring/60 flex items-start gap-3 rounded-lg border p-3 transition-colors"
                  >
                    <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-full">
                      <Icon className="text-muted-foreground size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-medium">
                          {c.client.firstName} {c.client.lastName}
                        </span>
                        <span className="text-muted-foreground flex items-center gap-1 text-xs">
                          <ArrowDownLeft className="size-3" />
                          {channelLabel(c.channel)}
                          {c.message?.fromMasked && ` · ${c.message.fromMasked}`}
                        </span>
                        {unanswered && (
                          <Badge variant="outline" className="border-amber-500/60 text-[10px] tracking-wide uppercase">
                            Unanswered
                          </Badge>
                        )}
                        {c.message?.optOutDetected && (
                          <Badge variant="outline" className="border-destructive/60 text-destructive text-[10px] tracking-wide uppercase">
                            Opt-out
                          </Badge>
                        )}
                        <span className="text-muted-foreground ml-auto text-xs" title={dateTime(c.occurredAt)}>
                          {relativeTime(c.occurredAt)}
                        </span>
                      </div>
                      {c.subject && <p className="mt-0.5 truncate text-sm font-medium">{c.subject}</p>}
                      {snippet && (
                        <p className="text-muted-foreground mt-0.5 line-clamp-2 text-sm">{snippet}</p>
                      )}
                    </div>
                  </Link>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </>
  )
}
