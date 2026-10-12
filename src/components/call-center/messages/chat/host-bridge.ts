'use client'

import { useEffect, useRef } from 'react'
import type { ChatApi } from './api'
import { caseChannelFor, emitChatState, emitChatTitle, emitChatUnread, onChatGo, parseChatHash, type ChatGo } from './host-bus'
import { hostStrings } from './host-strings'
import type { Channel, Lang, Message } from './types'

/**
 * The Team chat's half of the shell seam (./host-bus.ts; docs/TEAM_CHAT_PARITY.md
 * A2, A3, A5). One hook, called once from ChatApp, so team-chat.tsx only
 * carries the call:
 *  - tells the shell the chat is on screen and whether its socket is live,
 *    the Worker's unread counts (first load, then every `unread` event), and
 *    the open conversation's name;
 *  - opens deep links: `#c=` / `#case=<lead>` (a lead's case chat, found in
 *    the channel list by `case.lead_id = pf:<lead>`), `#thread=` (the thread
 *    drawer) and `#m=` (scrolls to the message and flashes it), from the URL
 *    on load, from `hashchange`, and from the shell's `pfchat:go` (push taps).
 */

type Pane = { list: Message[]; hasMore: boolean; loaded: boolean }

export type HostBridgeInput = {
  api: ChatApi
  lang: Lang
  ready: boolean
  live: boolean
  channels: Channel[]
  panes: Record<string, Pane | undefined>
  active: string | null
  activeLabel: string | null
  /** Open a conversation without adding a history entry. */
  openChannel: (id: string) => void
  openThread: (root: Message) => void
  loadOlder: (channel: string) => Promise<void>
  toast: (msg: string) => void
}

export function useHostBridge(input: HostBridgeInput): void {
  const ref = useRef(input)
  useEffect(() => {
    ref.current = input
  })
  const { api, ready, live, active, activeLabel, panes } = input

  // On screen, and live or not.
  useEffect(() => {
    emitChatState({ mounted: true, live: ready && live })
  }, [ready, live])
  useEffect(() => () => emitChatState({ mounted: false, live: false }), [])

  // The open conversation names the phone's top bar.
  useEffect(() => {
    emitChatTitle(activeLabel)
  }, [activeLabel])
  useEffect(() => () => emitChatTitle(null), [])

  // Counts: once on load (GET /api/me carries them), then the socket's `unread` events.
  useEffect(() => {
    if (!ready) return
    let live = true
    void api
      .req<{ unread_total?: number; mentions?: number }>('GET', '/api/me')
      .then((r) => {
        if (live) emitChatUnread({ total: Number(r.unread_total) || 0, mentions: Number(r.mentions) || 0 })
      })
      .catch(() => undefined)
    const off = api.on((ev) => {
      if (ev.t === 'unread') emitChatUnread({ total: Number(ev.total) || 0, mentions: Number(ev.mentions) || 0 })
    })
    return () => {
      live = false
      off()
    }
  }, [api, ready])

  // Deep links. A go waits here until the list has loaded; a message or thread waits for its pane.
  const pending = useRef<ChatGo | null>(null)
  const tries = useRef(0)

  const apply = useRef((go: ChatGo | null) => {
    if (!go) return
    pending.current = go
    tries.current = 0
    resolve()
  })

  function resolve() {
    const go = pending.current
    const cur = ref.current
    if (!go || !cur.ready) return
    let channel = go.channel ? cur.channels.find((c) => c.id === go.channel) ?? null : null
    if (!channel && go.lead) channel = caseChannelFor(cur.channels, go.lead)
    if (!channel) {
      pending.current = null
      cur.toast(go.lead ? hostStrings(cur.lang).noCaseChat : hostStrings(cur.lang).noChannel)
      return
    }
    if (cur.active !== channel.id) {
      // Keep the go (now by channel id) for the pane effect below.
      pending.current = { ...go, channel: channel.id, lead: null }
      cur.openChannel(channel.id)
      return
    }
    focus(channel.id)
  }

  function focus(channelId: string) {
    const go = pending.current
    const cur = ref.current
    if (!go) return
    const pane = cur.panes[channelId]
    if (!pane?.loaded) return
    if (go.thread) {
      const root = pane.list.find((m) => m.id === go.thread)
      if (root) cur.openThread(root)
      else void loadRoot(cur.api, channelId, go.thread).then((m) => (m ? ref.current.openThread(m) : undefined))
    }
    const target = go.message
    if (!target) {
      pending.current = null
      return
    }
    const index = pane.list.findIndex((m) => m.id === target)
    if (index < 0) {
      // Older than the first page: walk back a few pages, then give up quietly.
      if (pane.hasMore && tries.current < 5) {
        tries.current++
        void cur.loadOlder(channelId).catch(() => undefined)
      } else pending.current = null
      return
    }
    pending.current = null
    // After the conversation has stuck itself to the bottom.
    window.setTimeout(() => highlightMessage(target, index), 200)
  }

  // The URL on first load, and later hash changes.
  useEffect(() => {
    if (!ready) return
    apply.current(parseChatHash(window.location.hash))
    const onHash = () => apply.current(parseChatHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    const off = onChatGo((go) => apply.current(go))
    return () => {
      window.removeEventListener('hashchange', onHash)
      off()
    }
  }, [ready])

  // A pending message / thread once its conversation's pane has loaded (or grown).
  useEffect(() => {
    if (pending.current && active && pending.current.channel === active) focus(active)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, active ? panes[active] : null])
}

async function loadRoot(api: ChatApi, channel: string, root: string): Promise<Message | null> {
  try {
    const r = await api.req<{ messages: Message[] }>('GET', `/api/channels/${channel}/messages?thread=${encodeURIComponent(root)}&limit=100`)
    return r.messages.find((m) => m.id === root) ?? null
  } catch {
    return null
  }
}

/**
 * Scrolls a message into view and flashes it. Every message element carries
 * `data-id` (conversation.tsx, the one id convention, also used by the search
 * jumps in team-chat.tsx); only the conversation's own list is searched, not the
 * thread drawer, which repeats its root. Falls back to the n-th message.
 */
export function highlightMessage(id: string, index: number): boolean {
  const main = document.querySelector('.chat-main .chat-conv') ?? document
  const scroll = Array.from(main.querySelectorAll<HTMLElement>('.chat-scroll')).find((s) => !s.closest('.chat-threadpane'))
  let el = scroll?.querySelector<HTMLElement>(`article.chat-msg[data-id="${CSS.escape(id)}"]`) ?? null
  if (!el) el = scroll ? (scroll.querySelectorAll<HTMLElement>('article.chat-msg')[index] ?? null) : null
  if (!el) return false
  el.scrollIntoView({ block: 'center' })
  el.classList.add('chat-hl')
  window.setTimeout(() => el?.classList.remove('chat-hl'), 2600)
  return true
}
