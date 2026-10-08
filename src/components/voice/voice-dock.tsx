'use client'

import { useEffect, useState } from 'react'
import { Grid3x3, Mic, MicOff, PhoneOff, Settings2, X } from 'lucide-react'
import { clockLabel } from '@/lib/telephony/ui/result'
import { AudioSettings } from './audio-settings'
import { useVoice } from './voice-provider'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const

/**
 * The call bar: bottom right on a desk, a full-width bottom sheet on a phone.
 * Idle it is a small pill that says whether this tab rings; during a call it
 * shows who, the talk timer, mute, keypad and hang up. Errors stay until
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

  if (!voice) return null
  const { setup, status, leader, registered } = voice
  const busy = status !== 'idle'
  const showKeypad = keypad && status === 'in-call'

  const stateLine = busy
    ? status === 'in-call'
      ? `On a call · ${clockLabel(answeredAt ? (now - answeredAt) / 1000 : 0)}`
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
            busy ? 'bg-emerald-500' : leader && registered ? 'bg-sky-500' : 'bg-muted-foreground/40',
          ].join(' ')}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          {voice.who && busy && <p className="truncate text-sm font-medium">{voice.who}</p>}
          <p className="text-muted-foreground truncate text-xs" aria-live="polite">
            {stateLine}
          </p>
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
          <button
            type="button"
            className="hover:bg-muted inline-flex size-8 items-center justify-center rounded-md"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Phone settings"
          >
            <Settings2 className="size-4" />
          </button>
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
