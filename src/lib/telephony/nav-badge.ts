import 'server-only'
import { cache } from 'react'
import type { NavSection } from '@/lib/navigation'
import type { SessionUser } from '@/lib/rbac'
import { pendingMissedCount } from './voice-calls'

/**
 * Missed calls still waiting for this viewer, counted once per request
 * (React cache, keyed on the request's session user) however many places
 * render it.
 */
export const missedCountForRequest = cache((user: SessionUser): Promise<number> => pendingMissedCount(user))

/**
 * The count badges on the nav rail. Today only the Call Center item has one.
 * Skipped entirely when the viewer can't see the Call Center item. Never
 * throws (pendingMissedCount reads a failure as zero).
 */
export async function navBadgesFor(user: SessionUser, sections: NavSection[]): Promise<Record<string, number>> {
  const showsCallCenter = sections.some((s) => s.items.some((i) => i.href === '/call-center'))
  if (!showsCallCenter) return {}
  const missed = await missedCountForRequest(user)
  return missed > 0 ? { '/call-center': missed } : {}
}
