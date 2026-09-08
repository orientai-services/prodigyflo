'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, ListPlus, Loader2, Mail, MessageSquareText, OctagonX, Workflow, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { cancelScheduledMessageAction, enrollClientAction, stopEnrollmentAction } from './actions'

/** Client-side widgets for the communications tab: the "Scheduled" strip and
 *  the sequence-enrollment control. Server data comes in as plain props. */

export type ScheduledItem = {
  id: string
  channel: 'EMAIL' | 'SMS'
  templateName: string | null
  subject: string | null
  body: string | null
  sendAt: string // pre-formatted for display
  attempts: number
  error: string | null
}

export function ScheduledMessagesStrip({ items }: { items: ScheduledItem[] }) {
  const router = useRouter()
  const [pendingId, setPendingId] = useState<string | null>(null)

  if (items.length === 0) return null

  const cancel = async (id: string) => {
    setPendingId(id)
    const result = await cancelScheduledMessageAction(id)
    setPendingId(null)
    if (result.ok) {
      toast.success(result.message ?? 'Cancelled.')
      router.refresh()
    } else {
      toast.error(result.error)
    }
  }

  return (
    <div>
      <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">Scheduled</h3>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <CalendarClock className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  {item.channel === 'EMAIL' ? <Mail className="size-3.5" /> : <MessageSquareText className="size-3.5" />}
                  <span className="truncate">
                    {item.templateName ?? item.subject ?? (item.body ? `${item.body.slice(0, 60)}${item.body.length > 60 ? '…' : ''}` : 'Message')}
                  </span>
                </p>
                <p className="text-muted-foreground text-xs">
                  Sends {item.sendAt}
                  {item.attempts > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {' '}
                      · retry {item.attempts} of 3{item.error ? ` — ${item.error}` : ''}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={pendingId !== null}
              onClick={() => cancel(item.id)}
              title="Cancel this scheduled message"
            >
              {pendingId === item.id ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
              Cancel
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

export type EnrollmentInfo = {
  id: string
  sequenceName: string
  status: 'ACTIVE' | 'COMPLETED' | 'STOPPED' | 'FAILED'
  stepLabel: string // e.g. "step 2 of 3 · next Mon, Aug 24, 9:00 AM"
  stoppedReason: string | null
}

export type SequenceOption = { id: string; name: string; stepCount: number }

const ENROLLMENT_STYLE: Record<EnrollmentInfo['status'], string> = {
  ACTIVE: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  COMPLETED: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  STOPPED: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  FAILED: 'bg-destructive/15 text-destructive',
}

export function SequenceEnrollmentPanel({
  clientId,
  sequences,
  enrollments,
  canSend,
}: {
  clientId: string
  sequences: SequenceOption[]
  enrollments: EnrollmentInfo[]
  canSend: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [sequenceId, setSequenceId] = useState('')
  const [stoppingId, setStoppingId] = useState<string | null>(null)

  // Hide sequences the client is actively enrolled in from the picker.
  const activeNames = new Set(enrollments.filter((e) => e.status === 'ACTIVE').map((e) => e.sequenceName))
  const enrollable = sequences.filter((s) => !activeNames.has(s.name))

  if (enrollments.length === 0 && (!canSend || sequences.length === 0)) return null

  const enroll = () => {
    if (!sequenceId) return
    startTransition(async () => {
      const result = await enrollClientAction({ clientId, sequenceId })
      if (result.ok) {
        toast.success(result.message ?? 'Enrolled.')
        setSequenceId('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const stop = async (id: string) => {
    setStoppingId(id)
    const result = await stopEnrollmentAction(id)
    setStoppingId(null)
    if (result.ok) {
      toast.success(result.message ?? 'Stopped.')
      router.refresh()
    } else {
      toast.error(result.error)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase">
        <Workflow className="size-3.5" />
        Sequences
      </h3>

      {enrollments.length > 0 && (
        <ul className="space-y-1.5">
          {enrollments.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase ${ENROLLMENT_STYLE[e.status]}`}
              >
                {e.status.toLowerCase()}
              </span>
              <span className="font-medium">{e.sequenceName}</span>
              <span className="text-muted-foreground text-xs">{e.stepLabel}</span>
              {e.stoppedReason && <span className="text-muted-foreground text-xs">— {e.stoppedReason}</span>}
              {e.status === 'ACTIVE' && canSend && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive ml-auto h-6 px-2"
                  disabled={stoppingId !== null}
                  onClick={() => stop(e.id)}
                  title="Stop this sequence for this client"
                >
                  {stoppingId === e.id ? <Loader2 className="size-3 animate-spin" /> : <OctagonX className="size-3" />}
                  Stop
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canSend && enrollable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <NativeSelect
            aria-label="Sequence to enroll in"
            size="sm"
            className="max-w-72 flex-1"
            value={sequenceId}
            onChange={(e) => setSequenceId(e.target.value)}
          >
            <option value="">Enroll in a sequence…</option>
            {enrollable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.stepCount} step{s.stepCount === 1 ? '' : 's'})
              </option>
            ))}
          </NativeSelect>
          <Button size="sm" variant="outline" disabled={!sequenceId || pending} onClick={enroll}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <ListPlus className="size-3.5" />}
            Enroll
          </Button>
        </div>
      )}
    </div>
  )
}
