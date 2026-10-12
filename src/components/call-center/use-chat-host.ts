'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { chatHref, onChatState, onChatTitle, onChatUnread, emitChatGo, parseChatUrl, titleWithCount, type ChatState } from './messages/chat/host-bus'

/**
 * The Call Center shell's side of the Team chat (docs/TEAM_CHAT_PARITY.md A2,
 * A3, F2): one Messages badge, the "(n) " title prefix, the conversation name
 * for the phone top bar, and notification taps routed in place.
 *
 * One source of truth per count, once hydrated:
 *  - team: the chat's own `unread` socket events while the chat is on screen
 *    with its socket up; otherwise the server render (the 20 s refresh) or
 *    this hook's poll, whichever came last.
 *  - sms: the server render or the poll, whichever came last.
 * The poll (GET /api/chat/unread) runs every 45 s while the tab is visible,
 * only when no other source has spoken for 40 s and the chat isn't live.
 */

export const UNREAD_POLL_MS = 45_000
const FRESH_MS = 40_000

type Counts = { team: number; sms: number; mentions: number }

export function useChatHost({ sms, team, onMessages }: { sms: number; team: number; onMessages: boolean }) {
  const router = useRouter()
  const [counts, setCounts] = useState<Counts>({ team, sms, mentions: 0 })
  const [chatTitle, setChatTitle] = useState<string | null>(null)
  const chat = useRef<ChatState>({ mounted: false, live: false })
  /** The same, as state, for the render below. */
  const [chatLive, setChatLive] = useState(false)
  const heard = useRef(0)

  // A fresh server render (navigation or the 20 s refresh) brings both counts. The team count is the chat's own
  // while it is live, so a refresh that started before a read can't bring an old number back.
  const serverKey = `${sms}|${team}`
  const [serverSeen, setServerSeen] = useState(serverKey)
  if (serverKey !== serverSeen) {
    setServerSeen(serverKey)
    setCounts((c) => ({ ...c, sms, team: chatLive ? c.team : team }))
  }

  useEffect(() => {
    heard.current = Date.now()
  }, [serverKey])

  useEffect(() => {
    const offUnread = onChatUnread((u) => {
      heard.current = Date.now()
      setCounts((c) => ({ ...c, team: Math.max(0, Math.floor(u.total) || 0), mentions: u.mentions == null ? c.mentions : Math.max(0, Math.floor(u.mentions) || 0) }))
    })
    const offState = onChatState((s) => {
      chat.current = s
      setChatLive(s.mounted && s.live)
    })
    const offTitle = onChatTitle(({ text }) => setChatTitle(text ? text.slice(0, 80) : null))
    return () => {
      offUnread()
      offState()
      offTitle()
    }
  }, [])

  // The lightweight poll for when the chat isn't on screen (or its socket is down).
  useEffect(() => {
    let stop = false
    const tick = async () => {
      if (stop || document.visibilityState !== 'visible') return
      if (chat.current.mounted && chat.current.live) return
      if (Date.now() - heard.current < FRESH_MS) return
      try {
        const res = await fetch('/api/chat/unread', { cache: 'no-store', credentials: 'same-origin' })
        if (!res.ok) return
        const data = (await res.json()) as { team?: unknown; sms?: unknown; mentions?: unknown }
        if (stop) return
        heard.current = Date.now()
        const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0)
        setCounts((c) => ({ sms: n(data.sms), team: chat.current.mounted && chat.current.live ? c.team : n(data.team), mentions: n(data.mentions) }))
      } catch {
        // Offline: the badge keeps its last number.
      }
    }
    const id = window.setInterval(() => void tick(), UNREAD_POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stop = true
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const total = counts.team + counts.sms

  // "(n) Call Center": Next rewrites the title on navigation and refresh, so it is put back when the <title> changes.
  useEffect(() => {
    const apply = () => {
      const next = titleWithCount(document.title, total)
      if (document.title !== next) document.title = next
    }
    apply()
    // The head, not the <title> itself: Next may swap the element rather than edit it.
    const obs = new MutationObserver(apply)
    obs.observe(document.head, { childList: true, characterData: true, subtree: true })
    return () => {
      obs.disconnect()
      document.title = titleWithCount(document.title, 0)
    }
  }, [total])

  // A tapped chat notification while ProdigyFlo is open (public/chat-sw.js): open the conversation in place, so a
  // live call is never dropped by a reload.
  const onMessagesRef = useRef(onMessages)
  useEffect(() => {
    onMessagesRef.current = onMessages
  }, [onMessages])
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data as { pfChatGo?: unknown; url?: unknown } | null
      if (!d || d.pfChatGo !== 1) return
      const go = parseChatUrl(String(d.url ?? ''), window.location.origin)
      const onTeam = onMessagesRef.current && !/[?&](view=sms|t=|q=)/.test(window.location.search)
      if (go && onTeam && chat.current.mounted) {
        const url = new URL(window.location.href)
        url.hash = chatHref(go).split('#')[1] ?? ''
        window.history.replaceState(window.history.state, '', url)
        emitChatGo(go)
      } else {
        router.push(go ? chatHref(go) : '/call-center?s=messages')
      }
    }
    navigator.serviceWorker.addEventListener('message', onMsg)
    return () => navigator.serviceWorker.removeEventListener('message', onMsg)
  }, [router])

  return { team: counts.team, sms: counts.sms, mentions: counts.mentions, total, chatTitle: onMessages ? chatTitle : null }
}
