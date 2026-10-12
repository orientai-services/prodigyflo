'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ChatApi } from './api'
import { fmtDur } from './format'
import { Lightbox } from './message-menu'
import { REC_MAX, REC_MIN, fmtSize, levelOf, nextRate, readRate, waveBars, waveOf } from './message-logic'
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

export function AttachmentView({ api, a, t, onError }: { api: ChatApi; a: Attachment; t: T; onError: (msg: string) => void }) {
  if (a.kind === 'voice' || a.type.startsWith('audio/')) return <VoiceNote api={api} a={a} t={t} onError={onError} />
  if (a.type.startsWith('image/')) return <ChatImage api={api} a={a} t={t} />
  return <FileCard api={api} a={a} t={t} />
}

/** A photo in a message; a tap opens the lightbox. */
function ChatImage({ api, a, t }: { api: ChatApi; a: Attachment; t: T }) {
  const url = useBlob(api, a.id)
  const [open, setOpen] = useState(false)
  const ratio = a.w && a.h ? `${a.w} / ${a.h}` : '4 / 3'
  return (
    <>
      <button type="button" className="chat-img" onClick={() => url && setOpen(true)} aria-label={`${t.photo}: ${a.name}`} style={{ aspectRatio: ratio }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL from the chat Worker; next/image can't fetch it */}
        {url ? <img src={url} alt={a.name || t.photo} loading="lazy" /> : <span className="chat-img-wait" aria-hidden="true" />}
      </button>
      {open && url ? <Lightbox url={url} name={a.name} t={t} onClose={() => setOpen(false)} /> : null}
    </>
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
        <b>{a.name || t.file}</b>
        <small>{a.type === 'application/pdf' ? 'PDF' : t.file}{a.size ? ` · ${fmtSize(a.size)}` : ''}</small>
      </span>
    </button>
  )
}

// ── One player for every voice note on screen (starting one stops the other) ──

type PState = { aid: string | null; playing: boolean; cur: number; dur: number; rate: number }
const INITIAL: PState = { aid: null, playing: false, cur: 0, dur: 0, rate: 1 }
let pstate: PState = INITIAL
let va: HTMLAudioElement | null = null
let ready = false
const subs = new Set<() => void>()
let failToast: ((m: string) => void) | null = null

function emit(p: Partial<PState>) {
  pstate = { ...pstate, ...p }
  for (const f of subs) f()
}
function audio(): HTMLAudioElement {
  if (va) return va
  const a = new Audio()
  a.preload = 'metadata'
  const sync = () => emit({ playing: !a.paused && !a.ended, cur: a.currentTime || 0, dur: Number.isFinite(a.duration) && a.duration > 0 ? a.duration : pstate.dur })
  for (const ev of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'ratechange']) a.addEventListener(ev, sync)
  a.addEventListener('ended', () => {
    try {
      a.currentTime = 0
    } catch {
      // some browsers refuse a seek on an ended stream; the next play starts over anyway
    }
    emit({ playing: false, cur: 0 })
  })
  va = a
  return a
}
function subscribe(f: () => void) {
  if (!ready) {
    ready = true
    try {
      pstate = { ...pstate, rate: readRate(window.localStorage.getItem('chat_vrate')) }
    } catch {
      // private mode: 1×
    }
  }
  subs.add(f)
  return () => subs.delete(f)
}
const getSnap = () => pstate
const getServerSnap = () => INITIAL

export const voicePlayer = {
  pause() {
    va?.pause()
  },
  /** Plays `aid` from `url` (or toggles it when it is the one loaded), optionally at a fraction of its length. */
  play(aid: string, url: string, durHint: number, frac?: number) {
    const a = audio()
    if (pstate.aid === aid && a.src) {
      if (frac !== undefined) {
        const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : durHint
        if (d) a.currentTime = Math.max(0, Math.min(1, frac)) * d
        if (a.paused) void a.play().catch(() => undefined)
        return
      }
      if (a.paused) void a.play().catch(() => failToast?.('play'))
      else a.pause()
      return
    }
    a.pause()
    emit({ aid, cur: 0, dur: durHint, playing: false })
    a.src = url
    a.playbackRate = pstate.rate
    if (frac !== undefined && durHint) {
      a.addEventListener('loadedmetadata', () => {
        const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : durHint
        a.currentTime = Math.max(0, Math.min(1, frac)) * d
      }, { once: true })
    }
    void a.play().catch((e: unknown) => {
      if ((e as { name?: string })?.name !== 'AbortError') failToast?.('play')
    })
  },
  cycleRate() {
    const r = nextRate(pstate.rate)
    try {
      window.localStorage.setItem('chat_vrate', String(r))
    } catch {
      // private mode: kept for this visit
    }
    if (va) va.playbackRate = r
    emit({ rate: r })
  },
}

function usePlayer(): PState {
  return useSyncExternalStore(subscribe, getSnap, getServerSnap)
}

/**
 * The voice-note player: ▶/❚❚, a 32-bar waveform you can tap or arrow through
 * to seek, the time, and the 1× / 1.5× / 2× speed (remembered).
 */
export function VoicePlayer({ aid, dur, wave, getUrl, t, onError }: { aid: string; dur: number; wave: string | null | undefined; getUrl: () => Promise<string>; t: T; onError: (msg: string) => void }) {
  const p = usePlayer()
  const on = p.aid === aid
  const playing = on && p.playing
  const d = on && p.dur ? p.dur : dur
  const cur = on ? Math.min(p.cur, d || Infinity) : 0
  const frac = on && d ? cur / d : 0
  const bars = waveBars(wave, aid)
  const lit = Math.round(frac * bars.length)

  useEffect(() => {
    failToast = () => onError(t.playFail)
  }, [onError, t.playFail])

  async function go(f?: number) {
    try {
      const url = await getUrl()
      voicePlayer.play(aid, url, dur, f)
    } catch {
      onError(t.playFail)
    }
  }

  return (
    <div className={`chat-vn${playing ? ' play' : ''}`}>
      <button type="button" className="chat-vp" onClick={() => void go()} aria-label={`${playing ? t.pause : t.play} · ${t.voiceNote} ${fmtDur(dur)}`}>
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div
        className="chat-vw"
        role="slider"
        tabIndex={0}
        aria-label={t.voiceNote}
        aria-valuemin={0}
        aria-valuemax={Math.round(d || 0)}
        aria-valuenow={Math.round(cur)}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          void go(Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))))
        }}
        onKeyDown={(e) => {
          const step = e.key === 'ArrowRight' ? 0.1 : e.key === 'ArrowLeft' ? -0.1 : e.key === 'Home' ? -1 : e.key === 'End' ? 1 : 0
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            void go()
          } else if (step) {
            e.preventDefault()
            void go(Math.max(0, Math.min(1, frac + step)))
          }
        }}
      >
        {bars.map((h, i) => (
          <i key={i} style={{ height: h }} className={i < lit ? 'on' : ''} />
        ))}
      </div>
      <span className="chat-vt">{fmtDur(on && (cur > 0 || playing) ? cur : dur)}</span>
      <button type="button" className="chat-vr" onClick={() => voicePlayer.cycleRate()} aria-label={`${t.speed} ${p.rate}×`}>{p.rate}×</button>
    </div>
  )
}

function VoiceNote({ api, a, t, onError }: { api: ChatApi; a: Attachment; t: T; onError: (msg: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="chat-voice">
      <VoicePlayer aid={a.id} dur={Number(a.duration) || 0} wave={a.wave} getUrl={() => api.fileUrl(a.id)} t={t} onError={onError} />
      {a.transcript ? (
        <button type="button" className={`chat-vx${open ? ' open' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <b>{t.transcript}</b>
          <span>{a.transcript}</span>
        </button>
      ) : a.tx === 'pending' ? (
        <small className="chat-vxw">{t.transcribing}</small>
      ) : null}
    </div>
  )
}

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width="18" height="18"><path d="M7 4.5v15l13-7.5z" /></svg>
)
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width="18" height="18"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z" /></svg>
)

// ── Recording ───────────────────────────────────────────────────────────────

export type Recording = { blob: Blob; duration: number; wave: string; type: string }
export type RecMode = 'hold' | 'tap'
export type RecView = { mode: RecMode; state: 'starting' | 'rec' | 'preview'; elapsed: number; levels: number[]; url?: string; dur?: number; wave?: string }

type RecParts = {
  mode: RecMode
  state: 'starting' | 'rec' | 'stopping' | 'preview'
  stream?: MediaStream
  mr?: MediaRecorder
  ctx?: AudioContext
  an?: AnalyserNode
  buf?: Uint8Array<ArrayBuffer>
  chunks: Blob[]
  samples: number[]
  levels: number[]
  t0: number
  iv?: ReturnType<typeof setInterval>
  next?: 'send' | 'preview' | 'cancel'
  cancelled?: boolean
  early?: boolean
  dur?: number
  type?: string
  blob?: Blob
  wave?: string
  url?: string
}

function recType(): string {
  for (const ty of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2']) {
    try {
      if (MediaRecorder.isTypeSupported(ty)) return ty
    } catch {
      // older Safari throws on unknown types
    }
  }
  return ''
}

export const canRecord = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

/** The recorder that is live right now (one at a time across composers). */
let liveRec: { cancel: () => void } | null = null

/**
 * Voice notes, as in SunOff Chat: touch = hold to record, release sends, slide
 * left cancels; mouse = tap to start, ■ to stop into a preview you send or
 * discard. 5-minute cap, a live timer and level meter, 40-bar wave.
 */
export function useRecorder(onDone: (r: Recording) => void, onError: (msg: string) => void, t: T) {
  const [view, setView] = useState<RecView | null>(null)
  const stopRef = useRef<(next: 'send' | 'preview' | 'cancel') => void>(() => undefined)
  // A stable identity for "the composer that is recording", so a second composer can stop this one.
  const [handle] = useState(() => ({ cancel: () => stopRef.current('cancel') }))
  const parts = useRef<RecParts | null>(null)
  const done = useRef(onDone)
  const err = useRef(onError)
  useEffect(() => {
    done.current = onDone
    err.current = onError
  })

  function show(r: RecParts | null) {
    if (!r) {
      setView(null)
      return
    }
    setView({ mode: r.mode, state: r.state === 'stopping' ? 'rec' : r.state, elapsed: r.t0 ? (performance.now() - r.t0) / 1000 : 0, levels: r.levels.slice(), url: r.url, dur: r.dur, wave: r.wave })
  }

  function end() {
    const r = parts.current
    if (r) {
      if (r.iv) clearInterval(r.iv)
      try {
        if (r.mr && r.mr.state !== 'inactive') {
          r.next = 'cancel'
          r.mr.stop()
        }
      } catch {
        // already stopped
      }
      r.stream?.getTracks().forEach((x) => x.stop())
      if (r.url) {
        voicePlayer.pause()
        const u = r.url
        setTimeout(() => URL.revokeObjectURL(u), 1000)
      }
    }
    parts.current = null
    if (liveRec === handle) liveRec = null
    show(null)
  }

  function stopped(r: RecParts) {
    r.stream?.getTracks().forEach((x) => x.stop())
    void r.ctx?.close().catch(() => undefined)
    if (parts.current !== r) return
    const blob = new Blob(r.chunks, { type: r.type })
    if (r.next === 'cancel' || !blob.size) return end()
    if ((r.dur ?? 0) < REC_MIN) {
      end()
      err.current(t.micHold)
      return
    }
    const wave = waveOf(r.samples)
    const rec: Recording = { blob, duration: Math.round(Math.min(REC_MAX, r.dur ?? 0) * 10) / 10, wave, type: r.type ?? blob.type }
    if (r.next === 'send') {
      end()
      done.current(rec)
      return
    }
    r.state = 'preview'
    r.blob = blob
    r.wave = wave
    r.url = URL.createObjectURL(blob)
    show(r)
  }

  function stop(next: 'send' | 'preview' | 'cancel') {
    const r = parts.current
    if (!r) return
    r.next = next
    if (r.state === 'starting') {
      r.cancelled = true
      end()
      return
    }
    if (r.state === 'preview') {
      if (next === 'cancel') end()
      return
    }
    if (r.iv) clearInterval(r.iv)
    r.dur = (performance.now() - r.t0) / 1000
    r.state = 'stopping'
    try {
      if (r.mr && r.mr.state !== 'inactive') r.mr.stop()
      else stopped(r)
    } catch {
      stopped(r)
    }
  }

  async function start(mode: RecMode) {
    if (parts.current) return
    if (liveRec && liveRec !== handle) liveRec.cancel()
    if (!canRecord()) {
      err.current(t.micNA)
      return
    }
    voicePlayer.pause()
    const r: RecParts = { mode, state: 'starting', chunks: [], samples: [], levels: [], t0: 0 }
    parts.current = r
    liveRec = handle
    show(r)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch (e) {
      if (parts.current === r) end()
      const n = (e as { name?: string })?.name ?? ''
      err.current(n === 'NotAllowedError' || n === 'SecurityError' ? t.micBlocked : n === 'NotFoundError' || n === 'OverconstrainedError' ? t.micNone : n === 'NotReadableError' || n === 'AbortError' ? t.micBusy : t.micNA)
      return
    }
    // Released while the permission prompt was up.
    if (parts.current !== r || r.cancelled) {
      stream.getTracks().forEach((x) => x.stop())
      if (r.early) err.current(t.micHold)
      return
    }
    r.stream = stream
    const ty = recType()
    try {
      r.mr = new MediaRecorder(stream, ty ? { mimeType: ty, audioBitsPerSecond: 32000 } : undefined)
    } catch {
      try {
        r.mr = new MediaRecorder(stream)
      } catch {
        stream.getTracks().forEach((x) => x.stop())
        end()
        err.current(t.micNA)
        return
      }
    }
    r.type = r.mr.mimeType || ty || 'audio/webm'
    r.mr.ondataavailable = (e) => {
      if (e.data && e.data.size) r.chunks.push(e.data)
    }
    r.mr.onstop = () => stopped(r)
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      r.ctx = new AC()
      r.an = r.ctx.createAnalyser()
      r.an.fftSize = 512
      r.ctx.createMediaStreamSource(stream).connect(r.an)
      r.buf = new Uint8Array(new ArrayBuffer(r.an.fftSize))
    } catch {
      // no meter, the recording still works
    }
    r.mr.start(250)
    r.t0 = performance.now()
    r.state = 'rec'
    r.iv = setInterval(() => {
      const el = (performance.now() - r.t0) / 1000
      let lv = 0
      if (r.an && r.buf) {
        r.an.getByteTimeDomainData(r.buf)
        lv = levelOf(r.buf)
      }
      r.samples.push(lv)
      r.levels.push(lv)
      if (r.levels.length > 48) r.levels.shift()
      show(r)
      if (el >= REC_MAX) {
        err.current(t.recMax)
        stop(r.mode === 'hold' ? 'send' : 'preview')
      }
    }, 90)
    show(r)
  }

  /** A hold released before the microphone even opened: tell them to hold. */
  function releaseEarly() {
    const r = parts.current
    if (!r) return false
    if (r.state === 'starting') {
      r.cancelled = true
      r.early = true
      end()
      return true
    }
    return false
  }

  function sendPreview() {
    const r = parts.current
    if (!r || r.state !== 'preview' || !r.blob) return
    const rec: Recording = { blob: r.blob, duration: Math.round(Math.min(REC_MAX, r.dur ?? 0) * 10) / 10, wave: r.wave ?? '', type: r.type ?? r.blob.type }
    end()
    done.current(rec)
  }

  useEffect(() => {
    stopRef.current = stop
  })
  useEffect(() => () => stopRef.current('cancel'), [])

  return { rec: view, start, stop, releaseEarly, sendPreview, cancel: () => stop('cancel') }
}
