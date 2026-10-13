'use client'

import Link from 'next/link'
import type { ReactNode, Ref } from 'react'
import { CalendarDays, Ellipsis, History, MessageSquare, Sun, Users, type LucideIcon } from 'lucide-react'
import { SECTION_TITLE, badgeText, sectionHref, type ShellRoute } from '@/lib/call-center/app-shell'

type SectionId = 'today' | 'messages' | 'leads' | 'booked' | 'history'

const TABS: { id: SectionId; icon: LucideIcon }[] = [
  { id: 'today', icon: Sun },
  { id: 'messages', icon: MessageSquare },
  { id: 'leads', icon: Users },
  { id: 'booked', icon: CalendarDays },
  { id: 'history', icon: History },
]

/**
 * The six sections: a bottom tab bar below 1024 px, a strip under the header
 * on a desk (the same element; CSS places it). More opens a sheet (phone) or
 * a popover (desk); Team and Campaigns live there, so More reads as the
 * current tab while either is open.
 */
export function SectionNav({
  route,
  badges,
  moreOpen,
  onMore,
  onNavigate,
  more,
  navRef,
}: {
  route: Pick<ShellRoute, 'section' | 'ads'>
  badges: { today: number; messages: number }
  moreOpen: boolean
  onMore: () => void
  /** A tab to another section was tapped (before it navigates): remember the scroll, show its skeleton. */
  onNavigate?: (id: SectionId) => void
  /** The More sheet, rendered beside its button. */
  more: ReactNode
  navRef?: Ref<HTMLElement>
}) {
  const inMore = route.section === 'team' || route.ads
  return (
    <nav ref={navRef} className="cc-tabs" aria-label="Dialer sections">
      {TABS.map(({ id, icon: Icon }) => {
        const here = route.section === id && !route.ads
        const badge = badgeText(id === 'today' ? badges.today : id === 'messages' ? badges.messages : 0)
        return (
          <Link
            key={id}
            href={sectionHref(id)}
            // Each section keeps its own scroll (use-native-shell.ts), so the link never jumps the page itself.
            scroll={false}
            className={here ? 'on' : undefined}
            aria-current={here ? 'page' : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              if (here) {
                // Tapping the open tab goes back to its top, like a native tab bar.
                event.preventDefault()
                window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
                return
              }
              onNavigate?.(id)
            }}
          >
            <span className="cc-tab-icon">
              <Icon aria-hidden="true" />
            </span>
            <span className="cc-tab-label">{SECTION_TITLE[id]}</span>
            {badge ? <span className="cc-badge" aria-hidden="true">{badge}</span> : null}
            {badge ? <span className="sr">{`, ${badge} ${id === 'messages' ? 'unread' : 'waiting'}`}</span> : null}
          </Link>
        )
      })}
      <span className="cc-more-anchor">
        <button
          type="button"
          className={inMore || moreOpen ? 'on' : undefined}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-current={inMore ? 'page' : undefined}
          data-more-toggle=""
          onClick={onMore}
        >
          <span className="cc-tab-icon">
            <Ellipsis aria-hidden="true" />
          </span>
          <span className="cc-tab-label">More</span>
        </button>
        {more}
      </span>
    </nav>
  )
}
