'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatApi } from './api'
import { ChatError } from './api'
import { EmojiPicker } from './emoji-picker'
import { prepImage } from './image-compress'
import { channelLabel, clock, fmtDur, initials, rowsFor } from './format'
import { AttachmentView, VoicePlayer, canRecord, useRecorder, type Recording } from './media'
import { ConfirmBox, MessageMenu, type MenuItem } from './message-menu'
import {
  ACCEPT,
  MAX_BODY,
  MAX_FILE,
  MAX_FILES,
  QUICK,
  SMS_MAX_BODY,
  canDeleteMessage,
  canEditMessage,
  canPinMessage,
  counter,
  draftKey,
  enterSends,
  fmtSize,
  groupsWith,
  isAllowedFile,
  isJumbo,
  mentionAt,
  mentionItems,
  pickedMentions,
  receiptTarget,
  receiptText,
  relTime,
  seenOf,
  segments,
  tickFor,
  voiceFileName,
  type MentionItem,
} from './message-logic'
import type { T } from './strings'
import type { ChatActions } from './team-chat'
import type { Channel, Lang, Me, Message, Person } from './types'

type Pane = { list: Message[]; hasMore: boolean; reads: Record<string, string>; loaded: boolean }

type Props = {
  api: ChatApi
  t: T
  lang: Lang
  me: Me
  channel: Channel
  pane: Pane
  thread: { channel: string; root: string; list: Message[] } | null
  typing: Record<string, { name: string; at: number }>
  online: Record<string, boolean>
  actions: ChatActions
  onBack: () => void
  onPins: () => void
  /** 🔍 search inside this channel and ⚙ channel details (team-chat.tsx owns both sheets). */
  onSearch?: () => void
  onDetails?: () => void
}

const isPhone = () => window.matchMedia('(max-width: 760px)').matches
const isCoarse = () => window.matchMedia('(pointer: coarse)').matches

/** What every message row needs from the conversation around it. */
type Ctx = {
  api: ChatApi
  t: T
  lang: Lang
  me: Me
  channel: Channel
  actions: ChatActions
  reads: Record<string, string>
  names: Map<string, string>
  now: number
  editing: string | null
  setEditing: (id: string | null) => void
  openMenu: (m: Message, inThread: boolean) => void
  openPicker: (anchor: HTMLElement, pick: (e: string) => void) => void
}

export function Conversation({ api, t, lang, me, channel, pane, thread, typing, online, actions, onBack, onPins, onSearch, onDetails }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  // The "New" line is placed once, from where I had read up to when I opened the chat; my own send clears it.
  const [marker, setMarker] = useState({ lastRead: channel.last_read_msg_id, unread: channel.unread })
  const [mode, setMode] = useState<'team' | 'sms'>('team')
  const [now, setNow] = useState(() => Date.now())
  const [newBelow, setNewBelow] = useState(0)
  const [divBelow, setDivBelow] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ m: Message; inThread: boolean } | null>(null)
  const [picker, setPicker] = useState<{ anchor: HTMLElement; pick: (e: string) => void } | null>(null)
  const [confirmDel, setConfirmDel] = useState<Message | null>(null)
  const [dragging, setDragging] = useState(false)
  const dropMain = useRef<((files: File[]) => void) | null>(null)
  const dropThread = useRef<((files: File[]) => void) | null>(null)
  const rows = useMemo(() => rowsFor(pane.list, lang, marker.lastRead, me.uid, now, marker.unread), [pane.list, lang, marker, me.uid, now])
  const isCase = Boolean(channel.case)
  const canSms = Boolean(channel.case?.phone4) && !channel.case?.closed
  const others = channel.members.filter((m) => m.uid !== me.uid)
  const onlineCount = others.filter((m) => online[m.uid] ?? m.online).length

  // uid → name for reaction tooltips, receipts and mentions.
  const names = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of channel.members) map.set(m.uid, m.name)
    for (const m of pane.list) if (m.name && !map.has(m.uid)) map.set(m.uid, m.name)
    for (const m of thread?.list ?? []) if (m.name && !map.has(m.uid)) map.set(m.uid, m.name)
    map.set(me.uid, me.name)
    return map
  }, [channel.members, pane.list, thread?.list, me.uid, me.name])

  // Typing lines expire after 4 s; a tick also keeps day labels and "last reply" honest.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 2000)
    return () => window.clearInterval(id)
  }, [])

  // First load: open at the "New" line (a third down), otherwise at the bottom.
  const opened = useRef(false)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !pane.loaded || opened.current) return
    opened.current = true
    const div = el.querySelector<HTMLElement>('.chat-new')
    if (div) {
      el.scrollTop = Math.max(0, div.offsetTop - el.clientHeight / 3)
      setStick(false)
    } else el.scrollTop = el.scrollHeight
    actions.atBottom(channel.id, el.scrollHeight - el.scrollTop - el.clientHeight < 48)
  }, [pane.loaded, actions, channel.id])
  // Leaving the conversation stops it counting as read (the actions object changes with the language; the channel decides).
  const actionsRef = useRef(actions)
  useEffect(() => {
    actionsRef.current = actions
  })
  useEffect(() => {
    const ch = channel.id
    return () => actionsRef.current.atBottom(ch, false)
  }, [channel.id])

  // Older messages land above: keep what I'm looking at in place.
  const keepAnchor = useRef<{ h: number; top: number } | null>(null)
  const loadingOlder = useRef(false)
  const loadOlder = useCallback(async () => {
    const el = scroller.current
    if (loadingOlder.current || !pane.hasMore || !el) return
    loadingOlder.current = true
    keepAnchor.current = { h: el.scrollHeight, top: el.scrollTop }
    try {
      await actions.loadOlder(channel.id)
    } catch {
      keepAnchor.current = null
      actions.toast(t.failed)
    } finally {
      loadingOlder.current = false
    }
  }, [actions, channel.id, pane.hasMore, t.failed])

  // A new message at the end: follow it when I'm at the bottom, else count it on the "↓ New messages" pill.
  const lastId = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = scroller.current
    const k = keepAnchor.current
    if (el && k) {
      el.scrollTop = el.scrollHeight - k.h + k.top
      keepAnchor.current = null
    }
    const last = pane.list.at(-1)
    const prev = lastId.current
    lastId.current = last?.id ?? null
    if (!el || !opened.current || !last || last.id === prev) return
    if (stick || last.uid === me.uid) el.scrollTop = el.scrollHeight
    else if (prev && last.id > prev && !last.pending) setNewBelow((n) => n + 1)
  }, [pane.list, stick, me.uid])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    setStick(bottom)
    if (bottom) setNewBelow(0)
    if (opened.current) actions.atBottom(channel.id, bottom)
    const div = el.querySelector<HTMLElement>('.chat-new')
    setDivBelow(Boolean(div && div.offsetTop > el.scrollTop + el.clientHeight))
    if (el.scrollTop < 300 && pane.hasMore) void loadOlder()
  }, [loadOlder, pane.hasMore, actions, channel.id])

  function jump() {
    const el = scroller.current
    if (!el) return
    const div = el.querySelector<HTMLElement>('.chat-new')
    if (div && div.offsetTop > el.scrollTop + el.clientHeight) el.scrollTop = div.offsetTop - el.clientHeight / 3
    else el.scrollTop = el.scrollHeight
    setNewBelow(0)
  }

  const typers = Object.entries(typing).filter(([uid, v]) => uid !== me.uid && now - v.at < 4000)
  const target = receiptTarget(pane.list, me.uid, channel.member_count)

  const ctx: Ctx = {
    api,
    t,
    lang,
    me,
    channel,
    actions,
    reads: pane.reads,
    names,
    now,
    editing,
    setEditing,
    openMenu: (m, inThread) => setMenu({ m, inThread }),
    openPicker: (anchor, pick) => setPicker({ anchor, pick }),
  }

  const menuItems = (m: Message, inThread: boolean): MenuItem[] => {
    const close = () => setMenu(null)
    const items: MenuItem[] = []
    if (!inThread && !m.parent_id) items.push({ key: 'thread', icon: '💬', label: t.reply, run: () => { close(); actions.openThread(m) } })
    if (m.body)
      items.push({
        key: 'copy',
        icon: '📋',
        label: t.copy,
        run: () => {
          close()
          void navigator.clipboard?.writeText(m.body).then(() => actions.toast(t.copied), () => undefined)
        },
      })
    if (canEditMessage(m, me, now)) items.push({ key: 'edit', icon: '✏️', label: t.edit, run: () => { close(); setEditing(m.id) } })
    if (canPinMessage(m, me, channel.created_by)) items.push({ key: 'pin', icon: '📌', label: m.pinned ? t.unpin : t.pin, run: () => { close(); void run(() => actions.pin(m)) } })
    if (canDeleteMessage(m, me)) items.push({ key: 'delete', icon: '🗑', label: t.del, danger: true, run: () => { close(); setConfirmDel(m) } })
    return items
  }

  async function run(fn: () => Promise<void>) {
    try {
      await fn()
    } catch (e) {
      actions.toast(e instanceof ChatError ? e.message : t.failed)
    }
  }

  const dragHandlers = (target: React.RefObject<((files: File[]) => void) | null>) => ({
    onDragOver: (e: React.DragEvent) => {
      if (![...e.dataTransfer.types].includes('Files')) return
      e.preventDefault()
      setDragging(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
    },
    onDrop: (e: React.DragEvent) => {
      // The thread drawer sits inside the conversation: its drop must not also land in the main composer.
      e.stopPropagation()
      setDragging(false)
      if (!e.dataTransfer.files.length) return
      e.preventDefault()
      target.current?.([...e.dataTransfer.files])
    },
  })

  return (
    <div className={`chat-conv${dragging ? ' dragging' : ''}`} {...dragHandlers(dropMain)}>
      <header className="chat-head">
        <button type="button" className="chat-back" onClick={onBack} aria-label={t.back}>‹</button>
        <div className="chat-who">
          <h2>{channelLabel(channel)}</h2>
          <span>
            {channel.kind === 'dm'
              ? (online[channel.dm_uid ?? ''] ?? others[0]?.online) ? t.online : ''
              : `${t.members(channel.member_count)}${onlineCount ? ` · ${onlineCount} ${t.online}` : ''}`}
          </span>
        </div>
        <button type="button" className="chat-icon chat-head-btn" onClick={onPins} aria-label={channel.pins ? `${t.pinned} (${channel.pins})` : t.pinned} title={t.pinned}>
          📌{channel.pins ? <span className="chat-head-n">{channel.pins}</span> : null}
        </button>
        {onSearch ? <button type="button" className="chat-icon chat-head-btn" onClick={onSearch} aria-label={t.searchIn} title={t.searchIn}>🔍</button> : null}
        {onDetails ? (
          <button type="button" className="chat-icon chat-head-btn" onClick={onDetails} aria-label={t.details} title={t.details}>
            {channel.muted || channel.notify === 'none' ? '🔕' : channel.notify === 'mentions' ? '@' : '🔔'}
          </button>
        ) : null}
      </header>
      {channel.case ? <CaseCard c={channel} t={t} lang={lang} /> : null}
      <div className="chat-wrapm">
        <div className="chat-scroll" ref={scroller} role="log" aria-live="off" aria-label={channelLabel(channel)} onScroll={onScroll}>
          {pane.hasMore ? (
            <button type="button" className="chat-older" onClick={() => void loadOlder()}>
              {t.older}
            </button>
          ) : pane.loaded ? (
            <Intro c={channel} t={t} />
          ) : null}
          {!pane.loaded ? <p className="chat-empty" aria-busy="true">{t.loading}</p> : null}
          {rows.map((r) =>
            r.kind === 'day' ? (
              <div key={`d-${r.key}`} className="chat-day" role="separator"><span>{r.label}</span></div>
            ) : r.kind === 'new' ? (
              <div key={r.key} className="chat-new" role="separator"><span>{t.newDivider}</span></div>
            ) : (
              <MessageBlock key={r.message.id} ctx={ctx} m={r.message} grouped={r.grouped} inThread={false} receipt={target?.id === r.message.id} />
            ),
          )}
        </div>
        {newBelow > 0 || divBelow ? (
          <button type="button" className="chat-jump" onClick={jump}>
            ↓ {t.jump}{newBelow ? <b> {newBelow}</b> : null}
          </button>
        ) : null}
        {dragging ? <p className="chat-drop" aria-hidden="true">{t.dropHere}</p> : null}
      </div>
      <p className="chat-typing" aria-live="polite">{typers.length === 1 ? t.typing1(typers[0][1].name.split(' ')[0]) : typers.length > 1 ? t.typingN(typers.length) : ''}</p>
      {isCase ? (
        <div className="chat-modes" role="tablist" aria-label={t.clientSms}>
          <button type="button" role="tab" aria-selected={mode === 'team'} className={mode === 'team' ? 'on' : ''} onClick={() => setMode('team')}>{t.team}</button>
          <button type="button" role="tab" aria-selected={mode === 'sms'} className={mode === 'sms' ? 'on sms' : ''} disabled={!canSms} onClick={() => setMode('sms')}>{t.clientSms}</button>
        </div>
      ) : null}
      {channel.can_post ? (
        <Composer
          key={mode}
          api={api}
          t={t}
          lang={lang}
          me={me}
          channel={channel}
          mode={isCase ? mode : 'team'}
          placeholder={mode === 'sms' ? t.placeholderSms : t.placeholder(channelLabel(channel))}
          actions={actions}
          authors={pane.list}
          dropRef={dropMain}
          main
          onSent={() => {
            setStick(true)
            setMarker({ lastRead: null, unread: 0 })
            setNewBelow(0)
          }}
        />
      ) : (
        <p className="chat-compose chat-compose-off">{t.readOnly}</p>
      )}
      {thread ? <ThreadPane ctx={ctx} thread={thread} dropRef={dropThread} dragHandlers={dragHandlers(dropThread)} /> : null}
      {menu ? (
        <MessageMenu
          t={t}
          who={menu.m.uid === me.uid ? t.you : menu.m.name}
          items={menuItems(menu.m, menu.inThread)}
          onReact={(e) => {
            const m = menu.m
            setMenu(null)
            void run(() => actions.react(m, e))
          }}
          onMore={(el) => {
            const m = menu.m
            setPicker({ anchor: el, pick: (e) => void run(() => actions.react(m, e)) })
            setMenu(null)
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {confirmDel ? (
        <ConfirmBox
          title={t.delConfirm}
          body={t.delP}
          yes={t.yesDel}
          no={t.cancel}
          onClose={() => setConfirmDel(null)}
          onYes={() => {
            const m = confirmDel
            setConfirmDel(null)
            void run(() => actions.remove(m))
          }}
        />
      ) : null}
      {picker ? (
        <EmojiPicker
          anchor={picker.anchor.isConnected ? picker.anchor : null}
          title={t.emojiT}
          onClose={() => setPicker(null)}
          onPick={(e) => {
            const pick = picker.pick
            setPicker(null)
            pick(e)
          }}
        />
      ) : null}
    </div>
  )
}

/** The card at the top of a conversation once its first message is on screen. */
function Intro({ c, t }: { c: Channel; t: T }) {
  const n = c.name
  let icon = '#'
  let h: string
  let p: string
  if (c.case) {
    icon = '👤'
    h = t.introCase(n)
    p = t.introCaseP
  } else if (c.kind === 'main') {
    h = t.introMain(n)
    p = t.introMainP
  } else if (c.kind === 'announcements') {
    icon = '📣'
    h = t.introAnn
    p = t.introAnnP
  } else if (c.kind === 'team') {
    icon = '★'
    h = t.introTeam(n)
    p = t.introTeamP
  } else if (c.kind === 'dm') {
    icon = initials(n)
    h = t.introDm(n)
    p = t.introDmP
  } else {
    icon = '👥'
    h = t.introGroup(n)
    p = t.introGroupP
  }
  return (
    <div className="chat-intro">
      <div className={`chat-intro-big${c.kind === 'dm' && !c.case ? ' dm' : ''}`} aria-hidden="true">{icon}</div>
      <h3>{h}</h3>
      <p>{p}</p>
    </div>
  )
}

function CaseCard({ c, t, lang }: { c: Channel; t: T; lang: Lang }) {
  const k = c.case!
  const appt = k.appt_at
    ? new Intl.DateTimeFormat(lang === 'es' ? 'es-MX' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }).format(new Date(k.appt_at))
    : null
  // ProdigyFlo cases open our own lead panel in this tab; SunOff ones open the SunOff dialer in a new one.
  const own = k.host === 'prodigyflo'
  const href = own ? k.dialer_url.replace(/^https:\/\/www\.prodigyflo\.ai/, '') : k.dialer_url
  return (
    <div className="chat-case">
      <span className="chat-case-facts">
        {k.stage ? <b className="chat-chip">{k.stage}</b> : null}
        {k.closed ? <b className="chat-chip off">{t.closed}</b> : null}
        {k.rep_name ? <span>{t.rep(k.rep_name)}</span> : null}
        {k.phone4 ? <span>•••-{k.phone4}</span> : null}
        {appt ? <span>{t.appt(appt)}</span> : null}
      </span>
      <a className="chat-pill" href={href} {...(own ? {} : { target: '_blank', rel: 'noreferrer' })}>{t.openLead}</a>
    </div>
  )
}

/** One message plus, under my newest one, the "Sent / Seen by …" line. */
function MessageBlock({ ctx, m, grouped, inThread, receipt }: { ctx: Ctx; m: Message; grouped: boolean; inThread: boolean; receipt: boolean }) {
  return (
    <>
      <MessageItem ctx={ctx} m={m} grouped={grouped} inThread={inThread} />
      {receipt ? <Receipt ctx={ctx} m={m} /> : null}
    </>
  )
}

function Receipt({ ctx, m }: { ctx: Ctx; m: Message }) {
  const { t, me, channel, reads, names } = ctx
  const s = seenOf(reads, m.id, me.uid, channel.member_count)
  const first = s.who.map((u) => (names.get(u) ?? '…').split(' ')[0])
  const text = receiptText(channel.kind, first, s.all, { sent: t.sent, seen: t.seen, seenAll: t.seenAll, seenByNames: t.seenByNames, andMore: t.andMore })
  return (
    <p className={`chat-rcpt${first.length ? '' : ' sent'}`} title={s.who.map((u) => names.get(u) ?? u).join(', ')}>
      <b aria-hidden="true">{first.length ? '✓✓' : '✓'}</b> {text}
    </p>
  )
}

const LP_SKIP = 'a, textarea, button, .chat-tools, .chat-reacts, .chat-vn, .chat-vx, .chat-state'

function MessageItem({ ctx, m, grouped, inThread }: { ctx: Ctx; m: Message; grouped: boolean; inThread: boolean }) {
  const { api, t, lang, me, channel, actions, reads, names, now } = ctx
  const mine = m.uid === me.uid
  const sms = m.client
  const sys = m.kind === 'system'
  const reacts = Object.entries(m.reactions ?? {}).filter(([, uids]) => uids.length)
  const tick = tickFor(m, reads, me.uid, channel.member_count)
  const actionable = !m.deleted && !m.pending && !m.failed && !sys
  const lp = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const lpFired = useRef(0)
  const [hl, setHl] = useState(false)

  async function run(fn: () => Promise<void>) {
    try {
      await fn()
    } catch (e) {
      actions.toast(e instanceof ChatError ? e.message : t.failed)
    }
  }

  function openMenu() {
    if (!actionable) return
    ctx.openMenu(m, inThread)
  }

  const names4 = (uids: string[]) => uids.map((u) => (u === me.uid ? t.you : names.get(u) ?? '…')).join(', ')

  return (
    <article
      className={`chat-msg${grouped ? ' grouped' : ''}${mine ? ' mine' : ''}${sms ? ` sms sms-${sms.dir}` : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}${m.pinned ? ' pinned' : ''}${hl ? ' act' : ''}`}
      aria-label={`${m.name}, ${clock(m.created_at, lang)}`}
      data-id={m.id}
      // Long-press on touch (480 ms, a 12 ms buzz) and right-click on desktop open the action sheet.
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' || !actionable || (e.target as Element).closest(LP_SKIP)) return
        const { clientX: x, clientY: y } = e
        if (lp.current) clearTimeout(lp.current.timer)
        lp.current = {
          x,
          y,
          timer: setTimeout(() => {
            lp.current = null
            lpFired.current = Date.now()
            setHl(true)
            navigator.vibrate?.(12)
            openMenu()
            setTimeout(() => setHl(false), 600)
          }, 480),
        }
      }}
      onPointerMove={(e) => {
        const p = lp.current
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) {
          clearTimeout(p.timer)
          lp.current = null
        }
      }}
      onPointerUp={() => {
        if (lp.current) clearTimeout(lp.current.timer)
        lp.current = null
        // The finger lifting after a long-press sends a click to whatever is under it now: the sheet's buttons.
        // Swallow that one click before React sees it.
        if (lpFired.current && Date.now() - lpFired.current < 10_000) {
          lpFired.current = 0
          const swallow = (ev: MouseEvent) => {
            ev.preventDefault()
            ev.stopPropagation()
          }
          document.addEventListener('click', swallow, { capture: true, once: true })
          setTimeout(() => document.removeEventListener('click', swallow, true), 500)
        }
      }}
      onPointerCancel={() => {
        if (lp.current) clearTimeout(lp.current.timer)
        lp.current = null
      }}
      onContextMenu={(e) => {
        if (!actionable || (e.target as Element).closest('a, img, textarea')) return
        e.preventDefault()
        openMenu()
      }}
    >
      {!grouped ? (
        <span className={`chat-av${sms?.dir === 'in' ? ' client' : ''}`} aria-hidden="true">{initials(m.name)}</span>
      ) : (
        <time className="chat-av-gap" dateTime={new Date(m.created_at).toISOString()}>{clock(m.created_at, lang)}</time>
      )}
      <div className="chat-msg-body">
        {!grouped ? (
          <p className="chat-msg-meta">
            <b>{m.name || (mine ? me.name : '…')}</b>
            {sms ? <span className="chat-tag">{sms.dir === 'in' ? t.smsTagIn : t.smsTagOut}{sms.via !== 'sms' ? ` · ${sms.via}` : ''}</span> : null}
            <time dateTime={new Date(m.created_at).toISOString()} title={new Date(m.created_at).toLocaleString(lang === 'es' ? 'es-MX' : 'en-US')}>{m.pending ? t.sending : clock(m.created_at, lang)}</time>
            {m.pinned && !m.deleted ? <span className="chat-tag pin">📌 {t.pinnedM}</span> : null}
          </p>
        ) : m.pinned && !m.deleted ? (
          <span className="chat-tag pin">📌 {t.pinnedM}</span>
        ) : null}
        {m.deleted ? (
          <p className="chat-text gone">{t.deleted}</p>
        ) : ctx.editing === m.id ? (
          <EditBox ctx={ctx} m={m} />
        ) : (
          <>
            {!m.body && m.retry?.voice ? (
              <p className="chat-text chat-voice-local">🎤 {t.voiceNote} {fmtDur(m.retry.voice.duration)}</p>
            ) : null}
            {m.body ? (
              <p className={`chat-text${isJumbo(m.body) && !m.attachments.length ? ' jumbo' : ''}`}>
                <Body body={m.body} names={names} meName={me.name} />
                {m.edited_at ? <small className="chat-edited"> ({t.edited})</small> : null}
              </p>
            ) : null}
            {m.attachments.length ? (
              <div className="chat-att">
                {m.attachments.map((a) => (
                  <AttachmentView key={a.id} api={api} a={a} t={t} onError={actions.toast} />
                ))}
              </div>
            ) : null}
          </>
        )}
        {m.pending && grouped ? <small className="chat-state">{t.sending}</small> : null}
        {m.failed ? (
          <small className="chat-state bad" role="alert">
            {m.failed}{' '}
            <button type="button" className="chat-link-btn" onClick={() => void actions.send(m.channel, m.body, { parent: m.parent_id ?? undefined, sms: Boolean(m.client), retryOf: m })}>{t.retrySend}</button>{' '}
            <button type="button" className="chat-link-btn" onClick={() => actions.discard(m)}>{t.discard}</button>
          </small>
        ) : null}
        {reacts.length && !m.deleted ? (
          <span className="chat-reacts">
            {reacts.map(([emoji, uids]) => (
              <button
                key={emoji}
                type="button"
                className={uids.includes(me.uid) ? 'on' : ''}
                onClick={() => void run(() => actions.react(m, emoji))}
                aria-pressed={uids.includes(me.uid)}
                aria-label={`${emoji} ${uids.length}: ${names4(uids)}`}
                title={names4(uids)}
              >
                {emoji}<span>{uids.length}</span>
              </button>
            ))}
            {actionable ? (
              <button type="button" className="add" onClick={(e) => ctx.openPicker(e.currentTarget, (x) => void run(() => actions.react(m, x)))} aria-label={t.moreReact}>
                +😀
              </button>
            ) : null}
          </span>
        ) : null}
        {!inThread && !m.deleted && m.reply_count > 0 ? (
          <button type="button" className="chat-replies" onClick={() => actions.openThread(m)}>
            💬 {t.replies(m.reply_count)}
            {m.last_reply_at ? <small> · {t.lastReply} {relTime(m.last_reply_at, lang, now)}</small> : null}
          </button>
        ) : null}
      </div>
      {actionable ? (
        <div className="chat-tools" role="toolbar" aria-label={t.actions}>
          {QUICK.slice(0, 3).map((e) => (
            <button key={e} type="button" tabIndex={-1} onClick={() => void run(() => actions.react(m, e))} aria-label={`${t.react} ${e}`}>{e}</button>
          ))}
          <button type="button" tabIndex={-1} onClick={(e) => ctx.openPicker(e.currentTarget, (x) => void run(() => actions.react(m, x)))} aria-label={t.moreReact}>😀</button>
          {!inThread && !m.parent_id ? (
            <button type="button" tabIndex={-1} onClick={() => actions.openThread(m)} aria-label={t.reply}>💬</button>
          ) : null}
          <button type="button" className="more" onClick={openMenu} aria-label={t.actions} aria-haspopup="dialog">⋯</button>
        </div>
      ) : null}
      {tick ? <span className={`chat-tk${tick.all ? ' all' : ''}`} aria-hidden="true">{tick.double ? '✓✓' : '✓'}</span> : null}
    </article>
  )
}

/** Inline edit: Enter saves on a keyboard, Escape cancels; an empty edit is a cancel. */
function EditBox({ ctx, m }: { ctx: Ctx; m: Message }) {
  const { t, actions } = ctx
  const [draft, setDraft] = useState(m.body)
  const ta = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, (window.visualViewport?.height ?? window.innerHeight) * 0.35)}px`
  }, [draft])
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  async function save() {
    const v = draft.trim()
    if (!v || v === m.body) {
      ctx.setEditing(null)
      return
    }
    if (v.length > MAX_BODY) {
      actions.toast(t.tooLong)
      return
    }
    try {
      await actions.edit(m, v)
      ctx.setEditing(null)
    } catch (e) {
      actions.toast(e instanceof ChatError ? e.message : t.failed)
    }
  }
  return (
    <form
      className="chat-edit"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <textarea
        ref={ta}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        maxLength={4200}
        aria-label={t.edit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            ctx.setEditing(null)
          } else if (enterSends(e.nativeEvent, isCoarse() && isPhone())) {
            e.preventDefault()
            void save()
          }
        }}
      />
      <span>
        <button type="button" className="chat-btn ghost" onClick={() => ctx.setEditing(null)}>{t.cancel}</button>
        <button type="submit" className="chat-btn" disabled={!draft.trim()}>{t.save}</button>
      </span>
    </form>
  )
}

/** Message text: links open in a new tab (noopener), @mentions marked (mine stronger). No HTML is ever injected. */
function Body({ body, names, meName }: { body: string; names: Map<string, string>; meName: string }) {
  const segs = useMemo(() => segments(body, [...names.values()], meName), [body, names, meName])
  return (
    <>
      {segs.map((s, i) =>
        s.kind === 'link' ? (
          <a key={i} href={s.href} target="_blank" rel="noopener noreferrer">{s.text}</a>
        ) : s.kind === 'mention' ? (
          <mark key={i} className={s.me ? 'me' : ''}>{s.text}</mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  )
}

// ── Composer ────────────────────────────────────────────────────────────────

/** Drafts survive switching conversations (memory) and a reload (this browser). */
const drafts = new Map<string, string>()
function readDraft(key: string): string {
  if (drafts.has(key)) return drafts.get(key) ?? ''
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
function writeDraft(key: string, v: string) {
  drafts.set(key, v)
  try {
    if (v) window.localStorage.setItem(key, v)
    else window.localStorage.removeItem(key)
  } catch {
    // private mode: the in-memory copy still works this visit
  }
}

/** The directory, for @mentions in channels too big to list their members (shared, 60 s). */
let dirCache: { at: number; list: Person[]; p: Promise<Person[]> | null } = { at: 0, list: [], p: null }
function loadDirectory(api: ChatApi): Promise<Person[]> {
  if (Date.now() - dirCache.at < 60_000) return Promise.resolve(dirCache.list)
  if (!dirCache.p)
    dirCache.p = api
      .req<Person[] | { people?: Person[] }>('GET', '/api/directory')
      .then((r) => {
        const list = Array.isArray(r) ? r : r.people ?? []
        dirCache = { at: Date.now(), list, p: null }
        return list
      })
      .catch(() => {
        dirCache.p = null
        return dirCache.list
      })
  return dirCache.p
}

type FileEnt = { key: string; name: string; type: string; size: number; status: 'up' | 'ok' | 'err'; id?: string; preview?: string }

function Composer({
  api,
  t,
  lang,
  me,
  channel,
  mode,
  placeholder,
  actions,
  authors,
  dropRef,
  main,
  onSent,
  parent,
}: {
  api: ChatApi
  t: T
  lang: Lang
  me: Me
  channel: Channel
  mode: 'team' | 'sms'
  placeholder: string
  actions: ChatActions
  authors: Message[]
  dropRef: React.RefObject<((files: File[]) => void) | null>
  main?: boolean
  onSent: () => void
  parent?: string
}) {
  const sms = mode === 'sms'
  const dkey = main && !sms ? draftKey(me.uid, channel.id) : null
  const [text, setText] = useState(() => (dkey ? readDraft(dkey) : ''))
  const [files, setFiles] = useState<FileEnt[]>([])
  const [mq, setMq] = useState<{ q: string; start: number; end: number } | null>(null)
  const [sel, setSel] = useState(0)
  const [dir, setDir] = useState<Person[] | null>(null)
  const [emoji, setEmoji] = useState<HTMLElement | null>(null)
  const [slide, setSlide] = useState(false)
  const picked = useRef(new Map<string, string>())
  const lastTyping = useRef(0)
  const area = useRef<HTMLTextAreaElement>(null)
  const fileIn = useRef<HTMLInputElement>(null)
  const hold = useRef<{ x: number; id: number } | null>(null)
  const touchAt = useRef(0)
  // Where the caret goes after an insert, applied before the next keystroke can land.
  const nextCaret = useRef<number | null>(null)
  const len = text.length
  const cnt = counter(len)

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    if (nextCaret.current !== null) {
      el.setSelectionRange(nextCaret.current, nextCaret.current)
      nextCaret.current = null
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, (window.visualViewport?.height ?? window.innerHeight) * 0.35)}px`
  }, [text])

  // Keep the draft (debounced so typing stays smooth).
  useEffect(() => {
    if (!dkey) return
    drafts.set(dkey, text)
    const id = window.setTimeout(() => writeDraft(dkey, text), 400)
    return () => window.clearTimeout(id)
  }, [dkey, text])

  // Big channels list no members: mentions come from the directory.
  useEffect(() => {
    if (!mq || channel.members.length) return
    let live = true
    void loadDirectory(api).then((l) => live && setDir(l))
    return () => {
      live = false
    }
  }, [mq, channel.members.length, api])

  const items: MentionItem[] = useMemo(
    () =>
      mq && !sms
        ? mentionItems({ q: mq.q, members: channel.members, directory: dir, authors, meUid: me.uid, staff: me.staff, kind: channel.kind, lang })
        : [],
    [mq, sms, channel.members, channel.kind, dir, authors, me.uid, me.staff, lang],
  )
  const selIdx = items.length ? Math.min(sel, items.length - 1) : 0

  function checkMention(value: string, caret: number) {
    const at = sms ? null : mentionAt(value, caret)
    setMq(at ? { q: at.q, start: at.start, end: caret } : null)
    setSel(0)
  }

  function pickMention(u: MentionItem) {
    if (!mq) return
    const ins = `@${u.name} `
    const next = text.slice(0, mq.start) + ins + text.slice(mq.end)
    picked.current.set(u.uid, u.name)
    nextCaret.current = mq.start + ins.length
    setText(next)
    setMq(null)
    area.current?.focus()
  }

  function insertAt(s: string) {
    const el = area.current
    const a = el?.selectionStart ?? text.length
    const b = el?.selectionEnd ?? a
    nextCaret.current = a + s.length
    setText(text.slice(0, a) + s + text.slice(b))
    el?.focus()
  }

  const addFiles = useCallback(
    (list: File[]) => {
      if (sms || !list.length) return
      let room = MAX_FILES - files.length
      for (const file of list) {
        if (!isAllowedFile(file.type, file.name)) {
          actions.toast(t.badType)
          continue
        }
        if (room <= 0) {
          actions.toast(t.tooMany)
          break
        }
        room--
        const image = file.type.startsWith('image/')
        const ent: FileEnt = { key: `${Date.now()}${Math.random()}`, name: file.name || 'image.png', type: file.type, size: file.size, status: 'up', preview: image ? URL.createObjectURL(file) : undefined }
        setFiles((cur) => [...cur, ent])
        void (async () => {
          try {
            let f: File = file
            let w: number | undefined
            let h: number | undefined
            if (image) ({ file: f, w, h } = await prepImage(file))
            if (f.size > MAX_FILE) throw new ChatError(413, 'too_large', t.tooBig)
            const id = await actions.upload(channel.id, f, f.name || ent.name, w && h ? { w: String(w), h: String(h) } : {})
            setFiles((cur) => cur.map((x) => (x.key === ent.key ? { ...x, id, status: 'ok', size: f.size, name: f.name || x.name } : x)))
          } catch (e) {
            setFiles((cur) => cur.map((x) => (x.key === ent.key ? { ...x, status: 'err' } : x)))
            actions.toast(e instanceof ChatError ? e.message : t.uploadFail)
          }
        })()
      }
    },
    [sms, files.length, actions, channel.id, t],
  )

  useEffect(() => {
    dropRef.current = addFiles
    return () => {
      dropRef.current = null
    }
  }, [dropRef, addFiles])

  function dropFile(key: string) {
    setFiles((cur) => {
      const gone = cur.find((x) => x.key === key)
      if (gone?.preview) URL.revokeObjectURL(gone.preview)
      return cur.filter((x) => x.key !== key)
    })
  }

  // The upload happens inside the send: a failed one stays as a bubble with Retry / Discard.
  const sendVoice = (r: Recording) => {
    void actions.send(channel.id, '', { parent, voice: { blob: r.blob, name: voiceFileName(new Date(), r.type), duration: r.duration, wave: r.wave } })
    onSent()
  }
  const rec = useRecorder(sendVoice, (msg) => actions.toast(msg), t)
  const recording = rec.rec && rec.rec.state !== 'preview'
  const preview = rec.rec?.state === 'preview'

  function submit() {
    const body = text.replace(/\s+$/, '')
    if (sms) {
      if (!body.trim()) return
      if (body.length > SMS_MAX_BODY) {
        actions.toast(t.tooLong)
        return
      }
    } else {
      if (files.some((f) => f.status === 'up')) {
        actions.toast(t.waitUpload)
        return
      }
      const ok = files.filter((f) => f.status === 'ok' && f.id)
      if (!body.trim() && !ok.length) return
      if (body.length > MAX_BODY) {
        actions.toast(t.tooLong)
        return
      }
    }
    const ok = files.filter((f) => f.status === 'ok' && f.id)
    void actions.send(channel.id, body.trim(), { parent, attachments: sms ? [] : ok.map((f) => f.id!), sms, mentions: sms ? [] : pickedMentions(body, picked.current) })
    for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview)
    setText('')
    setFiles([])
    setMq(null)
    picked.current.clear()
    if (dkey) writeDraft(dkey, '')
    onSent()
    area.current?.focus()
  }

  const hasContent = Boolean(text.trim() || files.length)
  const canSend = (text.trim() || files.some((f) => f.status === 'ok')) && !files.some((f) => f.status === 'up') && len <= (sms ? SMS_MAX_BODY : MAX_BODY)
  const showMic = !sms && !hasContent && canRecord()
  const micLabel = rec.rec?.mode === 'tap' && recording ? t.stopLbl : typeof window !== 'undefined' && isCoarse() ? t.recHoldLbl : t.recLbl

  return (
    <form
      className={`chat-compose${sms ? ' sms' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {sms ? <p className="chat-sms-note">{t.smsNote}</p> : null}
      {items.length ? (
        <div className="chat-mentions" role="listbox" aria-label="Mention" onMouseDown={(e) => e.preventDefault()}>
          {items.map((u, i) => (
            <button key={`${u.uid}-${u.name}`} type="button" role="option" aria-selected={i === selIdx} className={i === selIdx ? 'on' : ''} onClick={() => pickMention(u)}>
              <span className="chat-av sm" aria-hidden="true">{u.special ? '@' : initials(u.name)}</span>
              <span className="chat-mo-name">{u.special ? `@${u.name}` : u.name}</span>
              <small>{u.special ? t.everyone : u.role ?? ''}</small>
            </button>
          ))}
        </div>
      ) : null}
      {files.length ? (
        <div className="chat-tray">
          {files.map((f) => (
            <div key={f.key} className={`chat-chipf ${f.status}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: preview of the picked file */}
              {f.preview ? <img src={f.preview} alt="" /> : <span className="fi">PDF</span>}
              <span>
                {f.name}
                <small>{f.status === 'up' ? t.sending : f.status === 'err' ? t.uploadFail : fmtSize(f.size)}</small>
              </span>
              <button type="button" aria-label={`${t.remove} ${f.name}`} onClick={() => dropFile(f.key)}>✕</button>
            </div>
          ))}
        </div>
      ) : null}
      <div className={`chat-compose-row${recording ? ' recmode' : ''}${preview ? ' preview' : ''}`}>
        {rec.rec ? (
          <div className={`chat-rec${slide ? ' cancel' : ''}`} role="status">
            {preview && rec.rec.url ? (
              <>
                <button type="button" className="chat-icon" onClick={rec.cancel} aria-label={t.discardV}>🗑</button>
                <VoicePlayer aid="pv" dur={rec.rec.dur ?? 0} wave={rec.rec.wave} getUrl={() => Promise.resolve(rec.rec!.url!)} t={t} onError={actions.toast} />
                <button type="button" className="chat-send icon" onClick={rec.sendPreview} aria-label={t.sendV}><SendIcon /></button>
              </>
            ) : (
              <>
                {rec.rec.mode === 'tap' ? <button type="button" className="chat-icon" onClick={rec.cancel} aria-label={t.discardV}>🗑</button> : null}
                <span className="chat-rec-dot" aria-hidden="true" />
                <span className="chat-rtime">{fmtDur(Math.floor(rec.rec.elapsed))}</span>
                <span className="chat-rlev" aria-hidden="true">
                  {rec.rec.levels.map((v, i) => (
                    <i key={i} style={{ height: Math.max(3, Math.round(v * 28)) }} />
                  ))}
                </span>
                {rec.rec.mode === 'hold' ? <span className="chat-rhint">{slide ? t.releaseCancel : t.slideCancel}</span> : null}
              </>
            )}
          </div>
        ) : null}
        {!sms ? (
          <>
            <button type="button" className="chat-icon" onClick={() => fileIn.current?.click()} aria-label={t.attach} title={t.attach}>📎</button>
            <input
              ref={fileIn}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
          </>
        ) : null}
        <label className="chat-input">
          <span className="sr">{placeholder}</span>
          <textarea
            ref={area}
            value={text}
            rows={1}
            maxLength={sms ? SMS_MAX_BODY : 4200}
            placeholder={placeholder}
            enterKeyHint="send"
            onChange={(e) => {
              setText(e.target.value)
              checkMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
              if (!sms && e.target.value.trim() && Date.now() - lastTyping.current > 3000) {
                lastTyping.current = Date.now()
                actions.typing(channel.id)
              }
            }}
            onSelect={(e) => {
              const el = e.currentTarget
              if (mq) checkMention(el.value, el.selectionStart ?? 0)
            }}
            onBlur={() => window.setTimeout(() => setMq(null), 150)}
            onPaste={(e) => {
              const fs = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => Boolean(f))
              if (fs.length && !sms) {
                e.preventDefault()
                addFiles(fs)
              }
            }}
            onKeyDown={(e) => {
              if (items.length) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSel((selIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  pickMention(items[selIdx])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setMq(null)
                  return
                }
              }
              if (enterSends(e.nativeEvent, isCoarse() && isPhone())) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </label>
        <button type="button" className="chat-icon emo" onClick={(e) => setEmoji(emoji ? null : e.currentTarget)} aria-label={t.emojiT} title={t.emojiT}>😀</button>
        {showMic || recording ? (
          <button
            type="button"
            className={`chat-send voice${rec.rec ? ' on' : ''}`}
            aria-label={micLabel}
            title={micLabel}
            onPointerDown={(e) => {
              if (e.pointerType === 'mouse' || e.button > 0) return
              e.preventDefault()
              touchAt.current = Date.now()
              if (rec.rec) return
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                // capture is a nicety: the slide still works inside the button
              }
              hold.current = { x: e.clientX, id: e.pointerId }
              setSlide(false)
              void rec.start('hold')
            }}
            onPointerMove={(e) => {
              const h = hold.current
              if (!h || e.pointerId !== h.id) return
              const dx = e.clientX - h.x
              setSlide(dx < -40)
              if (dx < -110) {
                hold.current = null
                setSlide(false)
                rec.stop('cancel')
              }
            }}
            onPointerUp={(e) => {
              const h = hold.current
              if (!h || e.pointerId !== h.id) return
              hold.current = null
              touchAt.current = Date.now()
              const slid = slide
              setSlide(false)
              if (rec.releaseEarly()) return
              rec.stop(slid ? 'cancel' : 'send')
            }}
            onPointerCancel={(e) => {
              const h = hold.current
              if (!h || e.pointerId !== h.id) return
              hold.current = null
              setSlide(false)
              rec.stop('cancel')
            }}
            onContextMenu={(e) => e.preventDefault()}
            onClick={() => {
              if (Date.now() - touchAt.current < 700) return
              if (rec.rec?.mode === 'tap' && recording) rec.stop('preview')
              else if (!rec.rec) void rec.start('tap')
            }}
          >
            {rec.rec?.mode === 'tap' && recording ? '■' : '🎤'}
          </button>
        ) : (
          <button type="submit" className="chat-send icon" disabled={!canSend} aria-label={t.send} title={t.send}>
            <SendIcon />
          </button>
        )}
      </div>
      <div className="chat-hint">
        <span className="kb">{t.kbHint}</span>
        <span className={`len${cnt.over ? ' over' : ''}`} aria-live="polite">{sms ? (len > SMS_MAX_BODY - 200 ? `${len}/${SMS_MAX_BODY}` : '') : cnt.text}</span>
      </div>
      {emoji ? (
        <EmojiPicker
          anchor={emoji}
          title={t.emojiT}
          onClose={() => setEmoji(null)}
          onPick={(e) => {
            setEmoji(null)
            insertAt(e)
          }}
        />
      ) : null}
    </form>
  )
}

const SendIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width="20" height="20"><path d="M3.4 20.4 21 12 3.4 3.6l-.01 6.53L15 12 3.39 13.87z" /></svg>
)

function ThreadPane({
  ctx,
  thread,
  dropRef,
  dragHandlers,
}: {
  ctx: Ctx
  thread: { root: string; list: Message[] }
  dropRef: React.RefObject<((files: File[]) => void) | null>
  dragHandlers: Record<string, (e: React.DragEvent) => void>
}) {
  const { api, t, lang, me, channel, actions } = ctx
  const box = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const root = thread.list.find((m) => m.id === thread.root) ?? null
  const replies = thread.list.filter((m) => m.id !== thread.root)
  useLayoutEffect(() => {
    const el = box.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [thread.list.length])
  return (
    <aside
      className="chat-threadpane"
      aria-label={t.thread}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) actions.openThread(null)
      }}
      {...dragHandlers}
    >
      <header className="chat-head">
        <button type="button" className="chat-back always" onClick={() => actions.openThread(null)} aria-label={t.closeThread}>‹</button>
        <div className="chat-who">
          <h2>{t.thread}</h2>
          <span>{channelLabel(channel)}</span>
        </div>
        <button type="button" className="chat-icon desk-only" onClick={() => actions.openThread(null)} aria-label={t.closeThread}>×</button>
      </header>
      <div
        className="chat-scroll"
        ref={box}
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        {root ? (
          <>
            <div className="chat-thr-root">
              <MessageItem ctx={ctx} m={root} grouped={false} inThread />
            </div>
            <p className="chat-thr-cnt">{t.replies(replies.length || root.reply_count || 0)}</p>
          </>
        ) : null}
        {replies.map((m, i) => (
          <MessageItem key={m.id} ctx={ctx} m={m} grouped={groupsWith(replies[i - 1] ?? null, m)} inThread />
        ))}
      </div>
      {channel.can_post ? (
        <Composer api={api} t={t} lang={lang} me={me} channel={channel} mode="team" placeholder={t.placeholderThread} actions={actions} authors={thread.list} dropRef={dropRef} onSent={() => (atBottom.current = true)} parent={thread.root} />
      ) : null}
    </aside>
  )
}
