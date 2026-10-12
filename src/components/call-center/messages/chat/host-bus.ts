/**
 * The seam between the Team chat (./team-chat.tsx) and the Call Center shell
 * that hosts it (docs/TEAM_CHAT_PARITY.md A2–A5, F2). The SunOff dialer does
 * the same over postMessage with an iframe; ProdigyFlo's chat is native, so
 * the two sides talk through window events instead:
 *
 *   chat → shell  `pfchat:unread` {total, mentions}   the Worker's own counts
 *                 `pfchat:state`  {mounted, live}     the chat is on screen / its socket is up
 *                 `pfchat:title`  {text}              the open conversation's name (null = none)
 *   shell → chat  `pfchat:go`     ChatGo              open a conversation (push tap, deep link)
 *
 * Deep links live in the hash so they never reach a server log:
 *   #c=<channel>[&m=<message>][&thread=<root>]   a conversation, a message, a thread
 *   #case=<PF lead id>                            that lead's case chat (resolved from the channel list)
 *
 * Pure apart from the window calls, so the parsing is unit-tested.
 */

export const CHAT_UNREAD_EVENT = 'pfchat:unread'
export const CHAT_STATE_EVENT = 'pfchat:state'
export const CHAT_TITLE_EVENT = 'pfchat:title'
export const CHAT_GO_EVENT = 'pfchat:go'

export type ChatGo = { channel: string | null; message: string | null; thread: string | null; lead: string | null }
export type ChatUnread = { total: number; mentions: number | null }
export type ChatState = { mounted: boolean; live: boolean }

/** Chat Worker ids (channels `c_…`, messages `m_…`): the dialer accepts the same alphabet. */
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/
/** ProdigyFlo desk lead ids, e.g. `meta:<org>:<leadgen>` (same rule as the case feed). */
export const LEAD_ID_RE = /^[A-Za-z0-9_:.-]{1,120}$/

function decode(v: string): string {
  try {
    return decodeURIComponent(v)
  } catch {
    return ''
  }
}

/** `#c=…&m=…&thread=…` / `#case=…` → what to open. Anything unrecognised reads as nothing. */
export function parseChatHash(hash: string | null | undefined): ChatGo | null {
  const raw = String(hash ?? '').replace(/^#/, '')
  if (!raw) return null
  const p = new URLSearchParams(raw)
  const pick = (k: string) => {
    const v = decode(p.get(k) ?? '')
    return ID_RE.test(v) ? v : null
  }
  const lead = decode(p.get('case') ?? '')
  const go: ChatGo = { channel: pick('c'), message: pick('m'), thread: pick('thread'), lead: LEAD_ID_RE.test(lead) ? lead : null }
  return go.channel || go.lead ? go : null
}

/** A ProdigyFlo URL (push tap, email link) → what to open, only for our own origin's Call Center. */
export function parseChatUrl(url: string, origin: string): ChatGo | null {
  try {
    const u = new URL(url, origin)
    if (u.origin !== origin || u.pathname !== '/call-center') return null
    return parseChatHash(u.hash)
  } catch {
    return null
  }
}

/** The Messages link that opens a conversation (or a lead's case chat) in Team chat. */
export function chatHref(go: Partial<ChatGo>): string {
  const parts: string[] = []
  if (go.channel && ID_RE.test(go.channel)) parts.push(`c=${go.channel}`)
  if (go.message && ID_RE.test(go.message)) parts.push(`m=${go.message}`)
  if (go.thread && ID_RE.test(go.thread)) parts.push(`thread=${go.thread}`)
  if (!parts.length && go.lead && LEAD_ID_RE.test(go.lead)) parts.push(`case=${encodeURIComponent(go.lead)}`)
  return `/call-center?s=messages${parts.length ? `#${parts.join('&')}` : ''}`
}

/** The case channel of a ProdigyFlo lead: the Worker stores PF cases as `pf:<lead id>` (sunoff-chat src/pfcases.ts). */
export function caseChannelFor<C extends { id: string; case?: { lead_id: string } | null }>(channels: readonly C[], leadId: string): C | null {
  const key = `pf:${leadId}`
  return channels.find((c) => c.case?.lead_id === key) ?? null
}

/** "(3) Call Center" while anything is unread; the bare title otherwise. */
export function titleWithCount(title: string, n: number): string {
  const bare = title.replace(/^\(\d+\+?\)\s/, '')
  return n > 0 ? `(${n > 99 ? '99+' : n}) ${bare}` : bare
}

function emit<T>(name: string, detail: T): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<T>(name, { detail }))
}

function listen<T>(name: string, fn: (detail: T) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handler = (e: Event) => fn((e as CustomEvent<T>).detail)
  window.addEventListener(name, handler)
  return () => window.removeEventListener(name, handler)
}

export const emitChatUnread = (u: ChatUnread) => emit(CHAT_UNREAD_EVENT, u)
export const emitChatState = (s: ChatState) => emit(CHAT_STATE_EVENT, s)
export const emitChatTitle = (text: string | null) => emit(CHAT_TITLE_EVENT, { text })
export const emitChatGo = (go: ChatGo) => emit(CHAT_GO_EVENT, go)

export const onChatUnread = (fn: (u: ChatUnread) => void) => listen(CHAT_UNREAD_EVENT, fn)
export const onChatState = (fn: (s: ChatState) => void) => listen(CHAT_STATE_EVENT, fn)
export const onChatTitle = (fn: (t: { text: string | null }) => void) => listen(CHAT_TITLE_EVENT, fn)
export const onChatGo = (fn: (go: ChatGo) => void) => listen(CHAT_GO_EVENT, fn)
