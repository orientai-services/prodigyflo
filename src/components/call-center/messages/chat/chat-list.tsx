'use client'

import type { ReactNode, RefObject } from 'react'
import { CATS, badgeText, byActivity, catOf, channelLabel, filterChannels, initials, listTime, listable, rowPreview, tickOf, unseen, type Cat } from './format'
import { Skeleton } from './sheets'
import type { T } from './strings'
import type { Channel, Lang, Me, RoomsAnswer } from './types'

const CAT_ICON: Record<Cat, string> = { dms: '💬', clients: '👤', chans: '#' }
const catLabel = (t: T, k: Cat) => (k === 'dms' ? t.secDms : k === 'clients' ? t.secClients : t.secChannels)

export type Live = 'live' | 'poll' | 'off'

type Props = {
  t: T
  lang: Lang
  me: Me | null
  channels: Channel[]
  online: Record<string, boolean>
  active: string | null
  query: string
  setQuery: (q: string) => void
  cat: Cat | ''
  setCat: (c: Cat | '') => void
  live: Live
  net: boolean
  rooms: RoomsAnswer | null
  searchRef: RefObject<HTMLInputElement | null>
  syncing: boolean
  onRetry: () => void
  onOpen: (id: string) => void
  onNew: () => void
  onSearch: (q: string) => void
  onRooms: () => void
  onFlagged: () => void
  onAnnounce: () => void
  onSync: () => void
  onSettings: () => void
}

/**
 * The conversation list (SunOff chat renderSide, owner 2026-10-12): category buttons (Direct messages, Clients,
 * Channels) with how many conversations and unseen messages each holds; tapping one shows only its conversations,
 * newest first, under a "‹" back header. The category is remembered on this device. A search shows every match.
 */
export function ChatList({ searchRef, ...p }: Props) {
  const { t, lang, me, query } = p
  const all = listable(p.channels)
  const q = query.trim()
  const sorted = (q ? filterChannels(all, q) : all).slice().sort(byActivity)
  const groups: Record<Cat, Channel[]> = { dms: [], clients: [], chans: [] }
  for (const c of sorted) groups[catOf(c)].push(c)
  const inCat = !q && p.cat && groups[p.cat].length ? p.cat : ''

  const row = (c: Channel) => <li key={c.id}><ChannelRow c={c} t={t} lang={lang} me={me!.uid} on={c.id === p.active} online={c.dm_uid ? p.online[c.dm_uid] ?? c.members.find((m) => m.uid === c.dm_uid)?.online ?? false : false} onOpen={() => p.onOpen(c.id)} /></li>

  let body: ReactNode
  if (!me) body = <Skeleton rows={7} />
  else if (!all.length) body = <p className="chat-empty">{t.noChannels}</p>
  else if (q) {
    body = (
      <>
        {!sorted.length ? <p className="chat-empty">{t.noMatch}</p> : null}
        <ul>{sorted.map(row)}</ul>
        <button type="button" className="chat-row chat-row-search" onClick={() => p.onSearch(q)}>
          <span className="chat-av chan" aria-hidden="true">🔍</span>
          <span className="chat-row-main"><b>{t.searchMsgs(q)}</b></span>
        </button>
      </>
    )
  } else if (inCat) {
    const rest = unseen(all.filter((c) => catOf(c) !== inCat))
    const b = badgeText(rest)
    body = (
      <>
        <button type="button" className="chat-catback" onClick={() => p.setCat('')} aria-label={t.catBack(rest.unread + rest.mentions)}>
          <span className="chat-chev" aria-hidden="true">‹</span>
          <span className="chat-cat-name">{CAT_ICON[inCat]} {catLabel(t, inCat)} · {groups[inCat].length}</span>
          {b ? <span className={`chat-badge${b.mention ? ' mention' : ''}`} aria-hidden="true">{b.text}</span> : null}
        </button>
        <ul>{groups[inCat].map(row)}</ul>
      </>
    )
  } else {
    body = (
      <ul className="chat-cats">
        {CATS.map((k) => {
          const g = groups[k]
          if (!g.length) return null
          const u = unseen(g)
          const b = badgeText(u)
          return (
            <li key={k}>
              <button type="button" className={`chat-cat${u.unread || u.mentions ? ' unread' : ''}`} onClick={() => p.setCat(k)} aria-label={t.catAl(catLabel(t, k), g.length, u.unread)}>
                <span className="chat-av chan" aria-hidden="true">{CAT_ICON[k]}</span>
                <span className="chat-cat-name">{catLabel(t, k)}</span>
                <span className="chat-cat-n" aria-hidden="true">{g.length}</span>
                {b ? <span className={`chat-badge${b.mention ? ' mention' : ''}`} aria-hidden="true">{b.text}</span> : null}
                <span className="chat-chev" aria-hidden="true">›</span>
              </button>
            </li>
          )
        })}
      </ul>
    )
  }

  const liveTxt = p.live === 'live' ? t.live : p.live === 'poll' ? t.livePoll : t.liveOff
  const inside = p.rooms?.inside ?? 0
  return (
    <div className="chat-side">
      {!p.net ? (
        <div className="chat-net" role="status">
          <span>{t.netDown}</span>
          <button type="button" className="chat-btn ghost sm" onClick={p.onRetry}>{t.reconnect}</button>
        </div>
      ) : null}
      <div className="chat-side-head">
        <label className="chat-filter">
          <span className="sr">{t.findPh}</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => p.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && q) {
                e.preventDefault()
                p.onSearch(q)
              }
            }}
            placeholder={t.findPh}
            autoComplete="off"
            enterKeyHint="search"
            aria-keyshortcuts="Control+K"
          />
        </label>
        <button type="button" className="chat-icon chat-icon-main" onClick={p.onNew} aria-label={t.newChat} title={t.newChat}>＋</button>
      </div>
      <nav className="chat-list" aria-label={t.title} aria-busy={!me}>
        {body}
      </nav>
      {me ? (
        <footer className="chat-foot">
          <span className="chat-me">
            <span className="chat-av sm" aria-hidden="true">{initials(me.name)}</span>
            <b>{me.name}</b>
          </span>
          <span className={`chat-live ${p.live}`} title={liveTxt}>{liveTxt}</span>
          <span className="chat-foot-btns">
            {p.rooms && (p.rooms.rooms.length || p.rooms.can_create) ? (
              <button type="button" className={`chat-fb${inside ? ' on' : ''}`} onClick={p.onRooms} aria-label={t.roomsAl(inside)} title={t.roomsAl(inside)}>
                🎥 {t.roomsShort}
                {inside ? <span className="chat-fb-n">{t.roomIn(inside)}</span> : null}
              </button>
            ) : null}
            {me.staff ? (
              <>
                <button type="button" className="chat-fb" onClick={p.onFlagged}>🚩 {t.flaggedS}</button>
                <button type="button" className="chat-fb" onClick={p.onAnnounce}>📣 {t.announce}</button>
                <button type="button" className="chat-fb" onClick={p.onSync} disabled={p.syncing} aria-busy={p.syncing}>↻ {t.syncNow}</button>
              </>
            ) : null}
            <button type="button" className="chat-fb" onClick={p.onSettings}>⚙ {t.prefsShort}</button>
          </span>
        </footer>
      ) : null}
    </div>
  )
}

function ChannelRow({ c, t, lang, me, on, online, onOpen }: { c: Channel; t: T; lang: Lang; me: string; on: boolean; online: boolean; onOpen: () => void }) {
  const unread = c.unread > 0 && !c.muted && !on
  const tick = tickOf(c, me)
  const pv = rowPreview(c, t, me)
  const icon = c.case ? (c.case.closed ? '📁' : '👤') : c.kind === 'announcements' ? '📣' : c.kind === 'team' ? c.badge?.emoji || '★' : c.kind === 'group' ? '👥' : '#'
  return (
    <button type="button" className={`chat-row${on ? ' on' : ''}${unread ? ' unread' : ''}${c.muted ? ' muted' : ''}`} onClick={onOpen} aria-current={on ? 'true' : undefined} aria-label={t.rowAl(channelLabel(c), unread ? c.unread : 0, c.mentions, c.muted)}>
      <span className={`chat-av${c.case ? ' case' : c.kind === 'dm' ? '' : ' chan'}`} aria-hidden="true">
        {c.kind === 'dm' ? initials(c.name) : icon}
        {c.kind === 'dm' ? <i className={`chat-dot${online ? ' on' : ''}`} /> : null}
      </span>
      <span className="chat-row-main">
        <b>
          <span className="chat-row-name">{channelLabel(c)}</span>
          {c.muted ? <small aria-hidden="true"> 🔕</small> : null}
        </b>
        {pv || tick ? (
          <span className="chat-snip">
            {tick ? <span className={`chat-tick${tick === 'all' ? ' all' : ''}`} aria-label={tick === 'sent' ? t.sent : tick === 'all' ? t.seenAll : t.seen}>{tick === 'sent' ? '✓' : '✓✓'}</span> : null}
            {pv}
          </span>
        ) : null}
      </span>
      <span className="chat-row-side" aria-hidden="true">
        <time>{c.last_msg ? listTime(c.last_msg.at || c.last_msg_at, lang) : ''}</time>
        {c.mentions ? (
          <span className="chat-badge mention">@{c.mentions > 99 ? '99+' : c.mentions}</span>
        ) : unread ? (
          <span className="chat-badge">{c.unread > 99 ? '99+' : c.unread}</span>
        ) : null}
      </span>
    </button>
  )
}
