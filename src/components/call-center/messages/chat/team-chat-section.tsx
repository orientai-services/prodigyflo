import type { JSX } from 'react'
import Link from 'next/link'
import type { SessionUser } from '@/lib/rbac'
import { messagesHref } from '@/lib/call-center/messages-core'
import { chatKey } from '@/lib/chat-bridge/config'
import { linkedSunoffId } from '@/lib/chat-bridge/link'
import { TeamChat } from './team-chat'
import './chat.css'

/**
 * The Messages section's switch, "Leads (SMS)" | "Team chat", and the Team
 * chat slot (docs/CYS_BRIDGE.md §B4). `?view=team` picks the team chat; the
 * SMS inbox stays the default. Server-rendered, so the screen never reads env.
 */
export function MessagesSwitch({ base, view, teamUnread }: { base: string; view: 'sms' | 'team'; teamUnread: number }): JSX.Element {
  return (
    <nav className="chat-switch" aria-label="Messages view">
      <Link href={messagesHref(base, { view: null, t: null })} aria-current={view === 'sms' ? 'page' : undefined} className={view === 'sms' ? 'on' : ''} scroll={false}>
        Leads (SMS)
      </Link>
      <Link href={messagesHref(base, { view: 'team', t: null, q: null })} aria-current={view === 'team' ? 'page' : undefined} className={view === 'team' ? 'on' : ''} scroll={false}>
        Team chat
        {teamUnread > 0 ? <span className="chat-badge" aria-label={`${teamUnread} unread`}>{teamUnread > 99 ? '99+' : teamUnread}</span> : null}
      </Link>
    </nav>
  )
}

export async function TeamChatSection({ user }: { user: SessionUser }): Promise<JSX.Element> {
  const linked = Boolean(await linkedSunoffId(user))
  return <TeamChat configured={Boolean(chatKey())} linked={linked} initialLang="en" />
}
