'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { getVoiceToken } from '@/lib/telephony/actions'
import { INCOMING_PARAMS, type DialTarget, type VoiceSetup } from '@/lib/telephony/voice-contract'
import { MIC_PREF_KEY, SPEAKER_PREF_KEY, storedDeviceId } from '@/lib/telephony/ui/audio-prefs'
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
 *   clearing it mid-call drops the caller's audio, so it is never touched
 *   between those two moments.
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
  customParameters?: Map<string, string>
}

type SdkAudio = {
  setInputDevice(id: string): Promise<void>
  unsetInputDevice(): Promise<void>
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

  const endCall = useCallback(
    (call: SdkCall) => {
      if (activeRef.current !== call) return
      activeRef.current = null
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
    },
    [releaseAudio],
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
    [endCall],
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
      const device = new sdk.Device(token, {
        codecPreferences: ['opus', 'pcmu'],
        closeProtection: 'A call is in progress. Leaving this page will hang up.',
        logLevel: 'error',
      })
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
    }),
    [setup, leader, registered, status, who, answeredAt, muted, error, incoming, lastCall, activeTarget, lineId, call, hangup, toggleMute, sendDigits, accept, decline, clearError],
  )

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}
