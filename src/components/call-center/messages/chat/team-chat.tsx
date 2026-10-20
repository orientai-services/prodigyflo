'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, useTransition } from 'react'
import { uiLocaleStore } from '@/lib/ui-locale'
import { linkSunoffAccount } from '@/lib/chat-bridge/actions'
import { ChatApi, ChatError, clientId } from './api'
import { ChannelSheet } from './channel-sheet'
import { ChatList, type Live } from './chat-list'
import { Conversation } from './conversation'
import { NO_FEATURES, channelLabel, chatFeatures, isCat, mostRecent, upsertMessage, type Cat } from './format'
import { useHostBridge } from './host-bridge'
import { RoomsSheet } from './rooms-sheet'
import { SettingsSheet } from './settings-sheet'
import { FlaggedSheet, NewChatSheet, PinsSheet, SearchSheet, type Goto } from './sheets'
import { strings, type T } from './strings'
import type { Channel, ChatEvent, Lang, Me, MeAnswer, MePrefs, Message, RoomsAnswer, VoiceDraft } from './types'
import { useEdgeSwipeBack } from '../../native/use-native-shell'
import './chat.css'

/** A phone's edge swipe presses the pane's own ‹ back (the innermost visible one: a thread's before its conversation's). */
function pressBack(pane: HTMLElement | null, selector: string) {
  const buttons = Array.from(pane?.querySelectorAll<HTMLElement>(selector) ?? []).filter((el) => el.offsetParent !== null)
  buttons.at(-1)?.click()
}

/**
 * ProdigyFlo's team chat (docs/CYS_BRIDGE.md §B4, owner decision D4): the one
 * SunOff team chat, drawn in the desk look and talking to the chat Worker
 * directly (REST + WebSocket). No message is stored in ProdigyFlo.
 */

type Props = { configured: boolean; linked: boolean; initialLang?: Lang | null }

export function TeamChat({ configured, linked, initialLang }: Props) {
  const lang=useSyncExternalStore(uiLocaleStore.subscribe,uiLocaleStore.get,()=>initialLang ?? 'en')
  const setLang=uiLocaleStore.set
  const [isLinked, setLinked] = useState(linked)
  const t = strings(lang)
  if (!configured) return <p className="chat-note">{t.notConfigured}</p>
  if (!isLinked) return <LinkCard t={t} onLinked={() => setLinked(true)} />
  return <ChatApp lang={lang} setLang={setLang} />
}

function LinkCard({ t, onLinked }: { t: T; onLinked: () => void }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <section className="chat-link" aria-labelledby="chat-link-h">
      <h2 id="chat-link-h">{t.linkTitle}</h2>
      <p>{t.linkBody}</p>
      <button
        type="button"
        className="chat-btn"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await linkSunoffAccount()
            if (res.ok) onLinked()
            else setError(res.error)
          })
        }
      >
        {pending ? t.linking : t.linkBtn}
      </button>
      {error ? <p className="chat-error" role="alert">{error}</p> : null}
    </section>
  )
}

// ── Store ───────────────────────────────────────────────────────────────────

type Pane = { list: Message[]; hasMore: boolean; reads: Record<string, string>; loaded: boolean }
type State = {
  me: Me | null
  channels: Channel[]
  panes: Record<string, Pane>
  thread: { channel: string; root: string; list: Message[] } | null
  typing: Record<string, Record<string, { name: string; at: number }>>
  online: Record<string, boolean>
  /** Who has read my last message per channel since the list loaded (`<channel>:<msg id>` → uids). */
  seenBy: Record<string, string[]>
}
type Action =
  | { type: 'me'; me: Me }
  | { type: 'channels'; list: Channel[] }
  | { type: 'channel'; channel: Channel }
  | { type: 'pane'; channel: string; pane: Partial<Pane>; prepend?: Message[] }
  | { type: 'msg'; channel: string; message: Message }
  | { type: 'patch'; channel: string; id: string; patch: Partial<Message> }
  | { type: 'drop'; channel: string; id: string }
  | { type: 'thread'; thread: State['thread'] }
  | { type: 'read'; channel: string; uid: string; msg_id: string; mine: boolean; meUid?: string }
  | { type: 'typing'; channel: string; uid: string; name: string }
  | { type: 'presence'; uid: string; online: boolean }
  | { type: 'bump'; channel: string; root: string; at: number }

const emptyPane: Pane = { list: [], hasMore: false, reads: {}, loaded: false }
/** A message the server has (optimistic and refused copies carry a local `m_~` id). */
const isServer = (m: Message) => !m.pending && !m.failed && !m.id.startsWith('m_~')

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'me':
      return { ...s, me: a.me }
    case 'channels':
      return { ...s, channels: a.list }
    case 'channel': {
      if (a.channel.removed) return { ...s, channels: s.channels.filter((c) => c.id !== a.channel.id) }
      const i = s.channels.findIndex((c) => c.id === a.channel.id)
      const list = i >= 0 ? s.channels.map((c) => (c.id === a.channel.id ? { ...c, ...a.channel } : c)) : [a.channel, ...s.channels]
      return { ...s, channels: list }
    }
    case 'pane': {
      const cur = s.panes[a.channel] ?? emptyPane
      const list = a.prepend ? [...a.prepend.filter((m) => !cur.list.some((x) => x.id === m.id)), ...cur.list] : a.pane.list ?? cur.list
      return { ...s, panes: { ...s.panes, [a.channel]: { ...cur, ...a.pane, list } } }
    }
    case 'msg': {
      const m = a.message
      let next = s
      if (m.parent_id) {
        if (s.thread && s.thread.root === m.parent_id) next = { ...next, thread: { ...s.thread, list: upsertMessage(s.thread.list, m) } }
      } else {
        const cur = s.panes[a.channel]
        if (cur) next = { ...next, panes: { ...next.panes, [a.channel]: { ...cur, list: upsertMessage(cur.list, m) } } }
        next = {
          ...next,
          channels: next.channels.map((c) =>
            c.id === a.channel && !m.pending
              ? { ...c, last_msg: { id: m.id, uid: m.uid, name: m.name, body: m.body, at: m.created_at, att: m.attachments[0] ? (m.attachments[0].kind === 'voice' ? 'voice' : m.attachments[0].type.startsWith('image/') ? 'image' : 'file') : null, deleted: false, seen: 0 }, last_msg_at: m.created_at }
              : c,
          ),
        }
      }
      return next
    }
    case 'patch': {
      const fix = (list: Message[]) => list.map((m) => (m.id === a.id ? { ...m, ...a.patch } : m))
      const cur = s.panes[a.channel]
      return {
        ...s,
        panes: cur ? { ...s.panes, [a.channel]: { ...cur, list: fix(cur.list) } } : s.panes,
        thread: s.thread ? { ...s.thread, list: fix(s.thread.list) } : null,
      }
    }
    case 'drop': {
      const cur = s.panes[a.channel]
      const panes = cur ? { ...s.panes, [a.channel]: { ...cur, list: cur.list.filter((m) => m.id !== a.id) } } : s.panes
      return { ...s, panes, thread: s.thread ? { ...s.thread, list: s.thread.list.filter((m) => m.id !== a.id) } : null }
    }
    case 'thread':
      return { ...s, thread: a.thread }
    case 'read': {
      const cur = s.panes[a.channel]
      const panes = cur ? { ...s.panes, [a.channel]: { ...cur, reads: { ...cur.reads, [a.uid]: a.msg_id } } } : s.panes
      if (a.mine) {
        const channels = s.channels.map((c) => (c.id === a.channel ? { ...c, unread: 0, mentions: 0, last_read_msg_id: a.msg_id } : c))
        return { ...s, panes, channels }
      }
      // Someone else read up to my last message: one more ✓✓ reader on the list row (each person once).
      const ch = s.channels.find((c) => c.id === a.channel)
      const lm = ch?.last_msg
      if (!ch || !lm || lm.uid !== a.meUid || a.msg_id < lm.id) return { ...s, panes }
      const key = `${ch.id}:${lm.id}`
      const who = s.seenBy[key] ?? []
      if (who.includes(a.uid)) return { ...s, panes }
      return {
        ...s,
        panes,
        seenBy: { ...s.seenBy, [key]: [...who, a.uid] },
        channels: s.channels.map((c) => (c.id === ch.id && c.last_msg ? { ...c, last_msg: { ...c.last_msg, seen: (c.last_msg.seen ?? 0) + 1 } } : c)),
      }
    }
    case 'typing':
      return { ...s, typing: { ...s.typing, [a.channel]: { ...(s.typing[a.channel] ?? {}), [a.uid]: { name: a.name, at: Date.now() } } } }
    case 'presence':
      return { ...s, online: { ...s.online, [a.uid]: a.online } }
    case 'bump': {
      // A new reply: the root's count and "last reply" move (C6). The Worker also sends the root itself (an
      // `edit` with the absolute count and last_reply_at = the reply's time); when that came first, don't add again.
      const fix = (list: Message[]) =>
        list.map((m) => (m.id === a.root && (m.last_reply_at ?? 0) < a.at ? { ...m, reply_count: m.reply_count + 1, last_reply_at: a.at } : m))
      const cur = s.panes[a.channel]
      return { ...s, panes: cur ? { ...s.panes, [a.channel]: { ...cur, list: fix(cur.list) } } : s.panes, thread: s.thread ? { ...s.thread, list: fix(s.thread.list) } : null }
    }
  }
}

// ── App ─────────────────────────────────────────────────────────────────────

export type ChatActions = {
  send: (channel: string, body: string, o?: { parent?: string; attachments?: string[]; mentions?: string[]; sms?: boolean; retryOf?: Message; voice?: VoiceDraft }) => Promise<void>
  /** The conversation reports whether its list is scrolled to the bottom; reading only counts there (SunOff). */
  atBottom: (channel: string, bottom: boolean) => void
  edit: (m: Message, body: string) => Promise<void>
  remove: (m: Message) => Promise<void>
  react: (m: Message, emoji: string) => Promise<void>
  pin: (m: Message) => Promise<void>
  openThread: (m: Message | null) => void
  loadOlder: (channel: string) => Promise<void>
  upload: (channel: string, file: Blob, name: string, extra?: Record<string, string>) => Promise<string>
  typing: (channel: string) => void
  discard: (m: Message) => void
  toast: (msg: string) => void
}

type SheetState =
  | null
  | { k: 'search'; scoped: boolean; q: string }
  | { k: 'new' }
  | { k: 'add' }
  | { k: 'pins' }
  | { k: 'details' }
  | { k: 'rooms' }
  | { k: 'flagged' }
  | { k: 'settings' }

const DESK = '(min-width: 768px)'
const isDesk = () => typeof window !== 'undefined' && window.matchMedia(DESK).matches
const CAT_KEY = 'chat_cat'
const hashChannel = () => /#c=(c_[0-9a-z]{15})/.exec(window.location.hash)?.[1] ?? null

function ChatApp({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const t = strings(lang)
  const api = useMemo(() => new ChatApi(lang), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [s, dispatch] = useReducer(reducer, { me: null, channels: [], panes: {}, thread: null, typing: {}, online: {}, seenBy: {} })
  const [phase, setPhase] = useState<'loading' | 'ready' | 'not_linked' | 'error'>('loading')
  const [status, setStatus] = useState(api.status)
  const [net, setNet] = useState(true)
  const [active, setActive] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // The category I was in, remembered on this device (the list only renders it after sign-in, so no hydration gap).
  const [cat, setCatState] = useState<Cat | ''>(() => {
    try {
      const v = typeof window === 'undefined' ? null : window.localStorage.getItem(CAT_KEY)
      return isCat(v) ? v : ''
    } catch {
      return ''
    }
  })
  const [sheet, setSheet] = useState<SheetState>(null)
  const [rooms, setRooms] = useState<RoomsAnswer | null>(null)
  // SunOff-side tools (rooms, Announce, Sync now): off until GET /api/me turns them on; never on for ProdigyFlo.
  const [features, setFeatures] = useState(NO_FEATURES)
  const featuresRef = useRef(NO_FEATURES)
  const [syncing, setSyncing] = useState(false)
  const [toastMsg, setToast] = useState<string | null>(null)
  const [said, setSaid] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const roomsAt = useRef(0)
  // Socket handlers and actions read the newest state through these (they are set after every render).
  const stateRef = useRef(s)
  const activeRef = useRef(active)
  const tRef = useRef(t)
  useEffect(() => {
    stateRef.current = s
    activeRef.current = active
    tRef.current = t
  })

  // Replies already counted on their root (the socket echo and the send answer carry the same id).
  const seenReplies = useRef(new Set<string>())
  const bumpRoot = useCallback((m: Message) => {
    if (!m.parent_id || m.pending || m.failed || seenReplies.current.has(m.id)) return
    seenReplies.current.add(m.id)
    dispatch({ type: 'bump', channel: m.channel, root: m.parent_id, at: m.created_at })
  }, [])

  const toast = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000)
  }, [])
  /** The screen reader line (a new message, a jump): cleared first so the same words are read again. */
  const say = useCallback((msg: string) => {
    setSaid('')
    window.setTimeout(() => setSaid(msg), 30)
  }, [])

  const setCat = useCallback((c: Cat | '') => {
    setCatState(c)
    try {
      window.localStorage.setItem(CAT_KEY, c)
    } catch {
      // private mode: the choice holds for this visit
    }
  }, [])

  const loadChannels = useCallback(async () => {
    const list = await api.req<Channel[]>('GET', '/api/channels')
    dispatch({ type: 'channels', list })
    return list
  }, [api])

  const loadRooms = useCallback(async () => {
    roomsAt.current = Date.now()
    if (!featuresRef.current.rooms) return
    try {
      setRooms(await api.req<RoomsAnswer>('GET', '/api/rooms'))
    } catch {
      // rooms are optional: the footer button just stays hidden
    }
  }, [api])

  // Like SunOff, a conversation is read only while its list sits at the bottom and the tab is visible.
  const bottoms = useRef<Record<string, boolean>>({})
  const markRead = useCallback(
    async (channel: string) => {
      if (!bottoms.current[channel] || document.visibilityState !== 'visible') return
      const pane = stateRef.current.panes[channel]
      const last = pane?.list.filter(isServer).at(-1)
      const ch = stateRef.current.channels.find((c) => c.id === channel)
      if (!last || !ch || (ch.last_read_msg_id && ch.last_read_msg_id >= last.id && !ch.unread)) return
      dispatch({ type: 'read', channel, uid: stateRef.current.me?.uid ?? '', msg_id: last.id, mine: true })
      await api.req('POST', `/api/channels/${channel}/read`, { msg_id: last.id }).catch(() => undefined)
    },
    [api],
  )

  const loadPane = useCallback(
    async (channel: string) => {
      const r = await api.req<{ messages: Message[]; has_more: boolean; reads: Record<string, string> }>('GET', `/api/channels/${channel}/messages?limit=50`)
      dispatch({ type: 'pane', channel, pane: { list: r.messages, hasMore: r.has_more, reads: r.reads ?? {}, loaded: true } })
    },
    [api],
  )

  const open = useCallback((id: string | null, o: { replace?: boolean } = {}) => {
    setActive(id)
    dispatch({ type: 'thread', thread: null })
    const url = new URL(window.location.href)
    url.hash = id ? `c=${id}` : ''
    if (id && !o.replace) window.history.pushState({ chat: id }, '', url)
    else window.history.replaceState(id ? { chat: id } : {}, '', url)
  }, [])

  /**
   * Desktop shows a conversation at all times: the most recent one when nothing else is asked for (`skip`: one that
   * just went away). Phones show the list, so there it only closes what is open.
   */
  const openDefault = useCallback(
    (skip?: string, fresh?: Channel[]) => {
      if (!isDesk()) {
        if (activeRef.current) open(null)
        return
      }
      // `fresh`: a list just loaded, before stateRef catches up with the render (first open on sign-in).
      const c = mostRecent((fresh ?? stateRef.current.channels).filter((x) => x.id !== skip))
      open(c ? c.id : null, { replace: true })
    },
    [open],
  )

  const applyLang = useCallback(
    (l: Lang) => {
      setLang(l)
      api.setLang(l)
    },
    [api, setLang],
  )

  // Sign in, first load, socket.
  useEffect(() => {
    let live = true
    api.reopen()
    ;(async () => {
      try {
        const out = await api.signIn()
        if (!live) return
        if (!out.ok) {
          setPhase(out.error === 'not_linked' ? 'not_linked' : 'error')
          return
        }
        // GET /api/me carries the prefs (language, quiet hours) the screen starts from; the session's copy is the fallback.
        const meAns = await api.req<MeAnswer>('GET', '/api/me').catch(() => null)
        featuresRef.current = chatFeatures(meAns)
        setFeatures(featuresRef.current)
        const me = (meAns?.me ?? out.me) as Me | undefined
        if (me) {
          dispatch({ type: 'me', me })
          const l = me.prefs?.lang === 'en' || me.prefs?.lang === 'es' ? me.prefs.lang : me.lang
          // A stale chat-only preference must not override the signed-in account's language.
          const preferred=uiLocaleStore.get()
          api.setLang(preferred)
          if(l!==preferred)void api.req('POST','/api/me/prefs',{lang:preferred}).catch(()=>undefined)
        }
        const first = await loadChannels()
        if (!live) return
        setPhase('ready')
        void api.connect()
        void loadRooms()
        // #c= / #case= / #m= / #thread= links belong to the host bridge (./host-bridge.ts); otherwise the default.
        if (!/(^#|&)(c|case|m|thread)=/.test(window.location.hash)) openDefault(undefined, first)
      } catch {
        if (live) setPhase('error')
      }
    })()
    const offStatus = api.onStatus(setStatus)
    const offNet = api.onNet(setNet)
    return () => {
      live = false
      offStatus()
      offNet()
      api.close()
    }
  }, [api, loadChannels, loadRooms, openDefault, applyLang])

  useEffect(()=>{
    api.setLang(lang)
    if(phase==='ready')void api.req('POST','/api/me/prefs',{lang}).catch(()=>undefined)
  },[api,lang,phase])

  // The browser coming back online: catch up and reconnect now; going offline shows the banner.
  useEffect(() => {
    const onOnline = () => {
      setNet(true)
      api.retryNow()
      void loadChannels().catch(() => undefined)
    }
    const onOffline = () => setNet(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [api, loadChannels])

  // Growing from phone to desktop with nothing open: open the most recent conversation.
  useEffect(() => {
    if (phase !== 'ready') return
    const mq = window.matchMedia(DESK)
    const onChange = () => {
      if (mq.matches && !activeRef.current) openDefault()
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [phase, openDefault])

  // The open conversation went away (archived, I left, I was removed): say so and move on.
  const gone = useCallback(
    (id: string, announce: boolean) => {
      dispatch({ type: 'channel', channel: { id, removed: true } as Channel })
      if (activeRef.current !== id) return
      if (announce) toast(tRef.current.removedFrom)
      setSheet(null)
      window.setTimeout(() => openDefault(id), 0)
    },
    [openDefault, toast],
  )

  // Live events.
  useEffect(() => {
    let roomsT: ReturnType<typeof setTimeout> | null = null
    const off = api.on((ev: ChatEvent) => {
      const me = stateRef.current.me?.uid ?? ''
      switch (ev.t) {
        case 'msg':
          dispatch({ type: 'msg', channel: ev.channel, message: ev.message })
          bumpRoot({ ...ev.message, channel: ev.channel })
          if (ev.channel === activeRef.current && document.visibilityState === 'visible') {
            window.setTimeout(() => void markRead(ev.channel), 300)
            const known = stateRef.current.panes[ev.channel]?.list.some((m) => m.id === ev.message.id)
            if (ev.message.uid !== me && !known) say(tRef.current.newMsgFrom(ev.message.name, ev.message.body || '📎'))
          } else if (!stateRef.current.channels.some((c) => c.id === ev.channel)) void loadChannels()
          break
        case 'edit':
          dispatch({ type: 'patch', channel: ev.channel, id: ev.message.id, patch: ev.message })
          break
        case 'del':
          dispatch({ type: 'patch', channel: ev.channel, id: ev.id, patch: { deleted: true, body: '', attachments: [], reactions: {} } })
          break
        case 'react':
          dispatch({ type: 'patch', channel: ev.channel, id: ev.id, patch: { reactions: ev.reactions } })
          break
        case 'pin':
          dispatch({ type: 'patch', channel: ev.channel, id: ev.id, patch: { pinned: ev.pinned } })
          void loadChannels()
          break
        case 'read':
          dispatch({ type: 'read', channel: ev.channel, uid: ev.uid, msg_id: ev.msg_id, mine: ev.uid === me, meUid: me })
          break
        case 'typing':
          if (ev.uid !== me) dispatch({ type: 'typing', channel: ev.channel, uid: ev.uid, name: ev.name })
          break
        case 'presence':
          dispatch({ type: 'presence', uid: ev.uid, online: ev.online })
          break
        case 'channel':
          if (ev.channel?.removed) gone(ev.channel.id, true)
          else if (ev.channel && !ev.channel.refetch) {
            if (ev.channel.archived_at) gone(ev.channel.id, true)
            else dispatch({ type: 'channel', channel: ev.channel })
          } else void loadChannels()
          break
        case 'case':
        case 'unread':
          void loadChannels()
          break
        case 'rooms':
          if (roomsT) clearTimeout(roomsT)
          roomsT = setTimeout(() => void loadRooms(), 300)
          break
        case 'hello':
          // (Re)connected: whatever happened while the socket was down.
          void loadChannels().catch(() => undefined)
          break
      }
    })
    return () => {
      off()
      if (roomsT) clearTimeout(roomsT)
    }
  }, [api, loadChannels, loadRooms, markRead, say, gone, bumpRoot])

  // Socket down: poll the list (and the open conversation) every 5 s while the tab is visible; rooms every 30 s.
  useEffect(() => {
    if (phase !== 'ready' || status === 'live') return
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadChannels().catch(() => undefined)
      if (Date.now() - roomsAt.current > 30_000) void loadRooms()
      const ch = activeRef.current
      const last = ch ? stateRef.current.panes[ch]?.list.filter(isServer).at(-1) : undefined
      if (ch && last)
        void api
          .req<{ messages: Message[] }>('GET', `/api/channels/${ch}/messages?after=${last.id}&limit=50`)
          .then((r) => r.messages.forEach((m) => dispatch({ type: 'msg', channel: ch, message: m })))
          .catch(() => undefined)
    }, 5000)
    return () => window.clearInterval(id)
  }, [api, phase, status, loadChannels, loadRooms])

  // Back to the tab with the open conversation at its bottom: that counts as reading it.
  useEffect(() => {
    const onVis = () => {
      const ch = activeRef.current
      if (ch && document.visibilityState === 'visible') void markRead(ch)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [markRead])

  // Opening a conversation: load, focus (no push while I'm looking), mark read, keep it in the URL.
  useEffect(() => {
    if (!active || phase !== 'ready') return
    api.send({ t: 'focus', channel: active })
    void (async () => {
      if (!stateRef.current.panes[active]?.loaded) await loadPane(active).catch(() => toast(t.failed))
      await markRead(active)
    })()
    return () => {
      api.send({ t: 'focus', channel: null })
    }
  }, [active, phase, api, loadPane, markRead, toast, t.failed])

  // An open conversation that isn't (or is no longer) in my list: say so and fall back.
  useEffect(() => {
    if (phase !== 'ready' || !active || !s.me) return
    if (!s.channels.some((c) => c.id === active && !c.removed)) {
      const id = window.setTimeout(() => {
        if (activeRef.current !== active || stateRef.current.channels.some((c) => c.id === active)) return
        toast(t.notFound)
        openDefault(active)
      }, 1500)
      return () => window.clearTimeout(id)
    }
  }, [phase, active, s.channels, s.me, toast, t.notFound, openDefault])

  // Browser back closes the open conversation on phones.
  useEffect(() => {
    const onPop = () => {
      setActive(hashChannel())
      dispatch({ type: 'thread', thread: null })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Keyboard: Ctrl/⌘+K finds a conversation; Escape closes the thread (sheets close themselves).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (!isDesk() && activeRef.current) open(null)
        window.setTimeout(() => searchRef.current?.focus(), 0)
        return
      }
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return
      const target = e.target as HTMLElement | null
      if (target?.closest?.('textarea, input')) return
      if (stateRef.current.thread) {
        e.preventDefault()
        dispatch({ type: 'thread', thread: null })
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  /** Scroll a message into view and flash it. */
  const highlight = useCallback((id: string) => {
    let tries = 0
    const tryIt = () => {
      const el = document.querySelector<HTMLElement>(`.chat article.chat-msg[data-id="${CSS.escape(id)}"]`)
      if (!el) {
        if (++tries < 20) window.setTimeout(tryIt, 100)
        return
      }
      el.scrollIntoView({ block: 'center' })
      el.classList.remove('chat-hl')
      void el.offsetWidth
      el.classList.add('chat-hl')
      window.setTimeout(() => el.classList.remove('chat-hl'), 2400)
    }
    window.setTimeout(tryIt, 60)
  }, [])

  /** The window around one message, then forward to the newest so the conversation has no gap. */
  const loadAround = useCallback(
    async (channel: string, id: string) => {
      const r = await api.req<{ messages: Message[]; has_more: boolean; has_newer: boolean; reads: Record<string, string> }>('GET', `/api/channels/${channel}/messages?around=${id}&limit=50`)
      let list = r.messages
      let newer = r.has_newer
      for (let page = 0; newer && page < 6 && list.length; page++) {
        const n = await api.req<{ messages: Message[]; has_newer: boolean }>('GET', `/api/channels/${channel}/messages?after=${list[list.length - 1].id}&limit=50`)
        list = [...list, ...n.messages]
        newer = n.has_newer
      }
      dispatch({ type: 'pane', channel, pane: { list, hasMore: r.has_more, reads: r.reads ?? {}, loaded: true } })
    },
    [api],
  )

  const openThreadId = useCallback(
    (channel: string, root: string) => {
      dispatch({ type: 'thread', thread: { channel, root, list: [] } })
      void api
        .req<{ messages: Message[] }>('GET', `/api/channels/${channel}/messages?thread=${root}&limit=100`)
        .then((r) => dispatch({ type: 'thread', thread: { channel, root, list: r.messages } }))
        .catch(() => toast(tRef.current.msgNotFound))
    },
    [api, toast],
  )

  /** A search, pin or flag result: the message in its channel (scrolled to and flashed), or inside its thread. */
  const goto = useCallback(
    async (g: Goto) => {
      setSheet(null)
      try {
        if (g.parent) {
          if (activeRef.current !== g.channel) open(g.channel)
          openThreadId(g.channel, g.parent)
          highlight(g.id)
          return
        }
        const pane = stateRef.current.panes[g.channel]
        if (!pane?.list.some((m) => m.id === g.id)) await loadAround(g.channel, g.id)
        if (activeRef.current !== g.channel) open(g.channel)
        else dispatch({ type: 'thread', thread: null })
        highlight(g.id)
      } catch {
        toast(tRef.current.msgNotFound)
      }
    },
    [open, openThreadId, highlight, loadAround, toast],
  )

  const actions: ChatActions = useMemo(
    () => ({
      toast,
      async send(channel, body, o = {}) {
        const me = stateRef.current.me
        if (!me) return
        const cid = o.retryOf?.client_id ?? clientId()
        const prev = o.retryOf?.retry
        let attachments = o.attachments ?? prev?.attachments ?? []
        const mentions = o.mentions ?? prev?.mentions ?? []
        let voice = o.voice ?? prev?.voice
        const local: Message = o.retryOf
          ? { ...o.retryOf, pending: true, failed: null }
          : {
              id: `m_~${cid}`,
              channel,
              uid: me.uid,
              name: me.name,
              body,
              kind: 'message',
              parent_id: o.parent ?? null,
              reply_count: 0,
              edited_at: null,
              deleted: false,
              pinned: false,
              attachments: [],
              mentions: [],
              reactions: {},
              created_at: Date.now(),
              client_id: cid,
              client: o.sms ? { dir: 'out', via: 'sms' } : null,
              pending: true,
              retry: { attachments, mentions, voice },
            }
        dispatch({ type: 'msg', channel, message: local })
        try {
          // A voice note uploads first, inside the send, so a failed upload is a failed bubble with Retry (SunOff).
          if (voice && !o.sms) {
            const form = new FormData()
            form.set('file', voice.blob, voice.name)
            form.set('channel', channel)
            form.set('kind', 'voice')
            form.set('duration', String(voice.duration))
            if (voice.wave) form.set('wave', voice.wave)
            attachments = [...attachments, (await api.upload(form)).attachment.id]
            voice = undefined
            dispatch({ type: 'patch', channel, id: local.id, patch: { retry: { attachments, mentions } } })
          }
          const r = o.sms
            ? await api.req<{ message: Message }>('POST', `/api/cases/${channel}/sms`, { body })
            : await api.req<{ message: Message }>('POST', `/api/channels/${channel}/messages`, { body, parent_id: local.parent_id ?? null, attachments, client_id: cid, ...(mentions.length ? { mentions } : {}) })
          dispatch({ type: 'drop', channel, id: local.id })
          dispatch({ type: 'msg', channel, message: { ...r.message, client_id: r.message.client_id ?? cid } })
          bumpRoot({ ...r.message, channel })
        } catch (e) {
          dispatch({ type: 'patch', channel, id: local.id, patch: { pending: false, failed: e instanceof ChatError ? e.message : t.notSent } })
        }
      },
      atBottom(channel, bottom) {
        const was = bottoms.current[channel]
        bottoms.current[channel] = bottom
        if (bottom && !was) window.setTimeout(() => void markRead(channel), 500)
      },
      discard(m) {
        dispatch({ type: 'drop', channel: m.channel, id: m.id })
      },
      async edit(m, body) {
        const r = await api.req<{ message: Message }>('PATCH', `/api/messages/${m.id}`, { body })
        dispatch({ type: 'patch', channel: m.channel, id: m.id, patch: r.message })
      },
      async remove(m) {
        await api.req('DELETE', `/api/messages/${m.id}`)
        dispatch({ type: 'patch', channel: m.channel, id: m.id, patch: { deleted: true, body: '', attachments: [] } })
      },
      async react(m, emoji) {
        const r = await api.req<{ reactions: Record<string, string[]> }>('POST', `/api/messages/${m.id}/react`, { emoji })
        dispatch({ type: 'patch', channel: m.channel, id: m.id, patch: { reactions: r.reactions } })
      },
      async pin(m) {
        const r = await api.req<{ pinned: boolean }>('POST', `/api/messages/${m.id}/pin`)
        dispatch({ type: 'patch', channel: m.channel, id: m.id, patch: { pinned: r.pinned } })
      },
      openThread(m) {
        if (!m) {
          dispatch({ type: 'thread', thread: null })
          return
        }
        dispatch({ type: 'thread', thread: { channel: m.channel, root: m.id, list: [m] } })
        void api
          .req<{ messages: Message[] }>('GET', `/api/channels/${m.channel}/messages?thread=${m.id}&limit=100`)
          .then((r) => dispatch({ type: 'thread', thread: { channel: m.channel, root: m.id, list: r.messages } }))
          .catch(() => toast(t.failed))
      },
      async loadOlder(channel) {
        const first = stateRef.current.panes[channel]?.list.find(isServer)
        if (!first) return
        const r = await api.req<{ messages: Message[]; has_more: boolean }>('GET', `/api/channels/${channel}/messages?before=${first.id}&limit=50`)
        dispatch({ type: 'pane', channel, pane: { hasMore: r.has_more }, prepend: r.messages })
      },
      async upload(channel, file, name, extra = {}) {
        if (file.size > 8 * 1024 * 1024 && !extra.kind) throw new ChatError(413, 'too_large', t.tooBig)
        const form = new FormData()
        form.set('file', file, name)
        form.set('channel', channel)
        for (const [k, v] of Object.entries(extra)) form.set(k, v)
        return (await api.upload(form)).attachment.id
      },
      typing(channel) {
        if (!api.send({ t: 'typing', channel })) void api.req('POST', `/api/channels/${channel}/typing`).catch(() => undefined)
      },
    }),
    [api, toast, bumpRoot, markRead, t.failed, t.notSent, t.tooBig],
  )

  // Shell seam (./host-bridge.ts): badge counts, live state, the phone title, and #c= / #case= / #m= / #thread= links.
  const activeChannel = s.channels.find((c) => c.id === active) ?? null
  useHostBridge({
    api,
    lang,
    ready: phase === 'ready',
    live: status === 'live',
    channels: s.channels,
    panes: s.panes,
    active,
    activeLabel: activeChannel ? channelLabel(activeChannel) : null,
    openChannel: (id) => {
      setActive(id)
      dispatch({ type: 'thread', thread: null })
      const url = new URL(window.location.href)
      url.hash = `c=${id}`
      window.history.replaceState({ chat: id }, '', url)
    },
    openThread: (m) => actions.openThread(m),
    loadOlder: (ch) => actions.loadOlder(ch),
    toast,
  })

  function changeLang(next: Lang) {
    if (next === lang) return
    applyLang(next)
    const me = stateRef.current.me
    if (me) dispatch({ type: 'me', me: { ...me, lang: next, prefs: { ...me.prefs, lang: next } } })
    void api.req('POST', '/api/me/prefs', { lang: next }).catch(() => undefined)
  }

  async function syncNow() {
    setSyncing(true)
    try {
      const r = await api.req<{ users?: number; note?: string }>('POST', '/api/admin/sync')
      toast(typeof r.users === 'number' ? t.syncDone(r.users) : r.note || t.saved)
      await loadChannels()
    } catch (e) {
      toast(e instanceof ChatError ? e.message : t.failed)
    } finally {
      setSyncing(false)
    }
  }

  // A phone's open conversation is a pushed screen: swipe from the left edge to go back (docs/NATIVE_FEEL.md).
  const mainRef = useRef<HTMLDivElement>(null)
  useEdgeSwipeBack(mainRef, Boolean(active) && phase === 'ready', () => pressBack(mainRef.current, '.chat-back'))

  if (phase === 'not_linked') return <LinkCard t={t} onLinked={() => window.location.reload()} />
  if (phase === 'error')
    return (
      <div className="chat-note" role="alert">
        <p>{t.failed}</p>
        <button type="button" className="chat-btn" onClick={() => window.location.reload()}>{t.retry}</button>
      </div>
    )

  const ready = phase === 'ready' && s.me
  const channel = ready ? s.channels.find((c) => c.id === active && !c.removed) ?? null : null
  const liveState: Live = status === 'live' ? 'live' : !net || status === 'offline' ? 'off' : 'poll'

  return (
    <section className={`chat${channel ? ' chat-open' : ''}${s.thread ? ' chat-thread-open' : ''}`} aria-label={t.title} aria-busy={!ready}>
      <ChatList
        t={t}
        lang={lang}
        me={ready ? s.me : null}
        channels={s.channels}
        online={s.online}
        active={active}
        query={query}
        setQuery={setQuery}
        cat={cat}
        setCat={setCat}
        live={liveState}
        net={net}
        rooms={rooms}
        features={features}
        searchRef={searchRef}
        syncing={syncing}
        onRetry={() => {
          api.retryNow()
          void loadChannels().catch(() => undefined)
        }}
        onOpen={(id) => {
          if (query && !isDesk()) setQuery('')
          open(id)
        }}
        onNew={() => setSheet({ k: 'new' })}
        onSearch={(q) => setSheet({ k: 'search', scoped: false, q })}
        onRooms={() => {
          setSheet({ k: 'rooms' })
          if (Date.now() - roomsAt.current > 20_000) void loadRooms()
        }}
        onFlagged={() => setSheet({ k: 'flagged' })}
        onAnnounce={() => {
          const ann = s.channels.find((c) => c.kind === 'announcements' && !c.removed && !c.archived_at)
          if (ann) open(ann.id)
          else toast(t.notFound)
        }}
        onSync={() => void syncNow()}
        onSettings={() => setSheet({ k: 'settings' })}
      />
      <div ref={mainRef} className="chat-main">
        {channel && s.me ? (
          <Conversation
            key={channel.id}
            api={api}
            t={t}
            lang={lang}
            me={s.me}
            channel={channel}
            pane={s.panes[channel.id] ?? emptyPane}
            thread={s.thread && s.thread.channel === channel.id ? s.thread : null}
            typing={s.typing[channel.id] ?? {}}
            online={s.online}
            actions={actions}
            onBack={() => (window.history.state?.chat ? window.history.back() : open(null))}
            onPins={() => setSheet({ k: 'pins' })}
            onSearch={() => setSheet({ k: 'search', scoped: true, q: '' })}
            onDetails={() => setSheet({ k: 'details' })}
          />
        ) : (
          <p className="chat-pick">{t.pick}</p>
        )}
      </div>
      {sheet?.k === 'search' ? <SearchSheet api={api} t={t} lang={lang} scope={sheet.scoped ? channel : null} initial={sheet.q} onClose={() => setSheet(null)} onGoto={(g) => void goto(g)} /> : null}
      {sheet?.k === 'new' ? <NewChatSheet api={api} t={t} onClose={() => setSheet(null)} onCreated={(c) => { setSheet(null); dispatch({ type: 'channel', channel: c }); open(c.id) }} /> : null}
      {sheet?.k === 'add' && channel ? <NewChatSheet api={api} t={t} mode="add" channel={channel} onClose={() => setSheet({ k: 'details' })} onAdded={(c) => { dispatch({ type: 'channel', channel: c }); setSheet({ k: 'details' }) }} /> : null}
      {sheet?.k === 'pins' && channel ? <PinsSheet api={api} t={t} lang={lang} channel={channel} onClose={() => setSheet(null)} onGoto={(g) => void goto(g)} onCount={(n) => n !== channel.pins && dispatch({ type: 'channel', channel: { ...channel, pins: n } })} /> : null}
      {sheet?.k === 'details' && channel && s.me ? (
        <ChannelSheet
          api={api}
          t={t}
          me={s.me}
          channel={channel}
          online={s.online}
          toast={toast}
          onClose={() => setSheet(null)}
          onChanged={(c) => dispatch({ type: 'channel', channel: c })}
          onGone={(id) => gone(id, false)}
          onAddPeople={() => setSheet({ k: 'add' })}
        />
      ) : null}
      {sheet?.k === 'rooms' && features.rooms && s.me ? <RoomsSheet api={api} t={t} lang={lang} me={s.me} data={rooms} reload={loadRooms} toast={toast} onClose={() => setSheet(null)} /> : null}
      {sheet?.k === 'flagged' ? <FlaggedSheet api={api} t={t} lang={lang} onClose={() => setSheet(null)} onGoto={(g) => void goto(g)} /> : null}
      {sheet?.k === 'settings' && s.me ? (
        <SettingsSheet
          api={api}
          t={t}
          lang={lang}
          me={s.me}
          toast={toast}
          onLang={changeLang}
          onSaved={(prefs: MePrefs) => {
            const me = stateRef.current.me
            if (me) dispatch({ type: 'me', me: { ...me, prefs: { ...me.prefs, ...prefs } } })
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      <p className="sr" aria-live="polite" aria-atomic="true">{said}</p>
      {toastMsg ? <p className="chat-toast" role="status">{toastMsg}</p> : null}
    </section>
  )
}
