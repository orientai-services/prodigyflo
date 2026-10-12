import type { JSX } from 'react'
import Link from 'next/link'
import type { SessionUser } from '@/lib/rbac'
import { messagesHref } from '@/lib/call-center/messages-core'
import { chatKey } from '@/lib/chat-bridge/config'
import { linkedSunoffId } from '@/lib/chat-bridge/link'
import { TeamChat } from './team-chat-lazy'
import './chat.css'

/**
 * The Messages section's switch, "Team chat" | "Leads (SMS)", and the Team
 * chat slot (docs/CYS_BRIDGE.md §B4). Team chat is the default; `?view=sms`
 * picks the lead text inbox. Server-rendered, so the screen never reads env.
 */
export function MessagesSwitch({ base, view, teamUnread, smsUnread }: { base: string; view: 'sms' | 'team'; teamUnread: number; smsUnread: number }): JSX.Element {
  return (
    <nav className="chat-switch" aria-label="Messages view">
      <Link href={messagesHref(base, { view: null, t: null, q: null })} aria-current={view === 'team' ? 'page' : undefined} className={view === 'team' ? 'on' : ''} scroll={false}>
        Team chat
        <Badge n={teamUnread} />
      </Link>
      <Link href={messagesHref(base, { view: 'sms', t: null })} aria-current={view === 'sms' ? 'page' : undefined} className={view === 'sms' ? 'on' : ''} scroll={false}>
        Leads (SMS)
        <Badge n={smsUnread} />
      </Link>
    </nav>
  )
}

function Badge({ n }: { n: number }): JSX.Element | null {
  return n > 0 ? <span className="chat-badge" aria-label={`${n} unread`}>{n > 99 ? '99+' : n}</span> : null
}

export async function TeamChatSection({ user }: { user: SessionUser }): Promise<JSX.Element> {
  const linked = Boolean(await linkedSunoffId(user))
  return <TeamChat configured={Boolean(chatKey())} linked={linked} initialLang="en" />
}
