import 'server-only'
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

/** Unread team-chat messages and @mentions for the shell badge. Zeros when unlinked, never opened, or the chat is unreachable. */
export async function teamChatCounts(user: SessionUser): Promise<{ total: number; mentions: number }> {
  const sunoffId = await linkedSunoffId(user)
  if (!sunoffId) return { total: 0, mentions: 0 }
  const res = await signedFetch('GET', `/api/internal/pf/unread?uid=u${sunoffId}`)
  if (!res?.ok) return { total: 0, mentions: 0 }
  const data = (await res.json().catch(() => null)) as { unread_total?: unknown; mentions?: unknown } | null
  const count = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 999) : 0
  }
  return { total: count(data?.unread_total), mentions: count(data?.mentions) }
}

/** Unread team-chat messages for the shell badge. 0 when unlinked, never opened, or the chat is unreachable. */
export async function teamChatUnread(user: SessionUser): Promise<number> {
  return (await teamChatCounts(user)).total
}
