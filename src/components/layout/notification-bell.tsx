'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bell, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { relativeTime } from '@/lib/format'

type Notification = {
  id: string
  kind: string
  title: string
  body: string | null
  href: string | null
  readAt: string | null
  createdAt: string
}

export function NotificationBell({ unreadCount }: { unreadCount: number }) {
  const router = useRouter()
  const [items, setItems] = useState<Notification[] | null>(null)
  const [count, setCount] = useState(unreadCount)
  // Server re-renders (e.g. after /notifications marks rows read) must win over
  // the stale client copy. Reconcile during render — the React-blessed
  // alternative to a setState-in-effect, which triggers cascading renders.
  const [syncedCount, setSyncedCount] = useState(unreadCount)
  if (syncedCount !== unreadCount) {
    setSyncedCount(unreadCount)
    setCount(unreadCount)
  }
  const [loading, setLoading] = useState(false)

  const load = async (open: boolean) => {
    if (!open || items) return
    setLoading(true)
    const res = await fetch('/api/notifications')
    if (res.ok) setItems((await res.json()).notifications)
    setLoading(false)
  }

  const markAllRead = async () => {
    await fetch('/api/notifications', { method: 'POST' })
    setCount(0)
    setItems((prev) => prev?.map((n) => ({ ...n, readAt: new Date().toISOString() })) ?? null)
    router.refresh()
  }

  return (
    <Popover onOpenChange={load}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={`Notifications${count ? `, ${count} unread` : ''}`} className="relative">
            <Bell className="size-4" />
            {count > 0 && (
              <span className="bg-brand text-primary-foreground absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full text-[0.6rem] font-medium">
                {count > 9 ? '9+' : count}
              </span>
            )}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Notifications</span>
          {count > 0 && (
            <button onClick={markAllRead} className="text-muted-foreground hover:text-foreground text-xs">
              Mark all read
            </button>
          )}
        </div>

        <ScrollArea className="max-h-80">
          {loading && (
            <div className="text-muted-foreground flex items-center gap-2 px-3 py-6 text-sm">
              <Loader2 className="size-3.5 animate-spin" /> Loading…
            </div>
          )}

          {!loading && items?.length === 0 && (
            <p className="text-muted-foreground px-3 py-8 text-center text-sm">You&apos;re all caught up.</p>
          )}

          <ul className="divide-y">
            {items?.map((n) => {
              const content = (
                <div className="px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    {!n.readAt && <span className="bg-brand mt-1.5 size-1.5 shrink-0 rounded-full" />}
                    <div className={n.readAt ? 'pl-3.5' : ''}>
                      <p className="text-sm leading-snug font-medium">{n.title}</p>
                      {n.body && <p className="text-muted-foreground mt-0.5 text-xs leading-snug">{n.body}</p>}
                      <p className="text-muted-foreground mt-1 text-[0.7rem]">{relativeTime(n.createdAt)}</p>
                    </div>
                  </div>
                </div>
              )
              return (
                <li key={n.id} className="hover:bg-muted/60 transition-colors">
                  {n.href ? <Link href={n.href}>{content}</Link> : content}
                </li>
              )
            })}
          </ul>
        </ScrollArea>

        <div className="border-t px-3 py-2">
          <Link href="/notifications" className="text-muted-foreground hover:text-foreground block text-center text-xs font-medium">
            View all notifications
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  )
}
