'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChatError, type ChatApi } from './api'
import { hostStrings } from './host-strings'
import { browserPushSupport, CHAT_SW_SCOPE, CHAT_SW_URL, vapidKeyBytes, type PushSupport } from './push'
import type { Lang } from './types'
import './host.css'

/**
 * "Notifications on this device" for the Team chat (docs/TEAM_CHAT_PARITY.md
 * F2). Self-contained: drop `<PushToggle api lang />` into the chat Settings
 * sheet. `<PushMenu>` is the same switch behind a bell button, for a header.
 *
 * On: ask permission → register /chat-sw.js (push only, scope /chat-sw/) →
 * subscribe with the chat's VAPID key (GET <chat>/api/push/vapid, or the one
 * passed in from `me.vapid_public`) → POST <chat>/api/push/subscribe
 * {subscription, host:'prodigyflo'}. Off: unsubscribe here, then DELETE it at
 * the chat. A subscription found on load is sent again, so the chat always
 * has this device under the person signed in now.
 */

type Props = { api: ChatApi; lang: Lang; vapid?: string | null }
type Note = { kind: 'info' | 'bad'; text: string } | null

async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(CHAT_SW_URL, { scope: CHAT_SW_SCOPE })
  if (reg.active) return reg
  // `navigator.serviceWorker.ready` waits for a worker controlling THIS page, which this one never is.
  const sw = reg.installing ?? reg.waiting
  if (sw)
    await new Promise<void>((resolve) => {
      const done = () => {
        if (sw.state === 'activated' || sw.state === 'redundant') {
          sw.removeEventListener('statechange', done)
          resolve()
        }
      }
      sw.addEventListener('statechange', done)
      done()
      window.setTimeout(resolve, 10_000)
    })
  return reg
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(CHAT_SW_SCOPE)
  return reg ? reg.pushManager.getSubscription() : null
}

export function PushToggle({ api, lang, vapid }: Props) {
  const t = hostStrings(lang)
  // Rendered on the client only (the chat shows nothing until it has signed in), so this reads the browser directly.
  const [support] = useState<PushSupport>(() => browserPushSupport())
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const labelId = useId()

  const register = useCallback(
    async (sub: PushSubscription) => {
      await api.req('POST', '/api/push/subscribe', { subscription: sub.toJSON(), host: 'prodigyflo' })
    },
    [api],
  )

  // What this browser can do, and whether this device is already subscribed.
  useEffect(() => {
    if (support !== 'ok') return
    let live = true
    void currentSubscription()
      .then((sub) => {
        if (!live) return
        const yes = Boolean(sub) && Notification.permission === 'granted'
        setOn(yes)
        if (yes && sub) void register(sub).catch(() => undefined)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [register, support])

  function fail(e: unknown) {
    if (e instanceof ChatError && (e.code === 'push_off' || e.status === 503)) setNote({ kind: 'bad', text: t.notifyOffServer })
    else if (e instanceof ChatError) setNote({ kind: 'bad', text: e.message })
    else setNote({ kind: 'bad', text: t.notifyFailed })
  }

  async function turnOn() {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') {
      setNote({ kind: 'bad', text: perm === 'denied' ? t.notifyDenied : t.notifyFailed })
      return
    }
    const key = vapid || (await api.req<{ key: string | null }>('GET', '/api/push/vapid')).key
    if (!key) {
      setNote({ kind: 'bad', text: t.notifyOffServer })
      return
    }
    const reg = await activeRegistration()
    const opts = { userVisibleOnly: true, applicationServerKey: vapidKeyBytes(key) }
    let sub: PushSubscription
    try {
      sub = await reg.pushManager.subscribe(opts)
    } catch {
      // A subscription made with another key (a rotated VAPID pair) has to go first.
      await (await reg.pushManager.getSubscription())?.unsubscribe()
      sub = await reg.pushManager.subscribe(opts)
    }
    await register(sub)
    setOn(true)
    setNote(null)
  }

  async function turnOff() {
    const sub = await currentSubscription()
    if (sub) {
      const endpoint = sub.endpoint
      await sub.unsubscribe().catch(() => false)
      await api.req('DELETE', '/api/push/subscribe', { endpoint }).catch(() => undefined)
    }
    setOn(false)
    setNote(null)
  }

  async function toggle() {
    if (busy) return
    setBusy(true)
    setNote({ kind: 'info', text: t.notifyWorking })
    try {
      if (on) await turnOff()
      else await turnOn()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
      setNote((n) => (n?.text === t.notifyWorking ? null : n))
    }
  }

  async function test() {
    if (busy) return
    setBusy(true)
    try {
      const r = await api.req<{ sent?: number }>('POST', '/api/push/test')
      setNote({ kind: 'info', text: t.notifyTestSent(Number(r.sent) || 0) })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  if (support !== 'ok')
    return (
      <div className="chat-push">
        <p className="chat-push-title">{t.notifyTitle}</p>
        <p className="chat-push-note">{support === 'ios_install' ? t.notifyIos : t.notifyUnsupported}</p>
      </div>
    )

  return (
    <div className="chat-push">
      <div className="chat-push-row">
        <span id={labelId} className="chat-push-title">{t.notifyTitle}</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={labelId}
          className={`chat-switch-btn${on ? ' on' : ''}`}
          disabled={busy}
          onClick={() => void toggle()}
        >
          <span aria-hidden="true" />
          <b>{on ? t.notifyOn : t.notifyOff}</b>
        </button>
      </div>
      <p className="chat-push-note">{t.notifyBody}</p>
      {!on && !note && Notification.permission === 'denied' ? <p className="chat-push-msg bad" role="alert">{t.notifyDenied}</p> : null}
      {on ? (
        <button type="button" className="chat-btn ghost chat-push-test" disabled={busy} onClick={() => void test()}>
          {t.notifyTest}
        </button>
      ) : null}
      {note ? (
        <p className={`chat-push-msg${note.kind === 'bad' ? ' bad' : ''}`} role={note.kind === 'bad' ? 'alert' : 'status'}>
          {note.text}
        </p>
      ) : null}
    </div>
  )
}

/** The switch behind a 🔔 button, as a small popover (header use until the Settings sheet carries <PushToggle>). */
export function PushMenu(props: Props) {
  const t = hostStrings(props.lang)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <span ref={box} className="chat-push-menu">
      <button type="button" className="chat-lang" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={t.notifyTitle}>
        <span aria-hidden="true">🔔</span> {t.notify}
      </button>
      {open ? (
        <div className="chat-push-pop" role="dialog" aria-label={t.notifyTitle}>
          <PushToggle {...props} />
          <button type="button" className="chat-btn ghost" onClick={() => setOpen(false)}>{t.close}</button>
        </div>
      ) : null}
    </span>
  )
}
