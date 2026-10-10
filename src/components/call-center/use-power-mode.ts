'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { checkDial } from '@/lib/telephony/actions'
import type { DialCheck } from '@/lib/telephony/voice-contract'
import { actionFailure, thrownMessage } from '@/lib/telephony/ui/result'
import { nextPowerLead, type Ranked } from '@/lib/call-center/priority'
import type { CallLead } from '@/lib/call-center/model'
import type { VoiceContextValue } from '@/components/voice/voice-provider'

/** Seconds between a saved result and the next dial. */
export const POWER_COUNTDOWN_S = 5

const POWER_KEY = 'pf-desk-power'
const POWER_EVENT = 'pf-desk-power'

// Remembered per browser. Read through an external store so the server render
// (no window) and the first client render agree, and other tabs follow along.
function readPower(): boolean {
  try {
    return window.localStorage.getItem(POWER_KEY) === 'on'
  } catch {
    return false
  }
}

function subscribePower(onChange: () => void): () => void {
  window.addEventListener('storage', onChange)
  window.addEventListener(POWER_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(POWER_EVENT, onChange)
  }
}

function writePower(on: boolean): void {
  try {
    window.localStorage.setItem(POWER_KEY, on ? 'on' : 'off')
  } catch {
    // Private window: the toggle still works for this page view.
  }
  window.dispatchEvent(new Event(POWER_EVENT))
}

export type PowerPhase = 'idle' | 'countdown' | 'dialing' | 'stopped'

export type PowerMode = {
  on: boolean
  /** Browser calling is ready; power mode never uses the tel: flow. */
  usable: boolean
  phase: PowerPhase
  paused: boolean
  /** Whole seconds left in the countdown. */
  remaining: number
  /** The lead the countdown will dial. */
  next: Ranked | null
  /** Why power mode stopped, in the server's own words when it was a block. */
  stopReason: string | null
  stoppedLeadId: string | null
  toggle: () => void
  start: () => void
  pause: () => void
  skip: () => void
  /** The wrap-up result was saved: count down to the next lead. */
  afterWrapUp: () => void
}

type Deps = {
  voice: VoiceContextValue | null
  ranked: Ranked[]
  /** The lead just called (never re-dialled straight away). */
  lastLeadId: string | null
  /** A result is still owed for the last call. */
  wrapPending: boolean
  /** Lock the lead for this rep. Resolves to null, or the server's refusal. */
  take: (lead: CallLead) => Promise<string | null>
  /** Release a lead this rep took but power mode is passing over. */
  release: (lead: CallLead) => Promise<void>
  /** Show the lead being dialled. */
  select: (lead: CallLead) => void
}

/**
 * Power mode: after each call's result, count down 5 s and dial the next lead
 * in the Today ranking, through the same `checkDial` → `voice.call` path the
 * Call button uses (the `client/voice` webhook re-checks and is the authority).
 *
 * It never dials around anything: a compliance block, an hours prompt, an
 * unknown time zone, a missing line, or a failed connect stops it with the
 * reason shown; the rep fixes it with the lead's own Call button or skips.
 * Leads another rep holds or that are on do not call are passed over.
 */
export function usePowerMode({ voice, ranked, lastLeadId, wrapPending, take, release, select }: Deps): PowerMode {
  const on = useSyncExternalStore(subscribePower, readPower, () => false)
  const [phase, setPhase] = useState<PowerPhase>('idle')
  const [paused, setPaused] = useState(false)
  /** Milliseconds left on the countdown (state for drawing, ref for the clock). */
  const [leftMs, setLeftMs] = useState(0)
  const leftRef = useRef(0)
  /** Bumped by every fresh countdown so the clock restarts even mid-count. */
  const [round, setRound] = useState(0)
  const [skipped, setSkipped] = useState<string[]>([])
  const [stopReason, setStopReason] = useState<string | null>(null)
  const [stoppedLeadId, setStoppedLeadId] = useState<string | null>(null)
  const runningRef = useRef(false)
  const dialRef = useRef<() => Promise<void>>(async () => {})
  const usable = Boolean(voice)
  // Live values for the awaits inside dialNext: a dial that started before a
  // Pause, a power-off, an incoming call or leaving the page must not place a call.
  const genRef = useRef(0)
  const liveRef = useRef({ on, paused, voice })
  const mountedRef = useRef(true)
  /** voice.lastCall.seq when power mode placed its call; a newer seq means that call ended. */
  const dialSeqRef = useRef<number | null>(null)
  useEffect(() => {
    liveRef.current = { on, paused, voice }
  })
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      genRef.current += 1
    }
  }, [])

  const skipSet = new Set(skipped)
  const next = nextPowerLead(ranked, skipSet, lastLeadId)
  // A ringing incoming call, a call in progress, or a result still owed holds the countdown.
  const held = paused || wrapPending || Boolean(voice?.incoming) || (voice ? voice.status !== 'idle' : false)
  const remaining = phase === 'countdown' ? Math.max(0, Math.ceil(leftMs / 1000)) : 0

  const stop = useCallback((reason: string, leadId: string | null = null) => {
    setPhase('stopped')
    setStopReason(reason)
    setStoppedLeadId(leadId)
  }, [])

  const countdown = useCallback(() => {
    setStopReason(null)
    setStoppedLeadId(null)
    leftRef.current = POWER_COUNTDOWN_S * 1000
    setLeftMs(leftRef.current)
    setRound((n) => n + 1)
    setPhase('countdown')
  }, [])

  const dialNext = useCallback(async () => {
    if (runningRef.current || !voice) return
    runningRef.current = true
    const gen = ++genRef.current
    /** Still the dial the rep wants, with the phone free? Checked after every await. */
    const current = () => {
      const live = liveRef.current
      return (
        mountedRef.current &&
        genRef.current === gen &&
        live.on &&
        !live.paused &&
        Boolean(live.voice) &&
        live.voice?.status === 'idle' &&
        !live.voice?.incoming
      )
    }
    setPhase('dialing')
    let held: CallLead | null = null
    try {
      const passed = new Set(skipped)
      // Locks can be lost to another rep between ranking and taking: try the
      // next one, a few times, before giving up.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = nextPowerLead(ranked, passed, lastLeadId)
        if (!candidate) {
          stop('Nobody left to call right now.')
          return
        }
        const lead = candidate.lead
        select(lead)
        const refused = await take(lead)
        if (refused) {
          passed.add(lead.id)
          setSkipped((list) => [...list, lead.id])
          if (!current()) return
          continue
        }
        held = lead
        if (!current()) return
        let check: DialCheck
        try {
          const res = await checkDial({ kind: 'lead', id: lead.id }, voice.lineId ?? undefined)
          const failure = actionFailure(res)
          if (failure) {
            stop(failure.error, lead.id)
            return
          }
          check = res as DialCheck
        } catch (err) {
          stop(thrownMessage(err), lead.id)
          return
        }
        if (!check.ok) {
          const hint = check.canOverride === 'hours' || check.code === 'UNKNOWN_TIMEZONE'
            ? ' Use Call on the lead to sort it out, or Skip.'
            : ' Skip to move on.'
          stop(`${check.reason}${hint}`, lead.id)
          return
        }
        if (!current()) return
        held = null
        dialSeqRef.current = voice.lastCall?.seq ?? 0
        const placed = await voice.call({ kind: 'lead', id: lead.id }, check.line?.id ?? voice.lineId, check.overrideToken, check.who || lead.name)
        // The phone bar shows the provider's own reason.
        if (!placed) stop("The call didn't start. The phone bar says why.", lead.id)
        // A placed call stays in 'dialing' until it ends and its result is saved.
        return
      }
      stop('Every lead in reach is held by another rep.')
    } finally {
      runningRef.current = false
      // Cancelled between the lock and the dial: give the lead back, and leave
      // 'dialing' unless a newer action already moved the phase on.
      if (held && !current()) {
        void release(held)
        if (genRef.current === gen) setPhase('idle')
      }
    }
  }, [voice, skipped, ranked, lastLeadId, select, take, release, stop])

  // The placed call ended and nothing is owed (the result was saved during the
  // call, here or in another tab): count down again instead of waiting for a
  // wrap-up that will never show.
  const endedSeq = voice?.lastCall?.seq ?? 0
  const phoneIdle = voice?.status === 'idle'
  useEffect(() => {
    if (phase !== 'dialing' || runningRef.current || !phoneIdle || wrapPending) return
    if (dialSeqRef.current === null || endedSeq <= dialSeqRef.current) return
    // Next tick, so a wrap-up that this same render is about to show wins.
    const timer = window.setTimeout(() => {
      dialSeqRef.current = null
      if (on && usable && !paused) countdown()
      else setPhase('idle')
    }, 0)
    return () => window.clearTimeout(timer)
  }, [phase, phoneIdle, wrapPending, endedSeq, on, usable, paused, countdown])

  // The clock calls whatever dialNext is current, without restarting on every render.
  useEffect(() => {
    dialRef.current = dialNext
  }, [dialNext])

  // The countdown clock. Ticks only while counting and not held; a hold keeps
  // what was left, and the count carries on from there when it lifts.
  useEffect(() => {
    if (!on || !usable || phase !== 'countdown' || held) return
    const end = Date.now() + leftRef.current
    const timer = window.setInterval(() => {
      const left = Math.max(0, end - Date.now())
      leftRef.current = left
      setLeftMs(left)
      if (left === 0) {
        window.clearInterval(timer)
        void dialRef.current()
      }
    }, 200)
    return () => window.clearInterval(timer)
  }, [on, usable, phase, held, round])

  const toggle = useCallback(() => {
    const nextOn = !on
    genRef.current += 1
    liveRef.current = { ...liveRef.current, on: nextOn }
    writePower(nextOn)
    setPaused(false)
    setPhase('idle')
    setStopReason(null)
    setStoppedLeadId(null)
  }, [on])

  const start = useCallback(() => {
    if (!on || !usable) return
    // 'dialing' with the phone idle and nothing running is a stall: let Start clear it.
    if (phase === 'dialing' && (runningRef.current || voice?.status !== 'idle')) return
    setPaused(false)
    countdown()
  }, [on, usable, countdown, phase, voice?.status])

  // Pause holds the count where it is; pressing it again carries on. Pressed
  // while a dial is being prepared, it cancels that dial before it rings.
  const pause = useCallback(() => {
    if (phase === 'dialing' && runningRef.current) {
      genRef.current += 1
      liveRef.current = { ...liveRef.current, paused: true }
      setPaused(true)
      setPhase('idle')
      return
    }
    // On a power-mode call: pausing means "don't go on to the next one after this".
    if (phase !== 'countdown' && phase !== 'dialing') return
    setPaused((p) => !p)
  }, [phase])

  const skip = useCallback(() => {
    if (phase === 'countdown' && next) {
      setSkipped((list) => [...list, next.lead.id])
      countdown()
      return
    }
    if (phase === 'stopped' && stoppedLeadId) {
      const lead = ranked.find((row) => row.lead.id === stoppedLeadId)?.lead
      setSkipped((list) => [...list, stoppedLeadId])
      if (lead) void release(lead)
      countdown()
    }
  }, [phase, next, stoppedLeadId, ranked, release, countdown])

  const afterWrapUp = useCallback(() => {
    if (on && usable) countdown()
  }, [on, usable, countdown])

  return {
    on: on && usable,
    usable,
    phase: on && usable ? phase : 'idle',
    paused,
    remaining,
    next,
    stopReason,
    stoppedLeadId,
    toggle,
    start,
    pause,
    skip,
    afterWrapUp,
  }
}
