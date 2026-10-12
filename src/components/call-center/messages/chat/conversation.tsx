'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatApi } from './api'
import { ChatError } from './api'
import { channelLabel, clock, fmtDur, initials, insertMention, mentionQuery, rowsFor, seenCount, fold } from './format'
import { AttachmentView, useRecorder, type Recording } from './media'
import type { T } from './strings'
import type { ChatActions } from './team-chat'
import type { Channel, Lang, Me, Message } from './types'

type Pane = { list: Message[]; hasMore: boolean; reads: Record<string, string>; loaded: boolean }
const QUICK = ['👍', '✅', '🔥', '🙏', '😂', '❤️']

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

export function Conversation({ api, t, lang, me, channel, pane, thread, typing, online, actions, onBack, onPins, onSearch, onDetails }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  const [lastRead] = useState(channel.last_read_msg_id)
  const [mode, setMode] = useState<'team' | 'sms'>('team')
  const [now, setNow] = useState(() => Date.now())
  const rows = useMemo(() => rowsFor(pane.list, lang, lastRead, me.uid, now), [pane.list, lang, lastRead, me.uid, now])
  const isCase = Boolean(channel.case)
  const canSms = Boolean(channel.case?.phone4) && !channel.case?.closed
  const others = channel.members.filter((m) => m.uid !== me.uid)
  const onlineCount = others.filter((m) => online[m.uid] ?? m.online).length

  // Typing lines expire after 4 s; a tick also keeps day labels honest past midnight.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 2000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (el && stick) el.scrollTop = el.scrollHeight
  }, [pane.list.length, stick, pane.loaded])

  const typers = Object.entries(typing).filter(([uid, v]) => uid !== me.uid && now - v.at < 4000)
  const lastMine = [...pane.list].reverse().find((m) => m.uid === me.uid && !m.pending && !m.deleted)
  const seen = lastMine ? seenCount(pane.reads, lastMine.id, me.uid) : 0

  return (
    <div className="chat-conv">
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
      <div
        className="chat-scroll"
        ref={scroller}
        role="log"
        aria-live="off"
        aria-label={channelLabel(channel)}
        onScroll={(e) => {
          const el = e.currentTarget
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
        }}
      >
        {pane.hasMore ? (
          <button type="button" className="chat-older" onClick={() => void actions.loadOlder(channel.id).catch(() => actions.toast(t.failed))}>
            {t.older}
          </button>
        ) : null}
        {pane.loaded && rows.length === 0 ? <p className="chat-empty">{t.empty}</p> : null}
        {!pane.loaded ? <p className="chat-empty" aria-busy="true">{t.loading}</p> : null}
        {rows.map((r) =>
          r.kind === 'day' ? (
            <div key={`d-${r.key}`} className="chat-day"><span>{r.label}</span></div>
          ) : r.kind === 'new' ? (
            <div key={r.key} className="chat-new"><span>{t.newDivider}</span></div>
          ) : (
            <MessageItem key={r.message.id} api={api} t={t} lang={lang} me={me} m={r.message} grouped={r.grouped} actions={actions} inThread={false} />
          ),
        )}
        {lastMine && seen > 0 && channel.kind !== 'main' ? <p className="chat-seen">{t.seenBy(seen)}</p> : null}
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
          t={t}
          me={me}
          channel={channel}
          mode={isCase ? mode : 'team'}
          placeholder={mode === 'sms' ? t.placeholderSms : t.placeholder(channelLabel(channel))}
          actions={actions}
          onSent={() => setStick(true)}
        />
      ) : (
        <p className="chat-compose chat-compose-off">{t.readOnly}</p>
      )}
      {thread ? <ThreadPane api={api} t={t} lang={lang} me={me} channel={channel} thread={thread} actions={actions} /> : null}
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

function MessageItem({ api, t, lang, me, m, grouped, actions, inThread }: { api: ChatApi; t: T; lang: Lang; me: Me; m: Message; grouped: boolean; actions: ChatActions; inThread: boolean }) {
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.body)
  const mine = m.uid === me.uid
  const sms = m.client
  // The 24 h edit window is the Worker's to enforce; a late edit comes back with its plain reason.
  const canEdit = mine && !m.deleted && !sms && m.kind === 'message' && !m.pending
  const canDelete = (mine || me.staff) && !m.deleted && !m.pending && !sms
  const reacts = Object.entries(m.reactions ?? {}).filter(([, uids]) => uids.length)

  async function run(fn: () => Promise<void>) {
    setMenu(false)
    try {
      await fn()
    } catch (e) {
      actions.toast(e instanceof ChatError ? e.message : t.failed)
    }
  }

  return (
    <article data-id={m.id} className={`chat-msg${grouped ? ' grouped' : ''}${mine ? ' mine' : ''}${sms ? ` sms sms-${sms.dir}` : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}${m.pinned ? ' pinned' : ''}`} aria-label={`${m.name}, ${clock(m.created_at, lang)}`}>
      {!grouped ? <span className={`chat-av${sms?.dir === 'in' ? ' client' : ''}`} aria-hidden="true">{initials(m.name)}</span> : <span className="chat-av-gap" aria-hidden="true" />}
      <div className="chat-msg-body">
        {!grouped ? (
          <p className="chat-msg-meta">
            <b>{mine ? t.you : m.name}</b>
            <time>{clock(m.created_at, lang)}</time>
            {sms ? <span className="chat-tag">{sms.dir === 'in' ? t.smsTagIn : t.smsTagOut}{sms.via !== 'sms' ? ` · ${sms.via}` : ''}</span> : null}
            {m.pinned ? <span className="chat-tag pin">📌</span> : null}
          </p>
        ) : null}
        {m.deleted ? (
          <p className="chat-text gone">{t.deleted}</p>
        ) : editing ? (
          <form
            className="chat-edit"
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () => {
                await actions.edit(m, draft.trim())
                setEditing(false)
              })
            }}
          >
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} maxLength={4000} aria-label={t.edit} autoFocus />
            <span>
              <button type="button" className="chat-btn ghost" onClick={() => setEditing(false)}>{t.cancel}</button>
              <button type="submit" className="chat-btn" disabled={!draft.trim()}>{t.save}</button>
            </span>
          </form>
        ) : (
          <>
            {m.body ? <p className="chat-text"><Highlighted body={m.body} meName={me.name} />{m.edited_at ? <small className="chat-edited"> ({t.edited})</small> : null}</p> : null}
            {m.attachments.map((a) => (
              <AttachmentView key={a.id} api={api} a={a} t={t} />
            ))}
          </>
        )}
        {m.pending ? <small className="chat-state">{t.sending}</small> : null}
        {m.failed ? (
          <small className="chat-state bad" role="alert">
            {m.failed}{' '}
            <button type="button" className="chat-link-btn" onClick={() => void actions.send(m.channel, m.body, { parent: m.parent_id ?? undefined, sms: Boolean(m.client), retryOf: m })}>{t.retrySend}</button>{' '}
            <button type="button" className="chat-link-btn" onClick={() => actions.discard(m)}>{t.discard}</button>
          </small>
        ) : null}
        {reacts.length ? (
          <span className="chat-reacts">
            {reacts.map(([emoji, uids]) => (
              <button key={emoji} type="button" className={uids.includes(me.uid) ? 'on' : ''} onClick={() => void run(() => actions.react(m, emoji))} aria-pressed={uids.includes(me.uid)} aria-label={`${emoji} ${uids.length}`}>
                {emoji} {uids.length}
              </button>
            ))}
          </span>
        ) : null}
        {!inThread && m.reply_count > 0 ? (
          <button type="button" className="chat-replies" onClick={() => actions.openThread(m)}>{t.replies(m.reply_count)} ›</button>
        ) : null}
      </div>
      {!m.deleted && !m.pending && !m.failed ? (
        <div className={`chat-actions${menu ? ' open' : ''}`}>
          <button type="button" className="chat-icon sm" onClick={() => setMenu((v) => !v)} aria-label={t.more} aria-expanded={menu}>⋯</button>
          {menu ? (
            <div className="chat-menu" role="menu">
              <span className="chat-menu-quick">
                {QUICK.map((e) => (
                  <button key={e} type="button" role="menuitem" onClick={() => void run(() => actions.react(m, e))} aria-label={`${t.react} ${e}`}>{e}</button>
                ))}
              </span>
              {!inThread && !sms ? <button type="button" role="menuitem" onClick={() => { setMenu(false); actions.openThread(m) }}>{t.reply}</button> : null}
              {canEdit ? <button type="button" role="menuitem" onClick={() => { setMenu(false); setDraft(m.body); setEditing(true) }}>{t.edit}</button> : null}
              {!inThread ? <button type="button" role="menuitem" onClick={() => void run(() => actions.pin(m))}>{m.pinned ? t.unpin : t.pin}</button> : null}
              {m.body ? <button type="button" role="menuitem" onClick={() => { setMenu(false); void navigator.clipboard?.writeText(m.body) }}>{t.copy}</button> : null}
              {canDelete ? (
                <button type="button" role="menuitem" className="bad" onClick={() => { if (window.confirm(t.delConfirm)) void run(() => actions.remove(m)) }}>{t.del}</button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

/** Bold "@Name" when it is me; links stay plain text (no HTML is ever injected). */
function Highlighted({ body, meName }: { body: string; meName: string }) {
  const first = fold(meName.split(' ')[0] ?? '')
  const parts = body.split(/(@[\p{L}\p{N}_.]+(?:\s[\p{Lu}][\p{L}.]*)?)/u)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('@') ? (
          <mark key={i} className={fold(p).startsWith('@' + first) ? 'me' : ''}>{p}</mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

function Composer({ t, me, channel, mode, placeholder, actions, onSent, parent }: { t: T; me: Me; channel: Channel; mode: 'team' | 'sms'; placeholder: string; actions: ChatActions; onSent: () => void; parent?: string }) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [files, setFiles] = useState<Array<{ id: string; name: string }>>([])
  const [busy, setBusy] = useState(false)
  const lastTyping = useRef(0)
  const area = useRef<HTMLTextAreaElement>(null)
  // Where the caret goes after a mention is inserted, applied before the next keystroke can land.
  const nextCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (nextCaret.current === null || !area.current) return
    area.current.setSelectionRange(nextCaret.current, nextCaret.current)
    nextCaret.current = null
  })
  const sms = mode === 'sms'
  const q = sms ? null : mentionQuery(text, caret)
  const options = q === null ? [] : channel.members.filter((p) => p.uid !== me.uid && fold(p.name).includes(fold(q))).slice(0, 6)
  const sendVoice = async (r: Recording) => {
    setBusy(true)
    try {
      const ext = r.type.includes('mp4') ? 'm4a' : 'webm'
      const id = await actions.upload(channel.id, r.blob, `voice.${ext}`, { kind: 'voice', duration: String(r.duration), wave: r.wave })
      await actions.send(channel.id, '', { parent, attachments: [id] })
      onSent()
    } catch (e) {
      actions.toast(e instanceof ChatError ? e.message : t.failed)
    } finally {
      setBusy(false)
    }
  }
  const rec = useRecorder(
    (r: Recording) => void sendVoice(r),
    (msg) => actions.toast(msg),
    t,
  )

  async function attach(list: FileList | null) {
    if (!list?.length) return
    setBusy(true)
    try {
      for (const f of [...list].slice(0, 5)) {
        const dims = f.type.startsWith('image/') ? await imageSize(f) : null
        const id = await actions.upload(channel.id, f, f.name, dims ? { w: String(dims.w), h: String(dims.h) } : {})
        setFiles((cur) => [...cur, { id, name: f.name }])
      }
    } catch (e) {
      actions.toast(e instanceof ChatError ? e.message : t.failed)
    } finally {
      setBusy(false)
    }
  }

  function submit() {
    const body = text.trim()
    if ((!body && !files.length) || busy) return
    void actions.send(channel.id, body, { parent, attachments: files.map((f) => f.id), sms })
    setText('')
    setFiles([])
    onSent()
    area.current?.focus()
  }

  return (
    <form
      className={`chat-compose${sms ? ' sms' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {sms ? <p className="chat-sms-note">{t.smsNote}</p> : null}
      {options.length ? (
        <ul className="chat-mentions" role="listbox" aria-label="Mention">
          {options.map((p) => (
            <li key={p.uid}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => {
                  const next = insertMention(text, caret, p.name)
                  nextCaret.current = next.caret
                  setText(next.text)
                  setCaret(next.caret)
                  area.current?.focus()
                }}
              >
                <span className="chat-av sm" aria-hidden="true">{initials(p.name)}</span>
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {files.length ? (
        <p className="chat-files">
          {files.map((f) => (
            <span key={f.id} className="chat-chip">
              📎 {f.name}
              <button type="button" aria-label={`${t.discard} ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))}>×</button>
            </span>
          ))}
        </p>
      ) : null}
      {rec.rec ? (
        <div className="chat-rec" role="status">
          <span className="chat-rec-dot" style={{ opacity: 0.4 + rec.rec.level * 0.6 }} aria-hidden="true" />
          <span>{fmtDur(rec.rec.elapsed)}</span>
          <button type="button" className="chat-btn ghost" onClick={rec.cancel}>{t.cancel}</button>
          <button type="button" className="chat-btn" onClick={rec.stop}>{t.stop}</button>
        </div>
      ) : (
        <div className="chat-compose-row">
          {!sms ? (
            <label className="chat-icon" title={t.attach}>
              <span className="sr">{t.attach}</span>
              <input type="file" accept="image/*,application/pdf" multiple onChange={(e) => { void attach(e.target.files); e.target.value = '' }} hidden />
              <span aria-hidden="true">📎</span>
            </label>
          ) : null}
          <label className="chat-input">
            <span className="sr">{placeholder}</span>
            <textarea
              ref={area}
              value={text}
              rows={1}
              maxLength={sms ? 1500 : 4000}
              placeholder={placeholder}
              onChange={(e) => {
                setText(e.target.value)
                setCaret(e.target.selectionStart ?? e.target.value.length)
                if (!sms && Date.now() - lastTyping.current > 3000) {
                  lastTyping.current = Date.now()
                  actions.typing(channel.id)
                }
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
                  e.preventDefault()
                  if (options.length) {
                    const next = insertMention(text, caret, options[0].name)
                    nextCaret.current = next.caret
                    setText(next.text)
                    setCaret(next.caret)
                  } else submit()
                }
              }}
            />
          </label>
          {!text.trim() && !files.length && !sms ? (
            <button type="button" className="chat-send voice" onClick={() => void rec.start()} aria-label={t.record} title={t.record} disabled={busy}>🎤</button>
          ) : (
            <button type="submit" className="chat-send" disabled={busy || (!text.trim() && !files.length)}>{busy ? t.sending : t.send}</button>
          )}
        </div>
      )}
    </form>
  )
}

function imageSize(f: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f)
    const img = new Image()
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      resolve(null)
      URL.revokeObjectURL(url)
    }
    img.src = url
  })
}

function ThreadPane({ api, t, lang, me, channel, thread, actions }: { api: ChatApi; t: T; lang: Lang; me: Me; channel: Channel; thread: { root: string; list: Message[] }; actions: ChatActions }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [thread.list.length])
  return (
    <aside className="chat-threadpane" aria-label={t.thread}>
      <header className="chat-head">
        <button type="button" className="chat-back always" onClick={() => actions.openThread(null)} aria-label={t.closeThread}>‹</button>
        <div className="chat-who">
          <h2>{t.thread}</h2>
          <span>{channelLabel(channel)}</span>
        </div>
        <button type="button" className="chat-icon desk-only" onClick={() => actions.openThread(null)} aria-label={t.closeThread}>×</button>
      </header>
      <div className="chat-scroll" role="log" aria-live="polite">
        {thread.list.map((m) => (
          <MessageItem key={m.id} api={api} t={t} lang={lang} me={me} m={m} grouped={false} actions={actions} inThread />
        ))}
        <div ref={end} />
      </div>
      {channel.can_post ? <Composer t={t} me={me} channel={channel} mode="team" placeholder={t.placeholderThread} actions={actions} onSent={() => undefined} parent={thread.root} /> : null}
    </aside>
  )
}
