'use client'

import { useMemo, useState } from 'react'
import { PushToggle } from './push-toggle'
import type { ChatApi } from './api'
import { ChatError } from './api'
import { browserTz, validHHMM } from './format'
import { Sheet } from './sheets'
import type { T } from './strings'
import type { Lang, Me, MePrefs, Notify } from './types'

/**
 * Preferences (SunOff chat openPrefs): language (saved at once), default notifications for new channels, quiet
 * hours with their time zone. Everything lives on the chat Worker (`POST /api/me/prefs`), so SunOff, the dialer and
 * ProdigyFlo share it.
 */
export function SettingsSheet({ api, t, lang, me, onLang, onSaved, onClose, toast }: {
  api: ChatApi
  t: T
  lang: Lang
  me: Me
  onLang: (l: Lang) => void
  onSaved: (prefs: MePrefs) => void
  onClose: () => void
  toast: (msg: string) => void
}) {
  const pr = me.prefs ?? {}
  const [nd, setNd] = useState<Notify>((pr.notify_default as Notify) || 'all')
  const [on, setOn] = useState(Boolean(pr.quiet?.on))
  const [from, setFrom] = useState(pr.quiet?.from || '21:00')
  const [to, setTo] = useState(pr.quiet?.to || '08:00')
  const [tz, setTz] = useState(pr.tz || browserTz())
  const [busy, setBusy] = useState(false)
  const zones = useMemo(() => {
    try {
      const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
      return all.includes(tz) ? all : [tz, ...all]
    } catch {
      return [tz]
    }
  }, [tz])
  const timesOk = validHHMM(from) && validHHMM(to)

  async function save() {
    if (!timesOk) {
      toast(t.badTime)
      return
    }
    setBusy(true)
    try {
      const r = await api.req<{ prefs: MePrefs }>('POST', '/api/me/prefs', { notify_default: nd, quiet: { on, from, to }, tz })
      onSaved(r.prefs ?? { ...pr, notify_default: nd, quiet: { on, from, to }, tz })
      toast(t.saved)
      onClose()
    } catch (e) {
      toast(e instanceof ChatError ? e.message : t.failed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title={t.prefsT} kicker={me.name} onClose={onClose}
      foot={
        <>
          <button type="button" className="chat-btn ghost" onClick={onClose}>{t.close}</button>
          <button type="button" className="chat-btn" disabled={busy || !timesOk} onClick={() => void save()}>{t.save}</button>
        </>
      }
    >
      <section className="chat-sec-block" aria-labelledby="chat-lang-h">
        <h3 id="chat-lang-h">{t.langT}</h3>
        <div className="chat-opts two">
          {(
            [
              ['es', 'Español'],
              ['en', 'English'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={lang === v} className={lang === v ? 'on' : ''} lang={v} onClick={() => onLang(v)}>{l}</button>
          ))}
        </div>
      </section>

      <section className="chat-sec-block" aria-label={lang === 'es' ? 'Avisos en este dispositivo' : 'Notifications on this device'}>
        <PushToggle api={api} lang={lang} />
      </section>
      <section className="chat-sec-block" aria-labelledby="chat-nd-h">
        <h3 id="chat-nd-h">{t.notifyDefT}</h3>
        <div className="chat-opts" role="radiogroup" aria-labelledby="chat-nd-h">
          {(
            [
              ['all', t.notifyAll, t.notifyAllP],
              ['mentions', t.notifyMentions, t.notifyMentionsP],
              ['none', t.notifyNone, t.notifyNoneP],
            ] as const
          ).map(([v, l, p]) => (
            <button key={v} type="button" role="radio" aria-checked={nd === v} className={nd === v ? 'on' : ''} onClick={() => setNd(v)}>
              {l}
              <small>{p}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="chat-sec-block" aria-labelledby="chat-quiet-h">
        <h3 id="chat-quiet-h">{t.quietT}</h3>
        <button type="button" className="chat-switchrow" role="switch" aria-checked={on} onClick={() => setOn((v) => !v)}>
          <span>
            {t.quietSw}
            <small>{t.quietP}</small>
          </span>
          <i aria-hidden="true" />
        </button>
        <div className="chat-sheet-row">
          <label className="chat-field">
            <span>{t.from}</span>
            <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <label className="chat-field">
            <span>{t.to}</span>
            <input type="time" value={to} onChange={(e) => setTo(e.target.value)} required />
          </label>
        </div>
        <label className="chat-field">
          <span>{t.tzT}</span>
          <select value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        {!timesOk ? <p className="chat-error" role="alert">{t.badTime}</p> : null}
      </section>
    </Sheet>
  )
}
