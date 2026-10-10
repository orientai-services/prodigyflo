'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Bell, BellOff, Grid3x3, Mic, MicOff, Phone, PhoneOff, Settings2, X } from 'lucide-react'
import { dockVisible } from '@/lib/telephony/ui/dock'
import { clockLabel } from '@/lib/telephony/ui/result'
import { AudioSettings } from './audio-settings'
import { ConnectionTest } from './connection-test'
import { useVoice } from './voice-provider'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const

// "On call 1:23 · " in front of the page's own title, so the talk time shows
// on the tab while the rep works in another one. Stripped and re-added each
// tick, so a page that changes its title mid-call keeps its new title.
const TITLE_PREFIX = /^On call \d+:\d{2} · /

const LIGHT: Record<'good' | 'warn' | 'bad', { dot: string; text: string; label: string }> = {
  good: {
    dot: 'bg-emerald-500',
    text: 'text-muted-foreground',
    label: 'Call quality is good',
  },
  warn: {
    dot: 'bg-amber-500',
    text: 'text-amber-800 dark:text-amber-300',
    label: 'Call quality is shaky',
  },
  bad: {
    dot: 'bg-red-500',
    text: 'text-red-700 dark:text-red-300',
    label: 'Call quality is poor',
  },
}

/** Phone layout: the bar spans the screen below this width (Tailwind `sm`). */
const PHONE_QUERY = '(max-width: 639.98px)'

/**
 * The call bar: bottom right on a desk, a full-width bottom sheet on a phone.
 * It lives in Call Center; elsewhere it shows only for a call in progress
 * (`dockVisible`). On a phone the page gets bottom padding equal to the bar's
 * height so nothing hides under it, and `--voice-dock-h` carries that height
 * for pages that pin their own bars above it.
 * Idle it folds to a small round pill in the corner (status dot + phone icon)
 * that reserves no page space; tapping it opens the sheet with the state line,
 * ringtone and phone settings. During a call it shows who, the talk timer,
 * the quality light (one tip when it isn't green), mute, keypad and hang up.
 * Errors keep the sheet open until dismissed, in plain words, because a rep
 * who looked away must still learn why the call dropped.
 */
export function VoiceDock() {
  const voice = useVoice()
  const pathname = usePathname()
  const barRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [keypad, setKeypad] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const answeredAt = voice?.answeredAt ?? null
  useEffect(() => {
    if (!answeredAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [answeredAt])

  // Talk timer in the tab title during a call.
  const inCall = voice?.status === 'in-call' && answeredAt !== null
  const talk = inCall ? clockLabel((now - answeredAt) / 1000) : null
  useEffect(() => {
    if (!talk) return
    document.title = `On call ${talk} · ${document.title.replace(TITLE_PREFIX, '')}`
  }, [talk])
  useEffect(() => {
    if (inCall) return
    if (TITLE_PREFIX.test(document.title)) document.title = document.title.replace(TITLE_PREFIX, '')
  }, [inCall])

  const visible = Boolean(
    voice &&
      dockVisible({
        pathname,
        status: voice.status,
        callError: Boolean(voice.error && voice.lastCall?.error === voice.error),
      }),
  )

  // The sheet shows for a call, for an error, or when the rep opened settings;
  // otherwise the pill.
  const status = voice?.status ?? 'idle'
  const expanded = status !== 'idle' || open || Boolean(voice?.error)

  // Reserve the sheet's height at the bottom of the page on a phone. The pill
  // reserves nothing.
  useEffect(() => {
    const bar = barRef.current
    if (!visible || !expanded || !bar) return
    const root = document.documentElement
    const phone = window.matchMedia(PHONE_QUERY)
    const apply = () => {
      const height = Math.ceil(bar.getBoundingClientRect().height)
      root.style.setProperty('--voice-dock-h', phone.matches ? `${height}px` : '0px')
      document.body.style.paddingBottom = phone.matches ? `${height}px` : ''
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(bar)
    phone.addEventListener('change', apply)
    return () => {
      observer.disconnect()
      phone.removeEventListener('change', apply)
      root.style.removeProperty('--voice-dock-h')
      document.body.style.paddingBottom = ''
    }
  }, [visible, expanded])

  if (!voice || !visible) return null
  const { setup, leader, registered } = voice
  const busy = status !== 'idle'
  const showKeypad = keypad && status === 'in-call'
  const quality = status === 'in-call' ? voice.callQuality : null
  const light = quality ? LIGHT[quality.level] : null

  const stateLine = busy
    ? status === 'in-call'
      ? `On a call · ${clockLabel(answeredAt ? (now - answeredAt) / 1000 : 0)}${quality?.mos ? ` · MOS ${quality.mos.toFixed(1)}` : ''}`
      : status === 'ringing'
        ? 'Ringing…'
        : 'Connecting…'
    : !leader
      ? 'Calls ring in your other tab.'
      : registered
        ? 'Phone ready'
        : 'Starting the phone…'

  if (!expanded) {
    const dot = leader && registered ? 'bg-sky-500' : 'bg-muted-foreground/40'
    return (
      <button
        type="button"
        className="bg-popover text-muted-foreground hover:text-foreground fixed right-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] z-50 inline-flex h-11 items-center gap-1.5 rounded-full border px-3 shadow-md sm:right-4 sm:bottom-4 sm:h-9 sm:px-2.5"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        aria-label={`${stateLine} Open phone settings.`}
        title={stateLine}
      >
        <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <Phone className="size-4" aria-hidden="true" />
        {voice.ringtoneMuted && <BellOff className="size-3.5" aria-hidden="true" />}
      </button>
    )
  }

  return (
    <div
      ref={barRef}
      className="bg-popover text-popover-foreground fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_rgba(0,0,0,0.12)] sm:inset-x-auto sm:right-4 sm:bottom-4 sm:max-h-none sm:w-80 sm:overflow-visible sm:rounded-xl sm:border sm:pb-0 sm:shadow-lg"
      role="region"
      aria-label="Phone"
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 sm:flex-nowrap sm:px-3 sm:py-2">
        <span
          className={[
            'size-2 shrink-0 rounded-full',
            light ? light.dot : busy ? 'bg-emerald-500' : leader && registered ? 'bg-sky-500' : 'bg-muted-foreground/40',
          ].join(' ')}
          role={light ? 'img' : undefined}
          aria-label={light?.label}
          aria-hidden={light ? undefined : true}
          title={light ? `${light.label}. MOS is a 1 to 4.5 score; above 4 sounds clear.` : undefined}
        />
        <div className="min-w-0 flex-1">
          {voice.who && busy && <p className="truncate text-base font-medium sm:text-sm">{voice.who}</p>}
          <p className="text-muted-foreground truncate text-sm sm:text-xs" aria-live="polite">
            {stateLine}
          </p>
          {quality?.tip && light && (
            <p className={`text-sm leading-snug sm:text-xs ${light.text}`} role="status">
              {quality.tip}
            </p>
          )}
        </div>
        {busy ? (
          // A row of its own on a phone (big thumb targets); inline on a desk.
          <div className="flex w-full items-center gap-2 sm:contents">
            <button
              type="button"
              className="hover:bg-muted inline-flex h-12 w-16 items-center justify-center rounded-lg border disabled:opacity-40 sm:size-8 sm:rounded-md sm:border-0"
              onClick={voice.toggleMute}
              disabled={status !== 'in-call'}
              aria-pressed={voice.muted}
              aria-label={voice.muted ? 'Unmute' : 'Mute'}
            >
              {voice.muted ? <MicOff className="size-5 sm:size-4" /> : <Mic className="size-5 sm:size-4" />}
            </button>
            <button
              type="button"
              className="hover:bg-muted inline-flex h-12 w-16 items-center justify-center rounded-lg border disabled:opacity-40 sm:size-8 sm:rounded-md sm:border-0"
              onClick={() => setKeypad((v) => !v)}
              disabled={status !== 'in-call'}
              aria-pressed={keypad}
              aria-label="Keypad"
            >
              <Grid3x3 className="size-5 sm:size-4" />
            </button>
            <button
              type="button"
              className="inline-flex h-12 flex-1 items-center justify-center gap-1.5 rounded-lg bg-red-600 px-4 text-base font-medium text-white hover:bg-red-700 sm:h-8 sm:flex-none sm:gap-1 sm:rounded-md sm:px-2.5 sm:text-xs"
              onClick={voice.hangup}
            >
              <PhoneOff className="size-4 sm:size-3.5" />
              Hang up
            </button>
          </div>
        ) : (
          <>
            {leader && (
              <button
                type="button"
                className="hover:bg-muted text-muted-foreground inline-flex size-11 items-center justify-center rounded-lg sm:size-8 sm:rounded-md"
                onClick={() => voice.setRingtoneMuted(!voice.ringtoneMuted)}
                aria-pressed={voice.ringtoneMuted}
                aria-label={voice.ringtoneMuted ? 'Turn the ringtone on' : 'Mute the ringtone'}
                title={voice.ringtoneMuted ? 'Ringtone off. Incoming calls still show here.' : 'Ringtone on'}
              >
                {voice.ringtoneMuted ? <BellOff className="size-5 sm:size-4" /> : <Bell className="size-5 sm:size-4" />}
              </button>
            )}
            <button
              type="button"
              className="hover:bg-muted inline-flex size-11 items-center justify-center rounded-lg sm:size-8 sm:rounded-md"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label={open ? 'Close phone settings' : 'Phone settings'}
            >
              {open ? <X className="size-5 sm:size-4" /> : <Settings2 className="size-5 sm:size-4" />}
            </button>
          </>
        )}
      </div>

      {(setup.voiceLimited || setup.mode === 'mock') && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2 sm:px-3">
          {setup.voiceLimited && (
            <span
              className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300"
              title="One call at a time until Twilio approves the business profile."
            >
              One call at a time
            </span>
          )}
          {setup.mode === 'mock' && (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px]">
              Test mode. No real calls are placed.
            </span>
          )}
        </div>
      )}

      {voice.error && (
        <div className="text-destructive flex items-start gap-2 border-t px-4 py-2 text-sm sm:px-3 sm:text-xs" role="alert">
          <span className="flex-1">{voice.error}</span>
          <button
            type="button"
            onClick={voice.clearError}
            aria-label="Dismiss"
            className="-my-2 -mr-2 inline-flex size-11 shrink-0 items-center justify-center sm:m-0 sm:size-auto"
          >
            <X className="size-4 sm:size-3.5" />
          </button>
        </div>
      )}

      {showKeypad && (
        <div className="grid grid-cols-3 gap-2 border-t px-4 py-3 sm:gap-1.5 sm:px-3 sm:py-2">
          {KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className="hover:bg-muted h-14 rounded-lg border text-xl font-medium tabular-nums sm:h-9 sm:rounded-md sm:text-sm"
              onClick={() => voice.sendDigits(key)}
            >
              {key}
            </button>
          ))}
        </div>
      )}

      {open && !busy && (
        <div className="grid gap-3 border-t px-4 py-3 sm:px-3">
          {setup.canPickLine && setup.lines.length > 0 && (
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground text-xs">Call from</span>
              <select
                className="border-input bg-background h-11 rounded-md border px-2 text-base sm:h-8 sm:text-sm"
                value={voice.lineId ?? ''}
                onChange={(e) => voice.setLineId(e.target.value)}
                aria-label="Call from"
              >
                {setup.lines.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.label ? `${line.label} · ${line.display}` : line.display}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!setup.canPickLine && setup.lines.length > 0 && (
            <p className="text-muted-foreground text-xs">
              Calls go out from {setup.lines.find((l) => l.id === voice.lineId)?.display ?? setup.lines[0].display}.
            </p>
          )}
          {setup.lines.length === 0 && (
            <p className="text-muted-foreground text-xs">This account has no phone line yet.</p>
          )}
          <AudioSettings />
          <ConnectionTest />
          {setup.recordOutbound && (
            <p className="text-muted-foreground text-xs">
              Calls are recorded. People hear &ldquo;This call may be recorded&rdquo; when they answer.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
