'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useTransition } from 'react'
import { linkSunoffAccount } from '@/lib/chat-bridge/actions'
import { ChatApi, ChatError, clientId } from './api'
import { Conversation } from './conversation'
import { channelLabel, filterChannels, initials, listTime, preview, sectionOf, upsertMessage, type Section } from './format'
import { NewChatSheet, PinsSheet, SearchSheet } from './sheets'
import { strings, type T } from './strings'
import type { Channel, ChatEvent, Lang, Me, Message } from './types'
import './chat.css'

/**
 * ProdigyFlo's team chat (docs/CYS_BRIDGE.md §B4, owner decision D4): the one
 * SunOff team chat, drawn in the desk look and talking to the chat Worker
 * directly (REST + WebSocket). No message is stored in ProdigyFlo.
 */

type Props = { configured: boolean; linked: boolean; initialLang: Lang }

export function TeamChat({ configured, linked, initialLang }: Props) {
  const [lang, setLang] = useState<Lang>(initialLang)
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
  | { type: 'read'; channel: string; uid: string; msg_id: string; mine: boolean }
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
              ? { ...c, last_msg: { id: m.id, uid: m.uid, name: m.name, body: m.body, at: m.created_at, att: m.attachments[0] ? (m.attachments[0].kind === 'voice' ? 'voice' : m.attachments[0].type.startsWith('image/') ? 'image' : 'file') : null, deleted: false }, last_msg_at: m.created_at }
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
      return cur ? { ...s, panes: { ...s.panes, [a.channel]: { ...cur, list: cur.list.filter((m) => m.id !== a.id) } } } : s
    }
    case 'thread':
      return { ...s, thread: a.thread }
    case 'read': {
      const cur = s.panes[a.channel]
      const panes = cur ? { ...s.panes, [a.channel]: { ...cur, reads: { ...cur.reads, [a.uid]: a.msg_id } } } : s.panes
      const channels = a.mine ? s.channels.map((c) => (c.id === a.channel ? { ...c, unread: 0, mentions: 0, last_read_msg_id: a.msg_id } : c)) : s.channels
      return { ...s, panes, channels }
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
  send: (channel: string, body: string, o?: { parent?: string; attachments?: string[]; mentions?: string[]; sms?: boolean; retryOf?: Message }) => Promise<void>
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

function ChatApp({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const t = strings(lang)
  const api = useMemo(() => new ChatApi(lang), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [s, dispatch] = useReducer(reducer, { me: null, channels: [], panes: {}, thread: null, typing: {}, online: {} })
  const [phase, setPhase] = useState<'loading' | 'ready' | 'not_linked' | 'error'>('loading')
  const [status, setStatus] = useState(api.status)
  const [active, setActive] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sheet, setSheet] = useState<null | 'search' | 'new' | 'pins'>(null)
  const [toastMsg, setToast] = useState<string | null>(null)
  // Socket handlers and actions read the newest state through these (they are set after every render).
  const stateRef = useRef(s)
  const activeRef = useRef(active)
  useEffect(() => {
    stateRef.current = s
    activeRef.current = active
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

  const loadChannels = useCallback(async () => {
    const list = await api.req<Channel[]>('GET', '/api/channels')
    dispatch({ type: 'channels', list })
  }, [api])

  const markRead = useCallback(
    async (channel: string) => {
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
        if (out.me) dispatch({ type: 'me', me: out.me as Me })
        await loadChannels()
        if (!live) return
        setPhase('ready')
        void api.connect()
        const hash = /#c=(c_[0-9a-z]{15})/.exec(window.location.hash)
        if (hash) setActive(hash[1])
      } catch {
        if (live) setPhase('error')
      }
    })()
    const offStatus = api.onStatus(setStatus)
    return () => {
      live = false
      offStatus()
      api.close()
    }
  }, [api, loadChannels])

  // Live events.
  useEffect(() => {
    return api.on((ev: ChatEvent) => {
      const me = stateRef.current.me?.uid ?? ''
      switch (ev.t) {
        case 'msg':
          dispatch({ type: 'msg', channel: ev.channel, message: ev.message })
          bumpRoot({ ...ev.message, channel: ev.channel })
          if (ev.channel === activeRef.current && document.visibilityState === 'visible') window.setTimeout(() => void markRead(ev.channel), 300)
          else if (!stateRef.current.channels.some((c) => c.id === ev.channel)) void loadChannels()
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
          dispatch({ type: 'read', channel: ev.channel, uid: ev.uid, msg_id: ev.msg_id, mine: ev.uid === me })
          break
        case 'typing':
          if (ev.uid !== me) dispatch({ type: 'typing', channel: ev.channel, uid: ev.uid, name: ev.name })
          break
        case 'presence':
          dispatch({ type: 'presence', uid: ev.uid, online: ev.online })
          break
        case 'channel':
        case 'case':
        case 'unread':
          void loadChannels()
          break
      }
    })
  }, [api, loadChannels, markRead, bumpRoot])

  // Socket down: poll the list (and the open conversation) every 5 s while the tab is visible.
  useEffect(() => {
    if (phase !== 'ready' || status === 'live') return
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadChannels().catch(() => undefined)
      const ch = activeRef.current
      const last = ch ? stateRef.current.panes[ch]?.list.filter(isServer).at(-1) : undefined
      if (ch && last)
        void api
          .req<{ messages: Message[] }>('GET', `/api/channels/${ch}/messages?after=${last.id}&limit=50`)
          .then((r) => r.messages.forEach((m) => dispatch({ type: 'msg', channel: ch, message: m })))
          .catch(() => undefined)
    }, 5000)
    return () => window.clearInterval(id)
  }, [api, phase, status, loadChannels])

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

  // Browser back closes the open conversation on phones.
  useEffect(() => {
    const onPop = () => {
      const m = /#c=(c_[0-9a-z]{15})/.exec(window.location.hash)
      setActive(m ? m[1] : null)
      dispatch({ type: 'thread', thread: null })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const open = useCallback((id: string | null) => {
    setActive(id)
    dispatch({ type: 'thread', thread: null })
    const url = new URL(window.location.href)
    url.hash = id ? `c=${id}` : ''
    if (id) window.history.pushState({ chat: id }, '', url)
    else window.history.replaceState({}, '', url)
  }, [])

  const actions: ChatActions = useMemo(
    () => ({
      toast,
      async send(channel, body, o = {}) {
        const me = stateRef.current.me
        if (!me) return
        const cid = o.retryOf?.client_id ?? clientId()
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
            }
        dispatch({ type: 'msg', channel, message: local })
        try {
          const r = o.sms
            ? await api.req<{ message: Message }>('POST', `/api/cases/${channel}/sms`, { body })
            : await api.req<{ message: Message }>('POST', `/api/channels/${channel}/messages`, { body, parent_id: o.parent ?? null, attachments: o.attachments ?? [], client_id: cid, ...(o.mentions?.length ? { mentions: o.mentions } : {}) })
          dispatch({ type: 'drop', channel, id: local.id })
          dispatch({ type: 'msg', channel, message: { ...r.message, client_id: r.message.client_id ?? cid } })
          bumpRoot({ ...r.message, channel })
        } catch (e) {
          dispatch({ type: 'patch', channel, id: local.id, patch: { pending: false, failed: e instanceof ChatError ? e.message : t.notSent } })
        }
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
    [api, toast, bumpRoot, t.failed, t.notSent, t.tooBig],
  )

  async function switchLang() {
    const next: Lang = lang === 'en' ? 'es' : 'en'
    setLang(next)
    try {
      window.localStorage.setItem('pf_chat_lang', next)
    } catch {
      // private mode: the switch still works for this visit
    }
    void api.req('POST', '/api/me/prefs', { lang: next }).catch(() => undefined)
  }

  if (phase === 'not_linked') return <LinkCard t={t} onLinked={() => window.location.reload()} />
  if (phase === 'error')
    return (
      <div className="chat-note" role="alert">
        <p>{t.failed}</p>
        <button type="button" className="chat-btn" onClick={() => window.location.reload()}>{t.retry}</button>
      </div>
    )
  if (phase === 'loading' || !s.me) return <p className="chat-note" aria-busy="true">{t.loading}</p>

  const channel = s.channels.find((c) => c.id === active) ?? null
  const shown = filterChannels(s.channels, query)
  const groups: Array<[Section, string]> = [
    ['cases', t.secClients],
    ['channels', t.secChannels],
    ['dms', t.secDms],
    ['groups', t.secGroups],
  ]

  return (
    <section className={`chat${channel ? ' chat-open' : ''}${s.thread ? ' chat-thread-open' : ''}`} aria-label={t.title}>
      <div className="chat-side">
        <div className="chat-side-head">
          <label className="chat-filter">
            <span className="sr">{t.search}</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.searchPh} autoComplete="off" />
          </label>
          <button type="button" className="chat-icon" onClick={() => setSheet('search')} aria-label={t.search} title={t.search}>⌕</button>
          <button type="button" className="chat-icon chat-icon-main" onClick={() => setSheet('new')} aria-label={t.newChat} title={t.newChat}>＋</button>
        </div>
        <div className="chat-side-meta">
          <span className={`chat-status chat-status-${status}`}>{status === 'live' ? t.live : status === 'offline' ? t.offline : t.polling}</span>
          <button type="button" className="chat-lang" onClick={() => void switchLang()}>{t.lang}</button>
        </div>
        <nav className="chat-list" aria-label={t.title}>
          {shown.length === 0 ? <p className="chat-empty">{t.noChannels}</p> : null}
          {groups.map(([key, label]) => {
            const items = shown.filter((c) => sectionOf(c) === key)
            if (!items.length) return null
            return (
              <div key={key} className="chat-sec">
                <h3>{label}</h3>
                <ul>
                  {items.map((c) => (
                    <li key={c.id}>
                      <ChannelRow c={c} t={t} lang={lang} me={s.me!.uid} on={c.id === active} online={c.dm_uid ? s.online[c.dm_uid] ?? c.members.find((m) => m.uid === c.dm_uid)?.online ?? false : false} onOpen={() => open(c.id)} />
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </nav>
      </div>
      <div className="chat-main">
        {channel ? (
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
            onPins={() => setSheet('pins')}
          />
        ) : (
          <p className="chat-pick">{t.pick}</p>
        )}
      </div>
      {sheet === 'search' ? <SearchSheet api={api} t={t} lang={lang} onClose={() => setSheet(null)} onOpen={(id) => { setSheet(null); open(id) }} /> : null}
      {sheet === 'new' ? <NewChatSheet api={api} t={t} onClose={() => setSheet(null)} onCreated={(c) => { setSheet(null); dispatch({ type: 'channel', channel: c }); open(c.id) }} /> : null}
      {sheet === 'pins' && channel ? <PinsSheet api={api} t={t} lang={lang} channel={channel} onClose={() => setSheet(null)} /> : null}
      {toastMsg ? <p className="chat-toast" role="status">{toastMsg}</p> : null}
    </section>
  )
}

function ChannelRow({ c, t, lang, me, on, online, onOpen }: { c: Channel; t: T; lang: Lang; me: string; on: boolean; online: boolean; onOpen: () => void }) {
  const label = channelLabel(c)
  const unread = c.unread > 0 && !on
  return (
    <button type="button" className={`chat-row${on ? ' on' : ''}${unread ? ' unread' : ''}${c.muted ? ' muted' : ''}`} onClick={onOpen} aria-current={on ? 'true' : undefined}>
      <span className={`chat-av${c.case ? ' case' : c.kind === 'dm' ? '' : ' chan'}`} aria-hidden="true">
        {c.kind === 'dm' ? initials(c.name) : c.case ? initials(c.name) : '#'}
        {c.kind === 'dm' ? <i className={`chat-dot${online ? ' on' : ''}`} /> : null}
      </span>
      <span className="chat-row-main">
        <b>{label}</b>
        <span className="chat-snip">{c.case ? [c.case.stage, c.case.phone4 ? `••${c.case.phone4}` : null].filter(Boolean).join(' · ') + (c.last_msg ? ' · ' : '') : ''}{preview(c, t, me)}</span>
      </span>
      <span className="chat-row-side">
        <time>{listTime(c.last_msg?.at ?? c.last_msg_at, lang)}</time>
        {unread ? (
          <span className={`chat-badge${c.mentions ? ' mention' : ''}`} aria-label={`${c.unread} unread${c.mentions ? `, ${c.mentions} mentions` : ''}`}>
            {c.mentions ? `@${c.mentions > 9 ? '9+' : c.mentions}` : c.unread > 99 ? '99+' : c.unread}
          </span>
        ) : null}
      </span>
    </button>
  )
}
