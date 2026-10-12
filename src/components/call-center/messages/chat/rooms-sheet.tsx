'use client'

import { useState } from 'react'
import type { ChatApi } from './api'
import { ChatError } from './api'
import { relTime, roomInText, splitRooms } from './format'
import { ConfirmSheet, Sheet, Skeleton } from './sheets'
import type { T } from './strings'
import type { Lang, Me, Room, RoomsAnswer } from './types'

/**
 * 🎥 Salas (SunOff chat roomsSheet / roomSheet / roomNewSheet): permanent team video rooms with a live head count
 * from Meet. The Worker decides which rooms I see and may manage; the Meet link is minted the first time someone
 * joins. A `rooms` socket event makes the parent refetch, so counts stay live while this is open.
 */
export function RoomsSheet({ api, t, lang, me, data, reload, onClose, toast }: {
  api: ChatApi
  t: T
  lang: Lang
  me: Me
  data: RoomsAnswer | null
  reload: () => Promise<void>
  onClose: () => void
  toast: (msg: string) => void
}) {
  const [view, setView] = useState<'list' | 'new' | string>('list')
  const [busy, setBusy] = useState(false)
  const [archiveAsk, setArchiveAsk] = useState<string | null>(null)
  const rooms = data?.rooms ?? []
  const room = view !== 'list' && view !== 'new' ? rooms.find((r) => r.id === view) ?? null : null

  async function act(fn: () => Promise<void>) {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast(e instanceof ChatError ? e.message : t.failed)
    } finally {
      setBusy(false)
    }
  }

  // The tab opens inside the tap (popup blockers), then goes to the room's Meet link once the server has it.
  async function join(r: Room) {
    if (r.uri) {
      window.open(r.uri, '_blank', 'noopener')
      void api.req('POST', `/api/rooms/${r.id}/join`).catch(() => undefined)
      return
    }
    let w: Window | null = null
    try {
      w = window.open('', '_blank')
      if (w) {
        w.document.title = 'Meet'
        w.document.body.style.cssText = 'font:16px system-ui;padding:40px;color:#0e1b27'
        w.document.body.textContent = t.roomOpening
      }
    } catch {
      w = null
    }
    try {
      const j = await api.req<{ uri: string }>('POST', `/api/rooms/${r.id}/join`)
      if (w) {
        try {
          w.opener = null
        } catch {
          // cross-origin already: nothing to cut
        }
        w.location.replace(j.uri)
      } else window.open(j.uri, '_blank', 'noopener')
      void reload()
    } catch (e) {
      try {
        w?.close()
      } catch {
        // already closed
      }
      toast(e instanceof ChatError ? e.message : t.failed)
    }
  }

  if (view === 'new') return <NewRoom t={t} me={me} owners={data?.owners ?? []} busy={busy} onBack={() => setView('list')} onClose={onClose}
    onCreate={(name, owner) => void act(async () => {
      await api.req('POST', '/api/rooms', { name, ...(owner ? { owner_uid: owner } : {}) })
      await reload()
      setView('list')
    })}
  />

  if (room) {
    return (
      <Sheet title={room.name} kicker={t.roomsS} onClose={onClose}>
        <button type="button" className="chat-btn ghost" onClick={() => setView('list')}>{t.roomBack}</button>
        <p className="chat-pills">
          <span className="chat-rel rel-staff">{t.roomOwner(room.owner.name)}</span>
          <span className="chat-rel">{t.members(room.people)}</span>
          {room.auto ? <span className="chat-rel">{t.roomTeam}</span> : null}
        </p>
        {room.live && room.live.n ? (
          <section className="chat-sec-block">
            <h3>🟢 {t.roomInside} · {room.live.n}</h3>
            <p className="chat-pills">{room.live.names.map((n) => <span key={n} className="chat-rel">{n}</span>)}</p>
          </section>
        ) : null}
        <button type="button" className="chat-btn wide big" onClick={() => void join(room)}>{t.roomJoinBig}</button>
        {room.uri ? (
          <>
            <button
              type="button"
              className="chat-btn ghost wide"
              onClick={() => void navigator.clipboard.writeText(room.uri ?? '').then(() => toast(t.copied), () => toast(t.failed))}
            >
              {t.roomCopy}
            </button>
            <p className="chat-note-p chat-break">{room.uri}</p>
          </>
        ) : (
          <p className="chat-note-p">{t.roomNoLink}</p>
        )}
        <p className="chat-note-p">🔒 {t.roomWho(room.owner.name)}</p>
        {room.last_join_at && room.last_join_name ? <p className="chat-note-p">{t.roomLast(room.last_join_name, relTime(room.last_join_at, lang))}</p> : null}
        {room.can_manage && !room.auto ? <RenameRoom key={room.id} t={t} room={room} busy={busy} onRename={(name) => void act(async () => {
          await api.req('PATCH', `/api/rooms/${room.id}`, { name })
          await reload()
          toast(t.saved)
        })} /> : null}
        {room.auto ? <p className="chat-note-p">{t.roomAutoNote}</p> : null}
        {room.can_manage ? <button type="button" className="chat-btn danger wide" disabled={busy} onClick={() => setArchiveAsk(room.id)}>{t.roomArchive}</button> : null}
        {archiveAsk ? (
          <ConfirmSheet t={t} title={t.roomArchiveQ} body={t.roomArchiveP} yes={t.yesArchive}
            onAnswer={(yes) => {
              const id = archiveAsk
              setArchiveAsk(null)
              if (yes) void act(async () => {
                await api.req('PATCH', `/api/rooms/${id}`, { archived: true })
                await reload()
                setView('list')
              })
            }}
          />
        ) : null}
      </Sheet>
    )
  }

  const { mine, other } = splitRooms(rooms, me.staff || me.super)
  const inside = data?.inside ?? 0
  return (
    <Sheet title={t.roomsS} kicker="🎥" sub={inside ? <p className="chat-note-p">{t.roomsSub(inside)}</p> : undefined} onClose={onClose}
      foot={data?.can_create ? <button type="button" className="chat-btn wide" onClick={() => setView('new')}>+ {t.roomNew}</button> : undefined}
    >
      {!data ? <Skeleton rows={3} /> : null}
      {data && !rooms.length ? <p className="chat-note-p">{t.roomsNone}</p> : null}
      {[
        [mine, other.length ? t.roomsMine : ''],
        [other, mine.length ? t.roomsOther : ''],
      ].map(([list, label]) =>
        (list as Room[]).length ? (
          <section key={String(label) || 'all'} className="chat-pgroup">
            {label ? <h3>{label as string}</h3> : null}
            <ul className="chat-rooms">
              {(list as Room[]).map((r) => {
                const live = Boolean(r.live && r.live.n > 0)
                const sub = live ? r.live!.names.join(', ') : [t.roomOwner(r.owner.name.split(' ')[0]), t.members(r.people), r.last_join_at ? relTime(r.last_join_at, lang) : ''].filter(Boolean).join(' · ')
                const inTxt = roomInText(r, t)
                return (
                  <li key={r.id} className={`chat-room${live ? ' live' : ''}`}>
                    <button type="button" className="chat-room-main" onClick={() => setView(r.id)}>
                      <span className="chat-room-ic" aria-hidden="true">{r.badge?.emoji || '🎥'}</span>
                      <span className="chat-row-main">
                        <b>{r.name}</b>
                        <span className="chat-snip">{sub}</span>
                      </span>
                      {inTxt ? <span className={`chat-room-in${live ? '' : ' z'}`}>{live ? '🟢 ' : ''}{inTxt}</span> : null}
                    </button>
                    <button type="button" className="chat-btn sm" onClick={() => void join(r)}>{t.roomJoin}</button>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null,
      )}
    </Sheet>
  )
}

function RenameRoom({ t, room, busy, onRename }: { t: T; room: Room; busy: boolean; onRename: (name: string) => void }) {
  const [name, setName] = useState(room.name)
  return (
    <section className="chat-sec-block">
      <h3>{t.renameT}</h3>
      <form className="chat-sheet-row" onSubmit={(e) => { e.preventDefault(); if (name.trim().length >= 2) onRename(name.trim()) }}>
        <label className="chat-filter">
          <span className="sr">{t.renameT}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        <button type="submit" className="chat-btn ghost" disabled={busy || name.trim().length < 2 || name.trim() === room.name}>{t.rename}</button>
      </form>
    </section>
  )
}

function NewRoom({ t, me, owners, busy, onBack, onClose, onCreate }: { t: T; me: Me; owners: RoomsAnswer['owners']; busy: boolean; onBack: () => void; onClose: () => void; onCreate: (name: string, owner: string | null) => void }) {
  const [name, setName] = useState('')
  const [owner, setOwner] = useState(owners.some((o) => o.uid === me.uid) ? me.uid : owners[0]?.uid ?? '')
  const ok = name.trim().length >= 2
  return (
    <Sheet title={t.roomNew} kicker={t.roomsS} onClose={onClose}
      foot={
        <>
          <button type="button" className="chat-btn ghost" onClick={onBack}>{t.cancel}</button>
          <button type="button" className="chat-btn" disabled={!ok || busy} onClick={() => onCreate(name.trim(), owners.length > 1 ? owner : null)}>{t.roomCreate}</button>
        </>
      }
    >
      <label className="chat-field">
        <span>{t.roomName}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t.roomNamePh} autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ok) {
              e.preventDefault()
              onCreate(name.trim(), owners.length > 1 ? owner : null)
            }
          }}
        />
      </label>
      {owners.length > 1 ? (
        <label className="chat-field">
          <span>{t.roomFor}</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            {owners.map((o) => <option key={o.uid} value={o.uid}>{o.name}</option>)}
          </select>
        </label>
      ) : null}
    </Sheet>
  )
}
