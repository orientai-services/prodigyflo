import Link from 'next/link'
import {
  ArrowRightLeft,
  CalendarDays,
  CheckSquare,
  FileText,
  Inbox,
  ListChecks,
  MessageSquare,
  Send,
  ShieldCheck,
  Square,
  StickyNote,
} from 'lucide-react'
import { requireUser, requireClientInScope } from '@/lib/rbac'
import { buildTimeline, type TimelineKind } from '@/lib/timeline'
import { dateTime, relativeTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'

const KIND_ICON: Record<TimelineKind, React.ComponentType<{ className?: string }>> = {
  stage: ArrowRightLeft,
  communication: MessageSquare,
  document: FileText,
  document_review: ShieldCheck,
  task: Square,
  task_completed: CheckSquare,
  note: StickyNote,
  appointment: CalendarDays,
  submission: Send,
  intake: Inbox,
  audit: ListChecks,
}

export async function TimelineTab({ clientId, limit = 25 }: { clientId: string; limit?: number }) {
  const user = await requireUser()
  await requireClientInScope(user, clientId)

  const { events, hasMore } = await buildTimeline(user, clientId, { limit })

  if (events.length === 0) {
    return (
      <EmptyState
        icon="History"
        title="Nothing here yet"
        description="Stage moves, messages, documents, tasks and notes will appear in one feed."
      />
    )
  }

  return (
    <div>
      <ol className="relative space-y-0">
        {events.map((event, i) => {
          const Icon = KIND_ICON[event.kind]
          return (
            <li key={event.id} className="relative flex gap-3 pb-5">
              {i < events.length - 1 && (
                <span className="bg-border absolute top-7 left-[13px] h-full w-px" aria-hidden />
              )}
              <span className="bg-muted ring-background relative z-10 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ring-2">
                <Icon className="text-muted-foreground size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <p className="text-sm font-medium">{event.title}</p>
                  {event.badge && <Badge variant="outline">{event.badge}</Badge>}
                  {event.isInternal && <Badge variant="ghost">Internal</Badge>}
                </div>
                {event.description && (
                  <p className="text-muted-foreground mt-0.5 line-clamp-3 text-xs whitespace-pre-wrap">
                    {event.description}
                  </p>
                )}
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {event.actor ? `${event.actor} · ` : ''}
                  <time dateTime={event.at.toISOString()} title={dateTime(event.at)}>
                    {relativeTime(event.at)}
                  </time>
                </p>
              </div>
            </li>
          )
        })}
      </ol>

      {hasMore && (
        <div className="flex justify-center pt-1">
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/clients/${clientId}?tab=timeline&tlimit=${limit + 25}`} scroll={false} />}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}
