import type { JSX } from 'react'
import type { SessionUser } from '@/lib/rbac'
import { countUnreadMessages, listThreads, loadThread, type ThreadVM } from '@/lib/call-center/messages'
import { parseThreadKey } from '@/lib/call-center/messages-core'
import { MessagesView } from './messages-view'

/**
 * Messages, the dialer's text inbox (docs/DIALER_APP.md §4, lane C). Lane A
 * renders it under `/call-center?s=messages`; `base` is that URL and every
 * link built here keeps it. `?t=lead:<id>` / `?t=client:<id>` opens a thread,
 * `?q=` pre-fills the search.
 */
export async function MessagesSection(props: {
  user: SessionUser
  params: Record<string, string | string[] | undefined>
  base: string
}): Promise<JSX.Element> {
  const { user, params, base } = props
  const now = new Date()
  const key = parseThreadKey(params.t)
  const [threads, thread] = await Promise.all([
    listThreads(user, now),
    key ? loadThread(user, key) : Promise.resolve<ThreadVM | null>(null),
  ])
  const q = Array.isArray(params.q) ? params.q[0] : params.q
  return (
    <MessagesView
      base={base}
      threads={threads}
      thread={thread}
      missing={Boolean(key && !thread)}
      initialQuery={typeof q === 'string' ? q.slice(0, 80) : ''}
      nowIso={now.toISOString()}
    />
  )
}

/** Unread inbound texts, for the Messages tab badge. Never throws. */
export async function unreadMessageCount(user: SessionUser): Promise<number> {
  return countUnreadMessages(user)
}
