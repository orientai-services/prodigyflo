'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getVoiceToken } from '@/lib/telephony/actions'
import { INCOMING_PARAMS, type DialTarget, type VoiceSetup } from '@/lib/telephony/voice-contract'
import { type Edge, type LiveLevel, edgePlan, liveQuality, maxBitrate } from '@/lib/telephony/quality'
import { MIC_PREF_KEY, SPEAKER_PREF_KEY, storedDeviceId } from '@/lib/telephony/ui/audio-prefs'
import {
  browserTimeZone,
  readLowData,
  readMeasuredEdge,
  readRingMuted,
  writeLowData,
  writeMeasuredEdge,
  writeRingMuted,
} from '@/lib/telephony/ui/voice-prefs'
import { actionFailure } from '@/lib/telephony/ui/result'

/**
 * Browser calling (plan §2.3, §6.1). Mounted by the app layout only when
 * `getVoiceSetup()` says ready, so with VOICE_BROWSER_ENABLED off none of
 * this runs and the SDK is never fetched.
 *
 * Three rules shape it:
 *
 * - The Twilio Voice SDK (~179 KB) loads with a dynamic `import()` on first
 *   need, never in the shared chunk every page downloads.
 * - One `Device` per tab, but only ONE tab per browser registers for incoming
 *   calls (the leader, elected over localStorage + BroadcastChannel). Two
 *   registered tabs would both ring and both post presence; the others say
 *   "Calls ring in your other tab." and can still place calls.
 * - The microphone is taken when a call starts and released when it ends. A
 *   held input device blocks other apps (video meetings) from the headset, and
 *   clearing it mid-call drops the caller's audio, so it is never unset
 *   between those two moments. The one mid-call change is failover: when the
 *   mic's track goes silent-muted for 1.2 s or ends (headset unplugged, dead
 *   battery) the call moves to another live mic, and back to the rep's own
 *   pick when it reappears. Moving between two live mics keeps the audio up.
 *
 * Connection quality (docs/DIALER_POWER.md Lane B): the Device's edge list
 * comes from the browser's time zone, led by the edge the last full "Test
 * connection" measured; low-data mode caps Opus at 16 kbps. The call bar's
 * light follows the SDK's `warning`/`warning-cleared` events; the thresholds
 * and wording live in lib/telephony/quality.ts.
 *
 * The browser sends only the custom params `target`, `line` and `override`.
 * The server resolves the number, the caller ID and the compliance decision
 * from those; nothing else from here is trusted.
 */

// ── The small slice of the SDK this file uses ────────────────────────────────
// Typed locally so the SDK stays a dynamic import and its types never shape
// the rest of the app.

type Listener = (...args: unknown[]) => void

type SdkCall = {
  on(event: string, fn: Listener): unknown
  accept(): void
  reject(): void
  disconnect(): void
  mute(shouldMute?: boolean): void
  isMuted(): boolean
  sendDigits(digits: string): void
  getLocalStream?(): MediaStream | undefined
  customParameters?: Map<string, string>
}

type SdkAudio = {
  setInputDevice(id: string): Promise<void>
  unsetInputDevice(): Promise<void>
  /** Enables/disables the incoming ringtone; returns the new state. */
  incoming(enable?: boolean): boolean
  inputDevice?: MediaDeviceInfo | null
  /** 'deviceChange' fires with the active devices that were unplugged. */
  on?(event: string, fn: Listener): unknown
  removeListener?(event: string, fn: Listener): unknown
  isOutputSelectionSupported: boolean
  speakerDevices: { set(ids: string | string[]): Promise<void> }
  ringtoneDevices: { set(ids: string | string[]): Promise<void> }
}

type SdkDevice = {
  on(event: string, fn: Listener): unknown
  register(): Promise<void>
  unregister(): Promise<void>
  destroy(): void
  updateToken(token: string): void
  /** Throws if the edge changes while a call is up. */
  updateOptions(options: Record<string, unknown>): void
  connect(options: { params: Record<string, string> }): Promise<SdkCall>
  audio?: SdkAudio | null
}

type SdkModule = { Device: new (token: string, options?: Record<string, unknown>) => SdkDevice }

// ── What the rest of the app sees ────────────────────────────────────────────

export type ReadyVoiceSetup = Extract<VoiceSetup, { ready: true }>

export type VoiceStatus = 'idle' | 'connecting' | 'ringing' | 'in-call'

export type IncomingVM = {
  callId: string
  caller: string
  line: string
  /** 'client:<id>' | 'lead:<id>' | '' */
  target: string
}

/**
 * The call that just ended, for the desk's wrap-up and power mode. `seq`
 * changes on every end so a consumer can react once per call.
 */
export type EndedCall = {
  seq: number
  /** 'lead:<id>' | 'client:<id>' | 'missed:<id>' | '' */
  target: string
  direction: 'outbound' | 'inbound'
  who: string | null
  /** The other side picked up (the SDK reported accept). */
  answered: boolean
  talkSeconds: number
  endedAt: number
  /** Plain-words reason when the call ended on an error. */
  error: string | null
}

/** The call bar's quality light for the call in progress. */
export type LiveCallQuality = {
  level: LiveLevel
  /** One plain-English tip for the most urgent warning, or null when all is well. */
  tip: string | null
  /** Latest mean opinion score (1–4.5), once the SDK has computed one. */
  mos: number | null
}

/** How this browser connects: the edge list handed to Device, and low-data mode. */
export type VoiceConnection = {
  edges: Edge[]
  /** The edge the last full test measured, which leads `edges`. */
  measuredEdge: Edge | null
  lowData: boolean
}

export type VoiceContextValue = {
  setup: ReadyVoiceSetup
  /** This tab is the one that rings. */
  leader: boolean
  registered: boolean
  status: VoiceStatus
  who: string | null
  answeredAt: number | null
  muted: boolean
  error: string | null
  incoming: IncomingVM | null
  /** The last call that ended in this tab, or null. */
  lastCall: EndedCall | null
  /** 'lead:<id>' | 'client:<id>' | 'missed:<id>' of the call in progress, or null. */
  activeTarget: string | null
  lineId: string | null
  setLineId: (id: string) => void
  call: (target: DialTarget, lineId?: string | null, override?: string, who?: string) => Promise<boolean>
  hangup: () => void
  toggleMute: () => void
  sendDigits: (digits: string) => void
  accept: () => Promise<void>
  decline: () => void
  clearError: () => void
  /** Null when no call is in progress. */
  callQuality: LiveCallQuality | null
  ringtoneMuted: boolean
  setRingtoneMuted: (muted: boolean) => void
  connection: VoiceConnection
  /**
   * Save the edge a full test measured and/or low-data mode. Applied to the
   * Device right away when idle, otherwise as soon as the call ends.
   */
  applyConnection: (next: { edge?: Edge | null; lowData?: boolean }) => void
}

const VoiceContext = createContext<VoiceContextValue | null>(null)

/** The voice context, or null when browser calling isn't set up (the `tel:` flow applies). */
export function useVoice(): VoiceContextValue | null {
  return useContext(VoiceContext)
}

const LEADER_KEY = 'pf-voice-leader'
const CHANNEL = 'pf-voice'
const LEADER_BEAT_MS = 4_000
const LEADER_STALE_MS = 12_000
const PRESENCE_EVERY_MS = 60_000
/** A mic track muted this long mid-call is treated as gone (contract: 1.2 s). */
const MIC_DEAD_MS = 1_200
/** Failovers per call before giving up and telling the rep, so a flapping mic can't loop. */
const MAX_FAILOVERS = 3

/** The edge list and bitrate cap from this browser's saved preferences. */
function readConnection(): VoiceConnection {
  const measuredEdge = readMeasuredEdge()
  return { edges: edgePlan(browserTimeZone(), measuredEdge), measuredEdge, lowData: readLowData() }
}

function deviceLabel(d: MediaDeviceInfo | undefined, fallback: string): string {
  const label = d?.label.replace(/^(Default|Communications)\s*-\s*/i, '').trim()
  return label || fallback
}

export function targetParam(target: DialTarget): string {
  return `${target.kind}:${target.id}`
}

/** SDK and carrier errors in plain words. */
export function plainVoiceError(err: unknown): string {
  const e = err as { code?: number; name?: string; message?: string } | null
  const code = typeof e?.code === 'number' ? e.code : null
  if (e?.name === 'NotAllowedError' || code === 31401 || code === 31402 || code === 31208) {
    return 'Allow the microphone to make and take calls.'
  }
  if (code === 20101 || code === 20104 || code === 31204 || code === 31205) {
    return 'Your phone session expired. Reload the page.'
  }
  if (code === 31005 || code === 31009 || code === 31003 || (code !== null && code >= 53000 && code < 54000)) {
    return 'Lost the connection to the phone service. Check the internet and try again.'
  }
  if (code === 31486) return 'The line was busy.'
  if (code === 31480) return "They didn't pick up."
  if (code === 31603) return 'The call was declined.'
  return code ? `The call ended with an error (code ${code}).` : 'The call ended with an error.'
}

function newTabId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

function postPresence(state: 'ready' | 'offline', beacon = false): void {
  const body = JSON.stringify({ state })
  try {
    if (beacon && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/voice/presence', body)
      return
    }
    void fetch('/api/voice/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Presence is best effort; the server expires it after 90 seconds anyway.
  }
}

export function VoiceProvider({ setup, children }: { setup: ReadyVoiceSetup; children: React.ReactNode }) {
  const [leader, setLeader] = useState(false)
  const [registered, setRegistered] = useState(false)
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [who, setWho] = useState<string | null>(null)
  const [answeredAt, setAnsweredAt] = useState<number | null>(null)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [incoming, setIncoming] = useState<IncomingVM | null>(null)
  const [lastCall, setLastCall] = useState<EndedCall | null>(null)
  const [activeTarget, setActiveTarget] = useState<string | null>(null)
  const [lineId, setLineId] = useState<string | null>(
    () => setup.lines.find((l) => l.isDefault)?.id ?? setup.lines[0]?.id ?? null,
  )

  const deviceRef = useRef<SdkDevice | null>(null)
  const loadingRef = useRef<Promise<SdkDevice | null> | null>(null)
  const activeRef = useRef<SdkCall | null>(null)
  const incomingRef = useRef<SdkCall | null>(null)
  const micHeldRef = useRef(false)
  /** What the active call is about, kept beside activeRef for the ended-call record. */
  const metaRef = useRef<{ target: string; direction: 'outbound' | 'inbound'; who: string | null; answeredAt: number | null; error: string | null } | null>(null)
  const seqRef = useRef(0)
  const unmountedRef = useRef(false)

  // Quality, failover and connection prefs. Prefs start at their defaults and
  // are read from localStorage after mount, so the server render and the
  // first client render agree.
  const [callQuality, setCallQuality] = useState<LiveCallQuality | null>(null)
  const [ringtoneMuted, setRingtoneMutedState] = useState(false)
  const [connection, setConnection] = useState<VoiceConnection>({ edges: ['roaming'], measuredEdge: null, lowData: false })
  const ringMutedRef = useRef(false)
  /** Connection prefs changed during a call; apply them when it ends. */
  const optionsPendingRef = useRef(false)
  /** Undo for the current call's mic-track watcher and devicechange listener. */
  const micWatchRef = useRef<(() => void) | null>(null)
  const returnWatchRef = useRef<(() => void) | null>(null)
  const lostWatchRef = useRef<(() => void) | null>(null)
  const failoversRef = useRef(0)

  // ── Microphone: taken at call start, released at call end ────────────────

  const takeAudio = useCallback(async (device: SdkDevice) => {
    const audio = device.audio
    if (!audio) return
    const mic = await storedDeviceId(MIC_PREF_KEY, 'audioinput')
    if (mic) {
      try {
        await audio.setInputDevice(mic)
        micHeldRef.current = true
      } catch {
        // The SDK falls back to the system default microphone.
      }
    }
    const speaker = await storedDeviceId(SPEAKER_PREF_KEY, 'audiooutput')
    if (speaker && audio.isOutputSelectionSupported) {
      await audio.speakerDevices.set(speaker).catch(() => {})
    }
  }, [])

  const releaseAudio = useCallback(() => {
    const audio = deviceRef.current?.audio
    if (!audio || !micHeldRef.current) return
    micHeldRef.current = false
    void audio.unsetInputDevice().catch(() => {})
  }, [])

  // ── Audio failover: a dead mic mid-call moves to a live one ──────────────

  const stopMicWatch = useCallback(() => {
    micWatchRef.current?.()
    micWatchRef.current = null
    returnWatchRef.current?.()
    returnWatchRef.current = null
    lostWatchRef.current?.()
    lostWatchRef.current = null
  }, [])

  const startMicWatch = useCallback((call: SdkCall) => {
    stopMicWatch()
    // Watches the call's current input track. Re-armed after every switch,
    // because a new device means a new track.
    const watch = () => {
      micWatchRef.current?.()
      micWatchRef.current = null
      if (activeRef.current !== call) return
      const track = call.getLocalStream?.()?.getAudioTracks()[0]
      if (!track) return
      let timer: number | null = null
      const cleanup = () => {
        if (timer !== null) window.clearTimeout(timer)
        timer = null
        track.removeEventListener('mute', onMute)
        track.removeEventListener('unmute', onUnmute)
        track.removeEventListener('ended', onEnded)
      }
      const dead = () => {
        cleanup()
        if (micWatchRef.current === cleanup) micWatchRef.current = null
        void failover(track)
      }
      // `muted` here is the browser saying no audio is arriving from the
      // device (not the rep's mute button, which disables the track instead).
      const onMute = () => {
        if (timer === null) timer = window.setTimeout(dead, MIC_DEAD_MS)
      }
      const onUnmute = () => {
        if (timer !== null) window.clearTimeout(timer)
        timer = null
      }
      const onEnded = () => dead()
      track.addEventListener('mute', onMute)
      track.addEventListener('unmute', onUnmute)
      track.addEventListener('ended', onEnded)
      micWatchRef.current = cleanup
      if (track.readyState === 'ended') dead()
      else if (track.muted) onMute()
    }

    const failover = async (deadTrack: MediaStreamTrack) => {
      const audio = deviceRef.current?.audio
      if (!audio || activeRef.current !== call) return
      if (failoversRef.current >= MAX_FAILOVERS) {
        toast.error('Your microphone keeps cutting out. Check the headset, or hang up and pick another mic in Phone settings.')
        return
      }
      failoversRef.current += 1
      let devices: MediaDeviceInfo[] = []
      try {
        devices = await navigator.mediaDevices.enumerateDevices()
      } catch {
        devices = []
      }
      const inputs = devices.filter((d) => d.kind === 'audioinput')
      const deadId = audio.inputDevice?.deviceId ?? deadTrack.getSettings?.().deviceId ?? ''
      // The OS default follows the unplug (it moves to the laptop mic), so it
      // is the right place to land; browsers without the alias get the first
      // other mic.
      const next = inputs.find((d) => d.deviceId === 'default') ?? inputs.find((d) => d.deviceId && d.deviceId !== deadId && d.deviceId !== 'communications')
      if (!next || activeRef.current !== call) {
        toast.error('Your microphone stopped and no other one was found. Plug one in to keep talking.')
        return
      }
      try {
        await audio.setInputDevice(next.deviceId)
        micHeldRef.current = true
      } catch {
        toast.error('Your microphone stopped. Check the headset.')
        return
      }
      if (activeRef.current !== call) return
      toast.warning(`Your microphone stopped. Switched to ${deviceLabel(next, 'the system microphone')}.`)
      watch()
      watchForReturn()
    }

    // After a failover, the rep's own pick wins again as soon as it is back.
    const watchForReturn = () => {
      const media = navigator.mediaDevices
      if (returnWatchRef.current || !media?.addEventListener) return
      const onChange = () => {
        void (async () => {
          const audio = deviceRef.current?.audio
          if (!audio || activeRef.current !== call) return
          const mine = await storedDeviceId(MIC_PREF_KEY, 'audioinput')
          if (!mine || audio.inputDevice?.deviceId === mine) return
          try {
            await audio.setInputDevice(mine)
            micHeldRef.current = true
          } catch {
            return
          }
          if (activeRef.current !== call) return
          returnWatchRef.current?.()
          returnWatchRef.current = null
          const devices = await media.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
          toast.success(`Back on ${deviceLabel(devices.find((d) => d.deviceId === mine), 'your microphone')}.`)
          watch()
        })()
      }
      media.addEventListener('devicechange', onChange)
      returnWatchRef.current = () => media.removeEventListener('devicechange', onChange)
    }

    // An unplugged device is handled by the SDK itself (it moves the call to
    // the default mic and stops the old track without an 'ended' event), so
    // listen for that too: say so, re-arm the watcher on the new track, and
    // wait for the rep's own mic to come back.
    const audio = deviceRef.current?.audio
    if (audio?.on && audio.removeListener) {
      const onLost = (lost: unknown) => {
        if (activeRef.current !== call) return
        const devices = Array.isArray(lost) ? (lost as MediaDeviceInfo[]) : []
        if (!devices.some((d) => d.kind === 'audioinput')) return
        micHeldRef.current = true
        toast.warning('Your microphone was unplugged. Switched to the system microphone.')
        window.setTimeout(watch, 1_000)
        watchForReturn()
      }
      audio.on('deviceChange', onLost)
      lostWatchRef.current = () => audio.removeListener?.('deviceChange', onLost)
    }

    failoversRef.current = 0
    watch()
  }, [stopMicWatch])

  // ── Connection prefs → the Device ────────────────────────────────────────

  const syncDeviceOptions = useCallback(() => {
    const device = deviceRef.current
    if (!device) return
    if (activeRef.current) {
      optionsPendingRef.current = true
      return
    }
    const next = readConnection()
    try {
      device.updateOptions({ edge: next.edges, maxAverageBitrate: maxBitrate(next.lowData) })
      optionsPendingRef.current = false
    } catch {
      optionsPendingRef.current = true
    }
    // updateOptions rebuilds the SDK's sounds; keep the ringtone choice.
    device.audio?.incoming(!ringMutedRef.current)
  }, [])

  const endCall = useCallback(
    (call: SdkCall) => {
      if (activeRef.current !== call) return
      activeRef.current = null
      stopMicWatch()
      setCallQuality(null)
      const meta = metaRef.current
      metaRef.current = null
      if (meta) {
        const endedAt = Date.now()
        seqRef.current += 1
        setLastCall({
          seq: seqRef.current,
          target: meta.target,
          direction: meta.direction,
          who: meta.who,
          answered: meta.answeredAt !== null,
          talkSeconds: meta.answeredAt ? Math.max(0, Math.round((endedAt - meta.answeredAt) / 1000)) : 0,
          endedAt,
          error: meta.error,
        })
      }
      setActiveTarget(null)
      setStatus('idle')
      setWho(null)
      setAnsweredAt(null)
      setMuted(false)
      releaseAudio()
      // The SDK still counts the call as busy while it emits 'disconnect'.
      if (optionsPendingRef.current) window.setTimeout(syncDeviceOptions, 500)
    },
    [releaseAudio, stopMicWatch, syncDeviceOptions],
  )

  const watchCall = useCallback(
    (call: SdkCall) => {
      call.on('ringing', () => {
        if (activeRef.current === call) setStatus('ringing')
      })
      call.on('accept', () => {
        if (activeRef.current !== call) return
        const at = Date.now()
        if (metaRef.current) metaRef.current.answeredAt = at
        setStatus('in-call')
        setAnsweredAt(at)
        setCallQuality({ level: 'good', tip: null, mos: null })
        startMicWatch(call)
      })
      // The live light: warnings the SDK has raised and not yet cleared.
      // (The SDK holds them back for the first ~5 s, which are always choppy.)
      const active = new Set<string>()
      let mos: number | null = null
      const showQuality = () => {
        if (activeRef.current !== call) return
        const { level, tip } = liveQuality(active)
        setCallQuality((prev) =>
          prev && prev.level === level && prev.tip === tip && prev.mos === mos ? prev : { level, tip, mos },
        )
      }
      call.on('warning', (name) => {
        if (typeof name !== 'string') return
        active.add(name)
        showQuality()
      })
      call.on('warning-cleared', (name) => {
        if (typeof name !== 'string') return
        active.delete(name)
        showQuality()
      })
      call.on('sample', (sample) => {
        const value = (sample as { mos?: number | null } | null)?.mos
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return
        const rounded = Math.round(value * 10) / 10
        if (rounded === mos) return
        mos = rounded
        showQuality()
      })
      call.on('mute', (isMuted) => {
        if (activeRef.current === call) setMuted(Boolean(isMuted))
      })
      call.on('disconnect', () => endCall(call))
      call.on('cancel', () => endCall(call))
      call.on('reject', () => endCall(call))
      call.on('error', (err) => {
        const message = plainVoiceError(err)
        if (activeRef.current === call && metaRef.current) metaRef.current.error = message
        setError(message)
        endCall(call)
      })
    },
    [endCall, startMicWatch],
  )

  // ── The Device: created on first need, one per tab ───────────────────────

  const fetchToken = useCallback(async (): Promise<string | null> => {
    try {
      const res = await getVoiceToken()
      const failure = actionFailure(res)
      if (failure) {
        setError(failure.error)
        return null
      }
      return (res as { token: string }).token
    } catch {
      setError('Could not start the phone. Reload the page and try again.')
      return null
    }
  }, [])

  const ensureDevice = useCallback(async (): Promise<SdkDevice | null> => {
    if (deviceRef.current) return deviceRef.current
    if (loadingRef.current) return loadingRef.current
    loadingRef.current = (async () => {
      const token = await fetchToken()
      if (!token) return null
      let sdk: SdkModule
      try {
        sdk = (await import('@twilio/voice-sdk')) as unknown as SdkModule
      } catch {
        setError('Could not load the phone. Reload the page and try again.')
        return null
      }
      if (unmountedRef.current) return null
      const conn = readConnection()
      const device = new sdk.Device(token, {
        codecPreferences: ['opus', 'pcmu'],
        closeProtection: 'A call is in progress. Leaving this page will hang up.',
        logLevel: 'error',
        // Nearest edge first; the SDK falls through the list if one is down.
        edge: conn.edges,
        maxAverageBitrate: maxBitrate(conn.lowData),
      })
      device.audio?.incoming(!ringMutedRef.current)
      device.on('registered', () => setRegistered(true))
      device.on('unregistered', () => setRegistered(false))
      device.on('error', (err) => setError(plainVoiceError(err)))
      device.on('tokenWillExpire', () => {
        void fetchToken().then((next) => {
          if (next) device.updateToken(next)
        })
      })
      device.on('incoming', (raw) => {
        const call = raw as SdkCall
        const param = (name: (typeof INCOMING_PARAMS)[number]) => call.customParameters?.get(name) ?? ''
        incomingRef.current = call
        setIncoming({
          callId: param('pfCallId'),
          caller: param('pfCaller') || 'Unknown caller',
          line: param('pfLine'),
          target: param('pfTarget'),
        })
        const clear = () => {
          if (incomingRef.current !== call) return
          incomingRef.current = null
          setIncoming(null)
        }
        call.on('cancel', clear)
        call.on('disconnect', clear)
        call.on('reject', clear)
        call.on('error', clear)
      })
      deviceRef.current = device
      return device
    })()
    try {
      return await loadingRef.current
    } finally {
      loadingRef.current = null
    }
  }, [fetchToken])

  // Saved prefs, read once after mount (localStorage is browser-only).
  useEffect(() => {
    ringMutedRef.current = readRingMuted()
    setRingtoneMutedState(ringMutedRef.current)
    setConnection(readConnection())
  }, [])

  // ── Leader election: one ringing tab per browser ─────────────────────────

  useEffect(() => {
    unmountedRef.current = false
    const me = newTabId()
    let channel: BroadcastChannel | null = null
    let isLeader = false

    const read = (): { id: string; at: number } | null => {
      try {
        const raw = window.localStorage.getItem(LEADER_KEY)
        return raw ? (JSON.parse(raw) as { id: string; at: number }) : null
      } catch {
        return null
      }
    }

    const tick = () => {
      let next = true
      try {
        const current = read()
        if (!current || current.id === me || Date.now() - current.at > LEADER_STALE_MS) {
          window.localStorage.setItem(LEADER_KEY, JSON.stringify({ id: me, at: Date.now() }))
          next = read()?.id === me
        } else {
          next = false
        }
      } catch {
        // No storage (private window): this tab rings on its own.
        next = true
      }
      if (next !== isLeader) {
        isLeader = next
        setLeader(next)
      }
    }

    try {
      channel = new BroadcastChannel(CHANNEL)
      channel.onmessage = (event) => {
        if (event.data === 'gone') tick()
      }
    } catch {
      channel = null
    }

    tick()
    const timer = window.setInterval(tick, LEADER_BEAT_MS)

    const leave = () => {
      if (!isLeader) return
      postPresence('offline', true)
      try {
        if (read()?.id === me) window.localStorage.removeItem(LEADER_KEY)
      } catch {
        // Stale leadership expires on its own.
      }
      channel?.postMessage('gone')
    }
    window.addEventListener('pagehide', leave)

    return () => {
      unmountedRef.current = true
      window.clearInterval(timer)
      window.removeEventListener('pagehide', leave)
      leave()
      channel?.close()
      micWatchRef.current?.()
      returnWatchRef.current?.()
      lostWatchRef.current?.()
      deviceRef.current?.destroy()
      deviceRef.current = null
    }
  }, [])

  // The leader registers for incoming calls; a tab that loses leadership stops.
  useEffect(() => {
    let cancelled = false
    if (leader) {
      void ensureDevice().then((device) => {
        if (!device || cancelled) return
        device.register().catch((err: unknown) => setError(plainVoiceError(err)))
      })
    } else if (deviceRef.current) {
      void deviceRef.current.unregister().catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [leader, ensureDevice])

  // Presence heartbeat while this tab can ring.
  useEffect(() => {
    if (!leader || !registered) return
    postPresence('ready')
    const timer = window.setInterval(() => postPresence('ready'), PRESENCE_EVERY_MS)
    return () => {
      window.clearInterval(timer)
      postPresence('offline')
    }
  }, [leader, registered])

  // ── Actions ──────────────────────────────────────────────────────────────

  const call = useCallback(
    async (target: DialTarget, chosenLine?: string | null, override?: string, label?: string) => {
      if (activeRef.current) {
        setError('Hang up the current call first.')
        return false
      }
      const line = chosenLine ?? lineId
      if (!line) {
        setError('This account has no phone line yet.')
        return false
      }
      setError(null)
      setStatus('connecting')
      setWho(label ?? null)
      const device = await ensureDevice()
      if (!device) {
        setStatus('idle')
        return false
      }
      await takeAudio(device)
      const params: Record<string, string> = { target: targetParam(target), line }
      if (override) params.override = override
      try {
        const placed = await device.connect({ params })
        activeRef.current = placed
        metaRef.current = { target: params.target, direction: 'outbound', who: label ?? null, answeredAt: null, error: null }
        setActiveTarget(params.target)
        watchCall(placed)
        return true
      } catch (err) {
        setError(plainVoiceError(err))
        setStatus('idle')
        setWho(null)
        releaseAudio()
        return false
      }
    },
    [ensureDevice, lineId, releaseAudio, takeAudio, watchCall],
  )

  const accept = useCallback(async () => {
    const ringing = incomingRef.current
    if (!ringing) return
    if (activeRef.current) {
      setError('Hang up the current call first.')
      return
    }
    const device = deviceRef.current
    if (device) await takeAudio(device)
    incomingRef.current = null
    setWho(incoming?.caller ?? null)
    setIncoming(null)
    activeRef.current = ringing
    const at = Date.now()
    metaRef.current = { target: incoming?.target ?? '', direction: 'inbound', who: incoming?.caller ?? null, answeredAt: at, error: null }
    setActiveTarget(incoming?.target || null)
    watchCall(ringing)
    setStatus('in-call')
    setAnsweredAt(at)
    try {
      ringing.accept()
    } catch (err) {
      setError(plainVoiceError(err))
      endCall(ringing)
    }
  }, [endCall, incoming, takeAudio, watchCall])

  const decline = useCallback(() => {
    const ringing = incomingRef.current
    incomingRef.current = null
    setIncoming(null)
    try {
      ringing?.reject()
    } catch {
      // Already gone.
    }
  }, [])

  const hangup = useCallback(() => {
    const current = activeRef.current
    if (!current) return
    try {
      current.disconnect()
    } catch {
      endCall(current)
    }
  }, [endCall])

  const toggleMute = useCallback(() => {
    const current = activeRef.current
    if (!current) return
    const next = !current.isMuted()
    current.mute(next)
    setMuted(next)
  }, [])

  const sendDigits = useCallback((digits: string) => {
    activeRef.current?.sendDigits(digits)
  }, [])

  const clearError = useCallback(() => setError(null), [])

  const setRingtoneMuted = useCallback((next: boolean) => {
    ringMutedRef.current = next
    setRingtoneMutedState(next)
    writeRingMuted(next)
    deviceRef.current?.audio?.incoming(!next)
  }, [])

  const applyConnection = useCallback(
    (next: { edge?: Edge | null; lowData?: boolean }) => {
      if (next.edge !== undefined) writeMeasuredEdge(next.edge)
      if (next.lowData !== undefined) writeLowData(next.lowData)
      setConnection(readConnection())
      syncDeviceOptions()
    },
    [syncDeviceOptions],
  )

  const value = useMemo<VoiceContextValue>(
    () => ({
      setup,
      leader,
      registered,
      status,
      who,
      answeredAt,
      muted,
      error,
      incoming,
      lastCall,
      activeTarget,
      lineId,
      setLineId,
      call,
      hangup,
      toggleMute,
      sendDigits,
      accept,
      decline,
      clearError,
      callQuality,
      ringtoneMuted,
      setRingtoneMuted,
      connection,
      applyConnection,
    }),
    [
      setup, leader, registered, status, who, answeredAt, muted, error, incoming, lastCall, activeTarget, lineId,
      call, hangup, toggleMute, sendDigits, accept, decline, clearError,
      callQuality, ringtoneMuted, setRingtoneMuted, connection, applyConnection,
    ],
  )

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}
