import 'server-only'
import { cache } from 'react'
import type { SessionUser } from '@/lib/rbac'
import { chatBase, chatKey } from './config'
import { linkedSunoffId } from './link'
import { signedHeaders } from './sign'

/**
 * ProdigyFlo → chat Worker calls, both signed with PF_CHAT_KEY and both
 * best-effort: the chat also pulls on its own every few minutes, and a badge
 * that can't load shows nothing rather than an error.
 */

const TIMEOUT_MS = 2500

async function signedFetch(method: 'GET' | 'POST', path: string, body = ''): Promise<Response | null> {
  const key = chatKey()
  if (!key) return null
  const url = chatBase() + path
  try {
    return await fetch(url, {
      method,
      headers: signedHeaders(key, method, url, body),
      body: body || undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return null
  }
}

/** Tell the chat to pull the case feed now (an inbound text, a reassignment). Never throws. */
export async function pingChatCases(leadIds: string[] = []): Promise<boolean> {
  const res = await signedFetch('POST', '/api/internal/pf/case-ping', JSON.stringify({ leads: leadIds.slice(0, 50) }))
  return Boolean(res?.ok)
}

export type TeamChatCounts = { total: number; mentions: number; cases: Record<string, number> }
const NONE: TeamChatCounts = { total: 0, mentions: 0, cases: {} }
const CASE_MAX = 200

const count = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 999) : 0
}

/**
 * The Worker's badge answer → counts. `cases` is per-case unread keyed by the
 * ProdigyFlo lead id (sunoff-chat docs/CHAT_CONTRACT.md §14: n > 0 only, at
 * most 200); anything that isn't a lead id or a positive count is dropped.
 */
export function parseUnreadAnswer(data: unknown): TeamChatCounts {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...NONE, cases: {} }
  const d = data as { unread_total?: unknown; mentions?: unknown; cases?: unknown }
  const cases: Record<string, number> = {}
  if (d.cases && typeof d.cases === 'object' && !Array.isArray(d.cases)) {
    for (const [lead, n] of Object.entries(d.cases as Record<string, unknown>)) {
      if (Object.keys(cases).length >= CASE_MAX) break
      const c = count(n)
      if (c > 0 && /^[A-Za-z0-9_:.-]{1,120}$/.test(lead)) cases[lead] = c
    }
  }
  return { total: count(d.unread_total), mentions: count(d.mentions), cases }
}

/**
 * Unread team-chat messages, @mentions and per-lead case-chat unread, in one signed call (one per page load or
 * poll, never per lead row). Zeros when unlinked, never opened, or the chat is unreachable; never throws.
 */
export async function teamChatCounts(user: SessionUser): Promise<TeamChatCounts> {
  const sunoffId = await linkedSunoffId(user).catch(() => null)
  if (!sunoffId) return { ...NONE, cases: {} }
  const res = await signedFetch('GET', `/api/internal/pf/unread?uid=u${sunoffId}`)
  if (!res?.ok) return { ...NONE, cases: {} }
  return parseUnreadAnswer(await res.json().catch(() => null))
}

/**
 * The same answer, asked once per server render: the page streams it to the
 * shell badge and the Messages switch reuses it (`cache` is keyed by the
 * request's SessionUser). Never rejects.
 */
export const teamChatCountsOnce = cache(
  (user: SessionUser): Promise<TeamChatCounts> => teamChatCounts(user).catch(() => ({ ...NONE, cases: {} })),
)

/** Unread team-chat messages for the shell badge. 0 when unlinked, never opened, or the chat is unreachable. */
export async function teamChatUnread(user: SessionUser): Promise<number> {
  return (await teamChatCounts(user)).total
}
