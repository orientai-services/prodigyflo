'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { NotificationKind } from '@prisma/client'
import {
  AlertTriangle,
  CalendarClock,
  CheckCheck,
  FileText,
  Info,
  Loader2,
  MailOpen,
  Mail,
  MessageSquare,
  Send,
  UserPlus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { markAllNotificationsReadAction, setNotificationReadAction } from './actions'

export type NotificationItem = {
  id: string
  kind: NotificationKind
  title: string
  body: string | null
  href: string | null
  readAt: string | null
  createdAt: string
}

const KIND_ICONS: Record<NotificationKind, React.ComponentType<{ className?: string }>> = {
  ASSIGNMENT: UserPlus,
  APPOINTMENT: CalendarClock,
  DOCUMENT: FileText,
  SUBMISSION: Send,
  SLA_WARNING: AlertTriangle,
  MESSAGE: MessageSquare,
  SYSTEM: Info,
}

export function MarkAllReadButton() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await markAllNotificationsReadAction()
          router.refresh()
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCheck className="size-3.5" />}
      Mark all read
    </Button>
  )
}

function Row({ notification: n }: { notification: NotificationItem }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const Icon = KIND_ICONS[n.kind] ?? Info
  const unread = !n.readAt

  const open = () => {
    startTransition(async () => {
      if (unread) await setNotificationReadAction({ id: n.id, read: true })
      if (n.href) router.push(n.href)
      else router.refresh()
    })
  }

  const toggle = () => {
    startTransition(async () => {
      await setNotificationReadAction({ id: n.id, read: unread })
      router.refresh()
    })
  }

  return (
    <li className={cn('group relative transition-colors', unread ? 'bg-brand/[0.04] hover:bg-brand/[0.07]' : 'hover:bg-muted/40')}>
      <button
        type="button"
        onClick={open}
        disabled={pending}
        className="flex w-full items-start gap-3 px-4 py-3 text-left sm:px-6"
        aria-label={n.href ? `Open notification: ${n.title}` : `Mark read: ${n.title}`}
      >
        <span
          className={cn(
            'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
            unread ? 'bg-brand/10 text-brand' : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1 pr-10">
          <span className="flex items-center gap-1.5">
            {unread && <span className="bg-brand size-1.5 shrink-0 rounded-full" aria-label="Unread" />}
            <span className={cn('truncate text-sm leading-snug', unread ? 'font-semibold' : 'font-medium')}>{n.title}</span>
          </span>
          {n.body && <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-xs leading-snug">{n.body}</span>}
          <span className="text-muted-foreground mt-1 block text-[0.7rem]">{relativeTime(n.createdAt)}</span>
        </span>
      </button>

      <span className="absolute top-3 right-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 sm:right-5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={pending}
                onClick={toggle}
                aria-label={unread ? 'Mark as read' : 'Mark as unread'}
              >
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : unread ? (
                  <MailOpen className="size-3.5" />
                ) : (
                  <Mail className="size-3.5" />
                )}
              </Button>
            }
          />
          <TooltipContent>{unread ? 'Mark as read' : 'Mark as unread'}</TooltipContent>
        </Tooltip>
      </span>
    </li>
  )
}

export function NotificationList({ items }: { items: NotificationItem[] }) {
  return (
    <ul className="divide-y">
      {items.map((n) => (
        <Row key={n.id} notification={n} />
      ))}
    </ul>
  )
}
