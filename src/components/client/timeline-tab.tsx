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
import { db } from '@/lib/db'
import { smsStatusLabel } from '@/lib/telephony/carrier-errors'
import { RecordingPlayer } from '@/components/voice/recording-player'

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

  // Phone details for the communication rows on this page: the honest SMS
  // label, and the recording (played through the app's proxy by VoiceCall id).
  const commIds = events.filter((e) => e.kind === 'communication').map((e) => e.id.replace(/^comm-/, ''))
  const [comms, voiceCalls] = commIds.length
    ? await Promise.all([
        db.communication.findMany({
          where: { id: { in: commIds }, clientId },
          select: { id: true, channel: true, status: true, message: { select: { failureCode: true } } },
        }),
        db.voiceCall.findMany({
          where: { communicationId: { in: commIds } },
          select: {
            id: true,
            communicationId: true,
            recordingSid: true,
            recordingDurationSeconds: true,
            disclosureServedAt: true,
          },
        }),
      ])
    : [[], []]
  const commById = new Map(comms.map((c) => [c.id, c]))
  const voiceByComm = new Map(voiceCalls.map((v) => [v.communicationId, v]))

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
          const commId = event.kind === 'communication' ? event.id.replace(/^comm-/, '') : null
          const comm = commId ? commById.get(commId) : undefined
          const voiceCall = commId ? voiceByComm.get(commId) : undefined
          const badge =
            comm?.channel === 'SMS' ? smsStatusLabel(comm.status, comm.message?.failureCode) : event.badge
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
                  {badge && <Badge variant="outline">{badge}</Badge>}
                  {event.isInternal && <Badge variant="ghost">Internal</Badge>}
                </div>
                {event.description && (
                  <p className="text-muted-foreground mt-0.5 line-clamp-3 text-xs whitespace-pre-wrap">
                    {event.description}
                  </p>
                )}
                {voiceCall?.recordingSid && (
                  <RecordingPlayer
                    src={`/api/voice/recordings/${voiceCall.id}`}
                    seconds={voiceCall.recordingDurationSeconds}
                    className="mt-1.5 max-w-md"
                  />
                )}
                {voiceCall?.disclosureServedAt && (
                  <p className="text-muted-foreground mt-0.5 text-xs">Notice sent to the call</p>
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
