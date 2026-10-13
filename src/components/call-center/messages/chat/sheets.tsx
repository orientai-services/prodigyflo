'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatApi } from './api'
import { ChatError } from './api'
import { channelLabel, groupPeople, listTime } from './format'
import { Face } from './face'
import type { T } from './strings'
import type { Channel, FlaggedAnswer, Lang, Message, Person, SearchHit } from './types'
import { useSheet } from '../../native/use-sheet'

/** Where a search, pin or flag result leads: the message in its channel, or inside its thread. */
export type Goto = { channel: string; id: string; parent: string | null }

/** Bottom sheets on phones, centered dialogs on desktop (docs/MOBILE.md). */
export function Sheet({ title, kicker, sub, foot, onClose, children }: { title: string; kicker?: string; sub?: ReactNode; foot?: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useSheet(ref, onClose)
  // No close() in a cleanup: it fires `close`, which would unmount the sheet on React's dev double-mount.
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  return (
    <dialog ref={ref} className="chat-sheet" aria-label={title} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}
      onKeyDown={(e) => {
        // A search field eats the first Escape (it clears itself); the sheet closes on it anyway.
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="chat-sheet-in">
        <header>
          <div className="chat-sheet-title">
            {kicker ? <small>{kicker}</small> : null}
            <h2>{title}</h2>
          </div>
          <button type="button" className="chat-icon" onClick={onClose} aria-label="Close">×</button>
        </header>
        {sub ? <div className="chat-sheet-sub">{sub}</div> : null}
        {children}
        {foot ? <div className="chat-sheet-foot">{foot}</div> : null}
      </div>
    </dialog>
  )
}

/** A yes/no question over everything (delete, archive, leave). */
export function ConfirmSheet({ t, title, body, yes, onAnswer }: { t: T; title: string; body: string; yes: string; onAnswer: (yes: boolean) => void }) {
  return (
    <Sheet title={title} onClose={() => onAnswer(false)}
      foot={
        <>
          <button type="button" className="chat-btn ghost" onClick={() => onAnswer(false)} autoFocus>{t.cancel}</button>
          <button type="button" className="chat-btn danger" onClick={() => onAnswer(true)}>{yes}</button>
        </>
      }
    >
      <p className="chat-note-p">{body}</p>
    </Sheet>
  )
}

/** The searched words marked inside a snippet (text only, never HTML). */
function Marked({ text, q }: { text: string; q: string }) {
  const term = q.trim()
  if (!term) return <>{text}</>
  const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig')
  return <>{text.split(re).map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}</>
}

function ResultButton({ m, where, snippet, q, lang, tag, onGoto }: { m: Pick<Message, 'id' | 'name' | 'created_at' | 'parent_id' | 'body'>; where: { id: string; label: string } | null; snippet: string; q: string; lang: Lang; tag?: string | null; onGoto: (g: Goto) => void }) {
  return (
    <button type="button" onClick={() => where && onGoto({ channel: where.id, id: m.id, parent: m.parent_id })}>
      <small>
        {where?.label ? <>{where.label} · </> : null}
        <b>{m.name}</b> · {listTime(m.created_at, lang)}
        {tag ? <em className="chat-flag">{tag}</em> : null}
      </small>
      <span>{snippet ? <Marked text={snippet} q={q} /> : '📎'}</span>
    </button>
  )
}

const kindLabel = (c: { kind: string | null; name: string }) => (c.kind === 'dm' || c.kind === 'group' ? c.name : `#${c.name}`)

/** Message search: everywhere, or inside one channel (🔍 in the header). Results jump to the message or its thread. */
export function SearchSheet({ api, t, lang, scope, initial = '', onClose, onGoto }: { api: ChatApi; t: T; lang: Lang; scope: Channel | null; initial?: string; onClose: () => void; onGoto: (g: Goto) => void }) {
  const [q, setQ] = useState(initial)
  const [ran, setRan] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(term: string) {
    const v = term.trim()
    if (v.length < 2) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.req<{ results: SearchHit[] }>('GET', `/api/search?q=${encodeURIComponent(v)}${scope ? `&channel=${encodeURIComponent(scope.id)}` : ''}`)
      setHits(r.results)
      setRan(v)
    } catch (e) {
      setError(e instanceof ChatError ? e.message : t.failed)
    } finally {
      setBusy(false)
    }
  }
  // Type to search (a pause runs it); Enter or the button runs it now.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2 || term === ran) return
    const id = window.setTimeout(() => void run(term), initial && !ran ? 0 : 300)
    return () => window.clearTimeout(id)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sheet title={scope ? t.searchIn : t.search} kicker={scope ? channelLabel(scope) : undefined} onClose={onClose}
      sub={
        <form className="chat-sheet-row" role="search" onSubmit={(e) => { e.preventDefault(); void run(q) }}>
          <label className="chat-filter">
            <span className="sr">{t.searchPh}</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.searchPh} autoFocus autoComplete="off" enterKeyHint="search" />
          </label>
          <button type="submit" className="chat-btn" disabled={busy || q.trim().length < 2}>{t.searchGo}</button>
        </form>
      }
    >
      <div aria-live="polite" aria-busy={busy}>
        {busy && !hits ? <Skeleton rows={2} /> : null}
        {error ? <p className="chat-error" role="alert">{error}</p> : null}
        {hits && hits.length === 0 && !busy ? <p className="chat-empty">{t.noResults}</p> : null}
        <ul className="chat-hits">
          {(hits ?? []).map((h) => (
            <li key={h.message.id}>
              <ResultButton m={h.message} where={scope ? { id: h.channel.id, label: '' } : { id: h.channel.id, label: kindLabel(h.channel) }} snippet={h.snippet || h.message.body} q={ran} lang={lang} onGoto={onGoto} />
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  )
}

/**
 * New message (or "Add people" to a group). With nobody picked yet, tapping a person opens the DM straight away;
 * the round check on the right builds a group (2–50 people with me, optional name). People come grouped as the
 * SunOff picker shows them: above you, your downline, same team, staff.
 */
export function NewChatSheet({ api, t, mode = 'new', channel, onClose, onCreated, onAdded }: { api: ChatApi; t: T; mode?: 'new' | 'add'; channel?: Channel | null; onClose: () => void; onCreated?: (c: Channel) => void; onAdded?: (c: Channel) => void }) {
  const [q, setQ] = useState('')
  const [people, setPeople] = useState<Person[] | null>(null)
  const [picked, setPicked] = useState<Person[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void api.req<Person[]>('GET', '/api/directory').then(setPeople, (e) => {
      setPeople([])
      setError(e instanceof ChatError ? e.message : t.failed)
    })
  }, [api, t.failed])
  const exclude = new Set((channel?.members ?? []).map((m) => m.uid))
  const groups = people ? groupPeople(people, q, exclude) : []
  const max = 49 - (mode === 'add' ? Math.max(0, (channel?.member_count ?? 1) - 1) : 0)
  const toggle = (p: Person) =>
    setPicked((cur) => {
      if (cur.some((x) => x.uid === p.uid)) return cur.filter((x) => x.uid !== p.uid)
      if (cur.length >= max) {
        setError(t.groupMax)
        return cur
      }
      return [...cur, p]
    })
  async function go(list: Person[]) {
    if (!list.length) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'add' && channel) {
        const r = await api.req<{ channel: Channel }>('POST', `/api/channels/${channel.id}/members`, { add: list.map((p) => p.uid) })
        onAdded?.(r.channel)
        return
      }
      const body = list.length === 1 ? { kind: 'dm', uids: [list[0].uid] } : { kind: 'group', uids: list.map((p) => p.uid), ...(name.trim() ? { name: name.trim() } : {}) }
      const r = await api.req<{ channel: Channel }>('POST', '/api/channels', body)
      onCreated?.(r.channel)
    } catch (e) {
      setError(e instanceof ChatError ? e.message : t.failed)
    } finally {
      setBusy(false)
    }
  }
  const label = !picked.length ? t.pickSomeone : mode === 'add' ? t.addN(picked.length) : t.msgN(picked.length)
  return (
    <Sheet title={mode === 'add' ? t.addPeople : t.newChat} kicker={mode === 'add' && channel ? channelLabel(channel) : t.newK} onClose={onClose}
      sub={
        <>
          <label className="chat-filter">
            <span className="sr">{t.dirSearch}</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.dirSearch} autoFocus autoComplete="off" enterKeyHint="search"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                const all = groups.flatMap((g) => g.people)
                if (all.length === 1 && !picked.length && mode === 'new') void go(all)
              }}
            />
          </label>
          {picked.length ? (
            <p className="chat-files">
              {picked.map((p) => (
                <span key={p.uid} className="chat-chip">
                  {p.name}
                  <button type="button" onClick={() => toggle(p)} aria-label={`${t.remove} ${p.name}`}>×</button>
                </span>
              ))}
            </p>
          ) : null}
        </>
      }
      foot={
        <>
          {mode === 'new' && picked.length > 1 ? (
            <label className="chat-filter chat-foot-full">
              <span className="sr">{t.groupName}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.groupName} maxLength={60} />
            </label>
          ) : null}
          <button type="button" className="chat-btn ghost" onClick={onClose}>{t.cancel}</button>
          <button type="button" className="chat-btn" disabled={!picked.length || busy} onClick={() => void go(picked)}>{label}</button>
        </>
      }
    >
      {!people ? <Skeleton rows={3} /> : null}
      {people && people.length === 0 && !error ? <p className="chat-note-p">{t.dirEmpty}</p> : null}
      {people && people.length > 0 && groups.length === 0 ? <p className="chat-empty">{t.noMatch}</p> : null}
      {groups.map((g) => (
        <section key={g.rel} className="chat-pgroup">
          <h3>{t.rel[g.rel] ?? t.rel.team}</h3>
          <ul className="chat-people">
            {g.people.map((p) => {
              const on = picked.some((x) => x.uid === p.uid)
              const kind = p.staff ? 'staff' : p.relation
              const pill = t.relPill[kind]
              return (
                <li key={p.uid} className={`chat-prow${on ? ' on' : ''}`}>
                  <button type="button" className="chat-prow-main" onClick={() => (mode === 'new' && !picked.length ? void go([p]) : toggle(p))} disabled={busy}>
                    <Face name={p.name} avatar={p.avatar}><i className={`chat-dot${p.online ? ' on' : ''}`} /></Face>
                    <span className="chat-row-main">
                      <b>{p.name}</b>
                      <span className="chat-snip">{[t.role[p.role] ?? p.role, p.team?.name ? `${p.team.badge?.emoji ? `${p.team.badge.emoji} ` : ''}${p.team.name}` : '', p.online ? t.online : ''].filter(Boolean).join(' · ')}</span>
                    </span>
                    {pill ? <span className={`chat-rel rel-${kind}`}>{pill}</span> : null}
                  </button>
                  <button type="button" className="chat-check" role="checkbox" aria-checked={on} aria-label={t.selectP(p.name)} onClick={() => toggle(p)}>
                    <span aria-hidden="true">{on ? '✓' : ''}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      {error ? <p className="chat-error" role="alert">{error}</p> : null}
    </Sheet>
  )
}

/** Pinned messages of one channel; a tap jumps to the message. Keeps the header's 📌 count honest. */
export function PinsSheet({ api, t, lang, channel, onClose, onGoto, onCount }: { api: ChatApi; t: T; lang: Lang; channel: Channel; onClose: () => void; onGoto: (g: Goto) => void; onCount?: (n: number) => void }) {
  const [list, setList] = useState<Message[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void api.req<{ messages: Message[] }>('GET', `/api/pins/${channel.id}`).then(
      (r) => {
        setList(r.messages)
        onCount?.(r.messages.length)
      },
      (e) => {
        setList([])
        setError(e instanceof ChatError ? e.message : t.failed)
      },
    )
  }, [api, channel.id]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sheet title={t.pinned} kicker={channelLabel(channel)} onClose={onClose}>
      {!list ? <Skeleton rows={2} /> : null}
      {error ? <p className="chat-error" role="alert">{error}</p> : null}
      {list && list.length === 0 && !error ? <p className="chat-note-p">{t.noPins}</p> : null}
      <ul className="chat-hits">
        {(list ?? []).map((m) => (
          <li key={m.id}>
            <ResultButton m={m} where={{ id: channel.id, label: '' }} snippet={m.body} q="" lang={lang} onGoto={onGoto} />
          </li>
        ))}
      </ul>
    </Sheet>
  )
}

/** Staff: the flagged inbox (original text kept even when the message was deleted). */
export function FlaggedSheet({ api, t, lang, onClose, onGoto }: { api: ChatApi; t: T; lang: Lang; onClose: () => void; onGoto: (g: Goto) => void }) {
  const [list, setList] = useState<FlaggedAnswer['messages'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void api.req<FlaggedAnswer>('GET', '/api/flagged').then(
      (r) => setList(r.messages),
      (e) => {
        setList([])
        setError(e instanceof ChatError ? e.message : t.failed)
      },
    )
  }, [api, t.failed])
  return (
    <Sheet title={t.flaggedT} kicker="Staff" onClose={onClose}>
      {!list ? <Skeleton rows={2} /> : null}
      {error ? <p className="chat-error" role="alert">{error}</p> : null}
      {list && list.length === 0 && !error ? <p className="chat-note-p">{t.noFlagged}</p> : null}
      <ul className="chat-hits">
        {(list ?? []).map((m) => (
          <li key={m.id}>
            <ResultButton m={m} where={{ id: m.channel.id, label: kindLabel({ kind: String(m.channel.kind), name: m.channel.name }) }} snippet={m.body} q="" lang={lang} tag={m.flag_reason} onGoto={onGoto} />
          </li>
        ))}
      </ul>
    </Sheet>
  )
}

/** Grey placeholder rows while something loads. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="chat-skel" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="chat-skel-row">
          <i className="chat-sk av" />
          <span>
            <i className="chat-sk" style={{ width: `${50 + ((i * 7) % 40)}%` }} />
            <i className="chat-sk" style={{ width: `${70 - i * 5}%` }} />
          </span>
        </div>
      ))}
    </div>
  )
}
