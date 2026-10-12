'use client'

import { useEffect, useRef, useState } from 'react'
import type { ChatApi } from './api'
import { ChatError } from './api'
import { clock, dayLabel, initials } from './format'
import type { T } from './strings'
import type { Channel, Lang, Message, Person, SearchHit } from './types'

/** Bottom sheets on phones, centered dialogs on desktop (docs/MOBILE.md). */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
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
          onClose()
        }
      }}
    >
      <div className="chat-sheet-in">
        <header>
          <h2>{title}</h2>
          <button type="button" className="chat-icon" onClick={onClose} aria-label="Close">×</button>
        </header>
        {children}
      </div>
    </dialog>
  )
}

export function SearchSheet({ api, t, lang, onClose, onOpen }: { api: ChatApi; t: T; lang: Lang; onClose: () => void; onOpen: (channel: string) => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) return
    const id = window.setTimeout(() => {
      void api.req<{ results: SearchHit[] }>('GET', `/api/search?q=${encodeURIComponent(term)}`).then((r) => setHits(r.results), () => setHits([]))
    }, 250)
    return () => window.clearTimeout(id)
  }, [api, q])
  const shown = q.trim().length < 2 ? null : hits
  return (
    <Sheet title={t.search} onClose={onClose}>
      <label className="chat-filter">
        <span className="sr">{t.searchPh}</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.searchPh} autoFocus autoComplete="off" />
      </label>
      {shown && shown.length === 0 ? <p className="chat-empty">{t.noHits}</p> : null}
      <ul className="chat-hits">
        {(shown ?? []).map((h) => (
          <li key={h.message.id}>
            <button type="button" onClick={() => onOpen(h.channel.id)}>
              <b>{h.channel.kind === 'dm' || h.channel.kind === 'group' ? h.channel.name : `#${h.channel.name}`}</b>
              <small>{h.message.name} · {dayLabel(h.message.created_at, lang)} {clock(h.message.created_at, lang)}</small>
              <span>{h.snippet}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}

export function NewChatSheet({ api, t, onClose, onCreated }: { api: ChatApi; t: T; onClose: () => void; onCreated: (c: Channel) => void }) {
  const [q, setQ] = useState('')
  const [people, setPeople] = useState<Person[] | null>(null)
  const [picked, setPicked] = useState<Person[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const id = window.setTimeout(() => {
      void api.req<Person[]>('GET', `/api/directory?q=${encodeURIComponent(q.trim())}`).then(setPeople, () => setPeople([]))
    }, 200)
    return () => window.clearTimeout(id)
  }, [api, q])
  const toggle = (p: Person) => setPicked((cur) => (cur.some((x) => x.uid === p.uid) ? cur.filter((x) => x.uid !== p.uid) : [...cur, p]))
  async function start() {
    if (!picked.length) return
    setBusy(true)
    setError(null)
    try {
      const body = picked.length === 1 ? { kind: 'dm', uids: [picked[0].uid] } : { kind: 'group', uids: picked.map((p) => p.uid), name: name.trim() || undefined }
      const r = await api.req<{ channel: Channel }>('POST', '/api/channels', body)
      onCreated(r.channel)
    } catch (e) {
      setError(e instanceof ChatError ? e.message : t.failed)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title={t.newChat} onClose={onClose}>
      <label className="chat-filter">
        <span className="sr">{t.people}</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.people} autoFocus autoComplete="off" />
      </label>
      {picked.length ? (
        <p className="chat-files">
          {picked.map((p) => (
            <span key={p.uid} className="chat-chip">
              {p.name}
              <button type="button" onClick={() => toggle(p)} aria-label={`${t.discard} ${p.name}`}>×</button>
            </span>
          ))}
        </p>
      ) : null}
      {picked.length > 1 ? (
        <label className="chat-filter">
          <span className="sr">{t.groupName}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.groupName} maxLength={80} />
        </label>
      ) : null}
      {people && people.length === 0 ? <p className="chat-empty">{t.noPeople}</p> : null}
      <ul className="chat-people">
        {(people ?? []).map((p) => {
          const on = picked.some((x) => x.uid === p.uid)
          return (
            <li key={p.uid}>
              <button type="button" className={on ? 'on' : ''} aria-pressed={on} onClick={() => toggle(p)}>
                <span className="chat-av" aria-hidden="true">{initials(p.name)}<i className={`chat-dot${p.online ? ' on' : ''}`} /></span>
                <span className="chat-row-main"><b>{p.name}</b><span className="chat-snip">{p.role}</span></span>
                <span aria-hidden="true">{on ? '✓' : ''}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {error ? <p className="chat-error" role="alert">{error}</p> : null}
      <div className="chat-sheet-foot">
        <button type="button" className="chat-btn" disabled={!picked.length || busy} onClick={() => void start()}>{t.start}</button>
      </div>
    </Sheet>
  )
}

export function PinsSheet({ api, t, lang, channel, onClose }: { api: ChatApi; t: T; lang: Lang; channel: Channel; onClose: () => void }) {
  const [list, setList] = useState<Message[] | null>(null)
  useEffect(() => {
    void api.req<{ messages: Message[] }>('GET', `/api/pins/${channel.id}`).then((r) => setList(r.messages), () => setList([]))
  }, [api, channel.id])
  return (
    <Sheet title={t.pinned} onClose={onClose}>
      {list && list.length === 0 ? <p className="chat-empty">{t.noPins}</p> : null}
      <ul className="chat-hits">
        {(list ?? []).map((m) => (
          <li key={m.id}>
            <div>
              <small>{m.name} · {dayLabel(m.created_at, lang)} {clock(m.created_at, lang)}</small>
              <span>{m.body || `📎 ${t.attachment}`}</span>
            </div>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
