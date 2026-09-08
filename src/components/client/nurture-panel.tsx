import { ClipboardList, ExternalLink, Mail, MessageSquare, Video } from 'lucide-react'
import type { NurtureKind } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, requireUser, type SessionUser } from '@/lib/rbac'
import { NURTURE_KIND_LABEL, nurtureStatus, type NurtureStatus } from '@/lib/nurture'
import { dateTime, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  ConfirmTouchButton,
  LogNurtureDialog,
} from '@/app/(app)/sales/nurture/nurture-controls'

/** none / sent / confirmed chip for a client's pre-call nurture. */
export function NurtureStatusChip({ status }: { status: NurtureStatus }) {
  if (status === 'confirmed') {
    return (
      <span className="bg-success/10 text-success inline-flex h-5 items-center rounded-full px-2 text-xs font-medium">
        Nurture confirmed
      </span>
    )
  }
  if (status === 'sent') {
    return (
      <span className="bg-warning/10 text-warning inline-flex h-5 items-center rounded-full px-2 text-xs font-medium">
        Sent, unconfirmed
      </span>
    )
  }
  return (
    <span className="text-muted-foreground bg-muted inline-flex h-5 items-center rounded-full px-2 text-xs font-medium">
      Needs nurture
    </span>
  )
}

const KIND_ICON: Record<NurtureKind, React.ComponentType<{ className?: string }>> = {
  VIDEO: Video,
  EMAIL: Mail,
  SMS: MessageSquare,
  CALL_PREP: ClipboardList,
}

/**
 * A client's pre-call nurture history with the same log/confirm actions as the
 * /sales/nurture queue. Self-contained: re-checks access internally, so it can
 * be dropped into the client detail page with just `<NurturePanel clientId={id} />`.
 */
export async function NurturePanel({
  clientId,
  user,
  className,
}: {
  clientId: string
  user?: SessionUser
  className?: string
}) {
  const viewer = user ?? (await requireUser())

  // Never trust the caller — the client must be inside the viewer's scope.
  const client = await db.client.findFirst({
    where: { AND: [clientScope(viewer), { id: clientId }] },
    select: { id: true, firstName: true, lastName: true },
  })
  if (!client) return null

  const touches = await db.nurtureTouch.findMany({
    where: { clientId: client.id, organizationId: viewer.organizationId },
    orderBy: { sentAt: 'desc' },
    take: 20,
    select: {
      id: true,
      kind: true,
      url: true,
      note: true,
      sentAt: true,
      confirmedAt: true,
      sender: { select: { name: true } },
    },
  })
  const status = nurtureStatus(touches)
  const clientName = `${client.firstName} ${client.lastName}`

  return (
    <section className={cn('bg-card shadow-e1 rounded-xl border', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Pre-call nurture</h3>
          <NurtureStatusChip status={status} />
        </div>
        <LogNurtureDialog clientId={client.id} clientName={clientName} variant="outline" />
      </div>

      {touches.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm">
          No touches yet. Send {client.firstName} something personal — a short video works best —
          then log it here.
        </p>
      ) : (
        <ul className="divide-y">
          {touches.map((touch) => {
            const Icon = KIND_ICON[touch.kind]
            return (
              <li key={touch.id} className="flex items-start gap-3 px-4 py-3">
                <div className="bg-muted mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full">
                  <Icon className="text-muted-foreground size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {NURTURE_KIND_LABEL[touch.kind]}
                    {touch.url && (
                      <a
                        href={touch.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary ml-2 inline-flex items-center gap-1 text-xs font-medium hover:underline"
                      >
                        Open link <ExternalLink className="size-3" />
                      </a>
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Sent by {touch.sender.name} · {dateTime(touch.sentAt)}
                    {touch.confirmedAt && (
                      <span className="text-success">
                        {' '}
                        · confirmed {relativeTime(touch.confirmedAt)}
                      </span>
                    )}
                  </p>
                  {touch.note && (
                    <p className="text-muted-foreground mt-1 text-sm whitespace-pre-wrap">
                      {touch.note}
                    </p>
                  )}
                </div>
                {!touch.confirmedAt && (
                  <div className="shrink-0">
                    <ConfirmTouchButton touchId={touch.id} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
