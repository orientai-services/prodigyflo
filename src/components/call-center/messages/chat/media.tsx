'use client'

import { useEffect, useRef, useState } from 'react'
import type { ChatApi } from './api'
import { fmtDur } from './format'
import type { T } from './strings'
import type { Attachment } from './types'

/** Chat files need the bearer, so every one is fetched once and shown from a blob: URL. */
function useBlob(api: ChatApi, id: string, enabled = true): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    api.fileUrl(id).then((u) => live && setUrl(u), () => undefined)
    return () => {
      live = false
    }
  }, [api, id, enabled])
  return url
}

export function AttachmentView({ api, a, t }: { api: ChatApi; a: Attachment; t: T }) {
  if (a.kind === 'voice') return <VoicePlayer api={api} a={a} t={t} />
  if (a.type.startsWith('image/')) return <ChatImage api={api} a={a} t={t} />
  return <FileCard api={api} a={a} t={t} />
}

function ChatImage({ api, a, t }: { api: ChatApi; a: Attachment; t: T }) {
  const url = useBlob(api, a.id)
  const ratio = a.w && a.h ? `${a.w} / ${a.h}` : '4 / 3'
  return (
    <a className="chat-img" href={url ?? undefined} target="_blank" rel="noreferrer" aria-label={`${t.image}: ${a.name}`} style={{ aspectRatio: ratio }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL from the chat Worker; next/image can't fetch it */}
      {url ? <img src={url} alt={a.name} loading="lazy" /> : <span className="chat-img-wait" aria-hidden="true" />}
    </a>
  )
}

function FileCard({ api, a, t }: { api: ChatApi; a: Attachment; t: T }) {
  const [busy, setBusy] = useState(false)
  async function open() {
    // A blank tab opened inside the click survives popup blockers; it gets the blob once it's here.
    const win = window.open('', '_blank')
    setBusy(true)
    try {
      const url = await api.fileUrl(a.id)
      if (win) win.location.href = url
      else window.location.href = url
    } catch {
      win?.close()
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className="chat-file" onClick={() => void open()} aria-busy={busy}>
      <span className="chat-file-icon" aria-hidden="true">{a.type === 'application/pdf' ? 'PDF' : '📎'}</span>
      <span className="chat-file-main">
        <b>{a.name}</b>
        <small>{a.type === 'application/pdf' ? 'PDF' : t.file} · {Math.max(1, Math.round(a.size / 1024))} KB</small>
      </span>
    </button>
  )
}

/** One voice note plays at a time across the screen. */
let playing: HTMLAudioElement | null = null

function VoicePlayer({ api, a, t }: { api: ChatApi; a: Attachment; t: T }) {
  const [want, setWant] = useState(false)
  const url = useBlob(api, a.id, want)
  const audio = useRef<HTMLAudioElement | null>(null)
  const [on, setOn] = useState(false)
  const [pos, setPos] = useState(0)
  const [open, setOpen] = useState(false)
  const dur = Number(a.duration) || 0
  const bars = (a.wave ?? '').split('').map((d) => Number(d) || 0)

  useEffect(() => {
    if (!url || !want) return
    const el = audio.current ?? new Audio()
    audio.current = el
    if (el.src !== url) el.src = url
    el.ontimeupdate = () => setPos(el.currentTime)
    el.onended = () => {
      setOn(false)
      setPos(0)
    }
    el.onpause = () => setOn(false)
    el.onplay = () => setOn(true)
    if (playing && playing !== el) playing.pause()
    playing = el
    void el.play().catch(() => setOn(false))
  }, [url, want])

  useEffect(() => () => audio.current?.pause(), [])

  function toggle() {
    if (!want) {
      setWant(true)
      return
    }
    const el = audio.current
    if (!el) return
    if (el.paused) {
      if (playing && playing !== el) playing.pause()
      playing = el
      void el.play()
    } else el.pause()
  }

  const shown = bars.length ? bars : Array.from({ length: 24 }, () => 3)
  const done = dur ? Math.min(1, pos / dur) : 0
  return (
    <div className="chat-voice">
      <div className="chat-voice-row">
        <button type="button" className="chat-voice-play" onClick={toggle} aria-label={`${on ? 'Pause' : 'Play'} ${t.voiceNote}`}>
          {on ? '❚❚' : '▶'}
        </button>
        <span className="chat-wave" aria-hidden="true">
          {shown.map((b, i) => (
            <i key={i} style={{ height: `${20 + b * 8}%` }} className={i / shown.length < done ? 'on' : ''} />
          ))}
        </span>
        <small>{fmtDur(on || pos ? pos : dur)}</small>
      </div>
      {a.tx === 'pending' ? <small className="chat-voice-tx muted">{t.transcribing}</small> : null}
      {a.transcript ? (
        <button type="button" className={`chat-voice-tx${open ? ' open' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {a.transcript}
        </button>
      ) : null}
    </div>
  )
}

export type Recording = { blob: Blob; duration: number; wave: string; type: string }

/**
 * Voice notes: MediaRecorder with Opus in WebM (Chrome, Firefox) or MP4
 * (Safari), a 5-minute cap, and a 40-step loudness strip for the bubble.
 */
export function useRecorder(onDone: (r: Recording) => void, onError: (msg: string) => void, t: T) {
  const [rec, setRec] = useState<{ elapsed: number; level: number } | null>(null)
  const parts = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; levels: number[]; ctx: AudioContext; timer: ReturnType<typeof setInterval>; cancel: boolean } | null>(null)

  async function start() {
    if (parts.current) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      onError(t.micBlocked)
      return
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((x) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(x)) ?? ''
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Uint8Array(analyser.fftSize)
    const startAt = Date.now()
    const state = { mr, stream, chunks: [] as Blob[], levels: [] as number[], ctx, cancel: false, timer: setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
      const level = Math.min(1, peak / 64)
      state.levels.push(level)
      setRec({ elapsed: (Date.now() - startAt) / 1000, level })
      if (Date.now() - startAt > 300_000) stop()
    }, 150) }
    parts.current = state
    mr.ondataavailable = (e) => e.data.size && state.chunks.push(e.data)
    mr.onstop = () => {
      clearInterval(state.timer)
      stream.getTracks().forEach((tr) => tr.stop())
      void ctx.close()
      parts.current = null
      setRec(null)
      if (state.cancel || !state.chunks.length) return
      const duration = Math.max(1, Math.round((Date.now() - startAt) / 1000))
      const step = Math.max(1, Math.floor(state.levels.length / 40))
      const wave = Array.from({ length: Math.min(40, state.levels.length) }, (_, i) => Math.round(Math.max(...state.levels.slice(i * step, i * step + step)) * 9)).join('')
      onDone({ blob: new Blob(state.chunks, { type: mr.mimeType || type || 'audio/webm' }), duration, wave, type: mr.mimeType || type })
    }
    mr.start(250)
    setRec({ elapsed: 0, level: 0 })
  }
  function stop() {
    if (parts.current?.mr.state === 'recording') parts.current.mr.stop()
  }
  function cancel() {
    if (!parts.current) return
    parts.current.cancel = true
    stop()
  }
  useEffect(() => () => cancel(), []) // eslint-disable-line react-hooks/exhaustive-deps
  return { rec, start, stop, cancel }
}
