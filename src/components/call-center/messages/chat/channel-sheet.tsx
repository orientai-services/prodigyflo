'use client'

import { useState } from 'react'
import type { ChatApi } from './api'
import { ChatError } from './api'
import { channelLabel, initials } from './format'
import { ConfirmSheet, Sheet } from './sheets'
import type { T } from './strings'
import type { Channel, Me, Notify } from './types'

/**
 * Channel details (SunOff chat openDetails): notify all / mentions / none, mute, rename, members with presence,
 * add / remove people, leave, archive. The Worker decides who may do what (sunoff-chat src/perm.ts): renaming,
 * membership and archiving are for groups, by staff or the group's creator; anyone may leave a group; auto
 * channels and client chats keep the members the org sync gives them.
 */
export function ChannelSheet({ api, t, me, channel, online, onClose, onChanged, onGone, onAddPeople, toast }: {
  api: ChatApi
  t: T
  me: Me
  channel: Channel
  online: Record<string, boolean>
  onClose: () => void
  onChanged: (c: Channel) => void
  onGone: (id: string) => void
  onAddPeople: () => void
  toast: (msg: string) => void
}) {
  const [name, setName] = useState(channel.name)
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<null | 'archive' | 'leave'>(null)
  const isGroup = channel.kind === 'group' && !channel.case
  const manage = isGroup && (me.staff || channel.created_by === me.uid)
  const auto = channel.kind === 'main' || channel.kind === 'announcements' || channel.kind === 'team'
  const notify = channel.notify as Notify
  const members = channel.members
    .map((m) => ({ ...m, online: online[m.uid] ?? m.online }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))

  async function run<R>(fn: () => Promise<R>): Promise<R | null> {
    setBusy(true)
    try {
      return await fn()
    } catch (e) {
      toast(e instanceof ChatError ? e.message : t.failed)
      return null
    } finally {
      setBusy(false)
    }
  }
  const patch = (body: Record<string, unknown>) =>
    run(async () => {
      const r = await api.req<{ channel: Channel }>('PATCH', `/api/channels/${channel.id}`, body)
      onChanged(r.channel ?? { ...channel, ...body })
      return true
    })
  const members_ = (body: { add?: string[]; remove?: string[] }) =>
    run(async () => {
      const r = await api.req<{ channel: Channel }>('POST', `/api/channels/${channel.id}/members`, body)
      return r.channel
    })

  return (
    <Sheet title={channelLabel(channel)} kicker={t.detT} onClose={onClose}>
      <section className="chat-sec-block" aria-labelledby="chat-notify-h">
        <h3 id="chat-notify-h">{t.notifyT}</h3>
        <div className="chat-opts" role="radiogroup" aria-labelledby="chat-notify-h">
          {(
            [
              ['all', t.notifyAll, t.notifyAllP],
              ['mentions', t.notifyMentions, t.notifyMentionsP],
              ['none', t.notifyNone, t.notifyNoneP],
            ] as const
          ).map(([v, l, p]) => (
            <button key={v} type="button" role="radio" aria-checked={notify === v} className={notify === v ? 'on' : ''} disabled={busy} onClick={() => void patch({ notify: v })}>
              {l}
              <small>{p}</small>
            </button>
          ))}
        </div>
        <button type="button" className="chat-switchrow" role="switch" aria-checked={channel.muted} disabled={busy} onClick={() => void patch({ muted: !channel.muted })}>
          <span>
            {t.muteSw}
            <small>{t.muteP}</small>
          </span>
          <i aria-hidden="true" />
        </button>
      </section>

      {manage ? (
        <section className="chat-sec-block" aria-labelledby="chat-rename-h">
          <h3 id="chat-rename-h">{t.renameT}</h3>
          <form
            className="chat-sheet-row"
            onSubmit={(e) => {
              e.preventDefault()
              const v = name.trim()
              if (v && v !== channel.name) void patch({ name: v }).then((ok) => ok && toast(t.saved))
            }}
          >
            <label className="chat-filter">
              <span className="sr">{t.renameT}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </label>
            <button type="submit" className="chat-btn ghost" disabled={busy || !name.trim() || name.trim() === channel.name}>{t.rename}</button>
          </form>
        </section>
      ) : null}

      {channel.kind !== 'dm' ? (
        <section className="chat-sec-block" aria-labelledby="chat-members-h">
          <h3 id="chat-members-h">{t.membersT} · {channel.member_count}</h3>
          {auto ? <p className="chat-note-p">{t.autoMembers}</p> : channel.case ? <p className="chat-note-p">{t.caseMembers}</p> : null}
          {manage ? (
            <button type="button" className="chat-btn ghost wide" onClick={onAddPeople}>+ {t.addPeople}</button>
          ) : null}
          <ul className="chat-people">
            {members.map((m) => (
              <li key={m.uid} className="chat-prow static">
                <span className="chat-prow-main">
                  <span className="chat-av" aria-hidden="true">{initials(m.name)}<i className={`chat-dot${m.online ? ' on' : ''}`} /></span>
                  <span className="chat-row-main">
                    <b>{m.name}{m.uid === me.uid ? ` (${t.you})` : ''}</b>
                    <span className="chat-snip">{[t.role[m.role] ?? m.role, m.online ? t.online : ''].filter(Boolean).join(' · ')}</span>
                  </span>
                  {m.staff ? <span className="chat-rel rel-staff">{t.relPill.staff}</span> : null}
                </span>
                {manage && m.uid !== me.uid ? (
                  <button
                    type="button"
                    className="chat-btn ghost sm"
                    disabled={busy}
                    onClick={() =>
                      void members_({ remove: [m.uid] }).then((c) => {
                        if (c) onChanged(c)
                      })
                    }
                  >
                    {t.remove}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {channel.member_count > members.length ? <p className="chat-note-p">{t.members(channel.member_count)}</p> : null}
        </section>
      ) : null}

      {isGroup ? (
        <section className="chat-sec-block chat-danger-zone">
          <button type="button" className="chat-btn ghost wide" disabled={busy} onClick={() => setAsk('leave')}>{t.leave}</button>
          {manage ? <button type="button" className="chat-btn danger wide" disabled={busy} onClick={() => setAsk('archive')}>🗄 {t.archive}</button> : null}
        </section>
      ) : null}

      {ask ? (
        <ConfirmSheet
          t={t}
          title={ask === 'archive' ? t.archiveQ : t.leaveQ}
          body={ask === 'archive' ? t.archiveP : t.leaveP}
          yes={ask === 'archive' ? t.yesArchive : t.yesLeave}
          onAnswer={(yes) => {
            const what = ask
            setAsk(null)
            if (!yes) return
            if (what === 'archive') void patch({ archived: true }).then((ok) => ok && onGone(channel.id))
            else void members_({ remove: [me.uid] }).then((c) => c && onGone(channel.id))
          }}
        />
      ) : null}
    </Sheet>
  )
}
