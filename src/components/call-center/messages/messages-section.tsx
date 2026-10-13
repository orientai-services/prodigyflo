import { Suspense, type JSX } from 'react'
import type { SessionUser } from '@/lib/rbac'
import { countUnreadMessages, listThreads, loadThread, type ThreadVM } from '@/lib/call-center/messages'
import { messagesHref, parseThreadKey } from '@/lib/call-center/messages-core'
import { MessagesView } from './messages-view'
import { teamChatCountsOnce, teamChatUnread as teamUnreadFor } from '@/lib/chat-bridge/remote'
import { Badge, MessagesSwitch, TeamChatSection } from './chat/team-chat-section'

/**
 * Messages, the dialer's text inbox (docs/DIALER_APP.md §4, lane C). Lane A
 * renders it under `/call-center?s=messages`; `base` is that URL and every
 * link built here keeps it. `?t=lead:<id>` / `?t=client:<id>` opens a thread,
 * `?q=` pre-fills the search. The team chat (docs/CYS_BRIDGE.md §B4, ./chat/)
 * is what Messages opens on; `?view=sms`, or any `?t=` / `?q=`, shows the lead
 * text inbox instead, and every link the inbox builds keeps `view=sms`.
 */
export async function MessagesSection(props: {
  user: SessionUser
  params: Record<string, string | string[] | undefined>
  base: string
}): Promise<JSX.Element> {
  const { user, params, base } = props
  const view = messagesView(params)
  if (view === 'team') {
    const smsUnread = await countUnreadMessages(user).catch(() => 0)
    return (
      <>
        <MessagesSwitch base={base} view="team" teamUnread={0} smsUnread={smsUnread} />
        <TeamChatSection user={user} />
      </>
    )
  }
  const smsBase = messagesHref(base, { view: 'sms' })
  const now = new Date()
  const key = parseThreadKey(params.t)
  const [threads, thread] = await Promise.all([
    listThreads(user, now),
    key ? loadThread(user, key) : Promise.resolve<ThreadVM | null>(null),
  ])
  const q = Array.isArray(params.q) ? params.q[0] : params.q
  // The Team chat badge comes from the chat Worker: it streams in rather than holding the inbox up, and shares
  // the page's one chat call for this render (teamChatCountsOnce).
  const teamBadge = (
    <Suspense fallback={null}>
      <TeamUnreadBadge counts={teamChatCountsOnce(user)} />
    </Suspense>
  )
  return (
    <>
      <MessagesSwitch base={base} view="sms" teamUnread={0} teamBadge={teamBadge} smsUnread={0} />
      <MessagesView
        base={smsBase}
        threads={threads}
        thread={thread}
        missing={Boolean(key && !thread)}
        initialQuery={typeof q === 'string' ? q.slice(0, 80) : ''}
        nowIso={now.toISOString()}
      />
    </>
  )
}

async function TeamUnreadBadge({ counts }: { counts: ReturnType<typeof teamChatCountsOnce> }): Promise<JSX.Element | null> {
  return <Badge n={(await counts).total} />
}

/** Team chat first; the SMS inbox only when asked for or when a thread / search is in the URL. */
export function messagesView(params: Record<string, string | string[] | undefined>): 'team' | 'sms' {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
  const view = one(params.view)
  if (view === 'team') return 'team'
  if (view === 'sms' || one(params.t) || one(params.q)) return 'sms'
  return 'team'
}

/** Unread team-chat messages, for the shell badge next to the SMS one. 0 when unlinked; never throws. */
export async function teamChatUnread(user: SessionUser): Promise<number> {
  return teamUnreadFor(user)
}

/** Unread inbound texts, for the Messages tab badge. Never throws. */
export async function unreadMessageCount(user: SessionUser): Promise<number> {
  return countUnreadMessages(user)
}
