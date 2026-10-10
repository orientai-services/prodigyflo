'use client'

import { useEffect, useState } from 'react'
import { Bell, BellOff, Grid3x3, Mic, MicOff, PhoneOff, Settings2, X } from 'lucide-react'
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

/**
 * The call bar: bottom right on a desk, a full-width bottom sheet on a phone.
 * Idle it is a small pill that says whether this tab rings; during a call it
 * shows who, the talk timer, the quality light (one tip when it isn't
 * green), mute, keypad and hang up. Errors stay until
 * dismissed, in plain words, because a rep who looked away must still learn
 * why the call dropped.
 */
export function VoiceDock() {
  const voice = useVoice()
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

  if (!voice) return null
  const { setup, status, leader, registered } = voice
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

  return (
    <div
      className="bg-popover text-popover-foreground fixed inset-x-0 bottom-0 z-50 border-t shadow-lg sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-80 sm:rounded-xl sm:border"
      role="region"
      aria-label="Phone"
    >
      <div className="flex items-center gap-2 px-3 py-2">
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
          {voice.who && busy && <p className="truncate text-sm font-medium">{voice.who}</p>}
          <p className="text-muted-foreground truncate text-xs" aria-live="polite">
            {stateLine}
          </p>
          {quality?.tip && light && (
            <p className={`text-xs leading-snug ${light.text}`} role="status">
              {quality.tip}
            </p>
          )}
        </div>
        {busy ? (
          <>
            <button
              type="button"
              className="hover:bg-muted inline-flex size-8 items-center justify-center rounded-md disabled:opacity-40"
              onClick={voice.toggleMute}
              disabled={status !== 'in-call'}
              aria-pressed={voice.muted}
              aria-label={voice.muted ? 'Unmute' : 'Mute'}
            >
              {voice.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>
            <button
              type="button"
              className="hover:bg-muted inline-flex size-8 items-center justify-center rounded-md disabled:opacity-40"
              onClick={() => setKeypad((v) => !v)}
              disabled={status !== 'in-call'}
              aria-pressed={keypad}
              aria-label="Keypad"
            >
              <Grid3x3 className="size-4" />
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-md bg-red-600 px-2.5 text-xs font-medium text-white hover:bg-red-700"
              onClick={voice.hangup}
            >
              <PhoneOff className="size-3.5" />
              Hang up
            </button>
          </>
        ) : (
          <>
            {leader && (
              <button
                type="button"
                className="hover:bg-muted text-muted-foreground inline-flex size-8 items-center justify-center rounded-md"
                onClick={() => voice.setRingtoneMuted(!voice.ringtoneMuted)}
                aria-pressed={voice.ringtoneMuted}
                aria-label={voice.ringtoneMuted ? 'Turn the ringtone on' : 'Mute the ringtone'}
                title={voice.ringtoneMuted ? 'Ringtone off. Incoming calls still show here.' : 'Ringtone on'}
              >
                {voice.ringtoneMuted ? <BellOff className="size-4" /> : <Bell className="size-4" />}
              </button>
            )}
            <button
              type="button"
              className="hover:bg-muted inline-flex size-8 items-center justify-center rounded-md"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label="Phone settings"
            >
              <Settings2 className="size-4" />
            </button>
          </>
        )}
      </div>

      {(setup.voiceLimited || setup.mode === 'mock') && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
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
        <div className="text-destructive flex items-start gap-2 border-t px-3 py-2 text-xs" role="alert">
          <span className="flex-1">{voice.error}</span>
          <button type="button" onClick={voice.clearError} aria-label="Dismiss" className="shrink-0">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {showKeypad && (
        <div className="grid grid-cols-3 gap-1.5 border-t px-3 py-2">
          {KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className="hover:bg-muted h-9 rounded-md border text-sm font-medium tabular-nums"
              onClick={() => voice.sendDigits(key)}
            >
              {key}
            </button>
          ))}
        </div>
      )}

      {open && !busy && (
        <div className="grid gap-3 border-t px-3 py-3">
          {setup.canPickLine && setup.lines.length > 0 && (
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground text-xs">Call from</span>
              <select
                className="border-input bg-background h-8 rounded-md border px-2 text-sm"
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
