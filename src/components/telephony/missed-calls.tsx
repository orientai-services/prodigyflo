'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, PhoneIncoming } from 'lucide-react'
import { markMissedCallHandled } from '@/lib/telephony/actions'
import type { DialTarget, MissedCallVM, MissedDisposition } from '@/lib/telephony/voice-contract'
import { actionFailure, thrownMessage, whenLabel } from '@/lib/telephony/ui/result'
import { CallButton } from '@/components/voice/call-button'
import { RecordingPlayer } from '@/components/voice/recording-player'

/**
 * Missed calls and voicemails that still need someone (plan §2.12, §6.1;
 * docs/DIALER_POWER.md Lane C).
 *
 * Callers who pressed 1 for a callback come first (the server sorts them).
 * Each row closes with one disposition button. Closing one also closes the
 * same caller's earlier missed calls, and a call back that is answered and
 * lasts 20 seconds or more closes them on its own; a call back that nobody
 * answers handles nothing.
 */

const REASON_WORDS: Record<MissedCallVM['reason'], string> = {
  'no-answer': 'Nobody answered',
  'hung-up': 'Hung up while ringing',
  voicemail: 'Left a voicemail',
  busy: 'Line was busy',
  failed: 'Call failed',
}

const DISPOSITIONS: { value: MissedDisposition; label: string }[] = [
  { value: 'called_back', label: 'Called back' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'spam', label: 'Spam' },
  { value: 'wrong_number', label: 'Wrong number' },
  { value: 'handled', label: 'Handled' },
]

function recordHref(target: DialTarget | null): string | null {
  if (!target) return null
  if (target.kind === 'client') return `/clients/${target.id}`
  if (target.kind === 'lead') return `/call-center?lead=${target.id}`
  return null
}

export function MissedCalls({
  calls,
  openId = null,
  canOverrideHours = false,
}: {
  calls: MissedCallVM[]
  openId?: string | null
  canOverrideHours?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<{ id: string; disposition: MissedDisposition } | null>(null)
  const [handled, setHandled] = useState<Set<string>>(new Set())
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const openRef = useRef<HTMLLIElement | null>(null)

  useEffect(() => {
    openRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [openId])

  const visible = calls.filter((c) => !handled.has(c.id))

  const close = (call: MissedCallVM, disposition: MissedDisposition) => {
    setError(null)
    setBusy({ id: call.id, disposition })
    const text = noteFor === call.id ? note.trim() : ''
    startTransition(async () => {
      try {
        const failure = actionFailure(await markMissedCallHandled(call.id, { disposition, note: text || undefined }))
        if (failure) {
          setError(failure.error)
          return
        }
        // The server also closed this caller's earlier calls; the refresh
        // brings the list in line, this just hides the row right away.
        setHandled((set) => new Set(set).add(call.id))
        setNoteFor(null)
        setNote('')
        router.refresh()
      } catch (err) {
        setError(thrownMessage(err))
      } finally {
        setBusy(null)
      }
    })
  }

  if (visible.length === 0) {
    return <p className="text-muted-foreground p-4 text-sm">No missed calls waiting.</p>
  }

  return (
    <div>
      {error && (
        <p className="text-destructive px-4 pt-3 text-sm" role="alert">
          {error}
        </p>
      )}
      <ul className="divide-y">
        {visible.map((call) => {
          const href = recordHref(call.target)
          const open = call.id === openId
          return (
            <li
              key={call.id}
              ref={open ? openRef : undefined}
              className={['grid gap-2 px-4 py-3', open ? 'bg-amber-500/10' : ''].join(' ')}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    <span className="truncate">
                      {href ? (
                        <Link href={href} className="hover:underline">
                          {call.caller}
                        </Link>
                      ) : (
                        call.caller
                      )}
                    </span>
                    {call.callbackRequested && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[0.7rem] font-medium text-amber-700 dark:text-amber-300">
                        <PhoneIncoming className="size-3" aria-hidden="true" />
                        Asked for a callback
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {whenLabel(call.at)} · {call.lineLabel} ·{' '}
                    {call.callbackRequested ? 'Pressed 1 for a callback' : REASON_WORDS[call.reason]}
                  </p>
                </div>
              </div>
              {call.voicemail && <RecordingPlayer src={call.voicemail.src} seconds={call.voicemail.seconds} label="Voicemail" />}
              {call.voicemail && call.transcript && (
                <blockquote className="text-muted-foreground border-l-2 pl-3 text-xs leading-relaxed whitespace-pre-line">
                  <span className="sr-only">Voicemail transcript: </span>“{call.transcript}”
                </blockquote>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <CallButton
                  target={call.target ?? { kind: 'missed', id: call.id }}
                  who={call.caller}
                  label="Call back"
                  canOverrideHours={canOverrideHours}
                />
                <span className="text-muted-foreground text-xs" aria-hidden="true">
                  Close as:
                </span>
                {DISPOSITIONS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    className="hover:bg-muted inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs disabled:opacity-50"
                    disabled={pending}
                    aria-label={`Close as ${d.label.toLowerCase()}`}
                    onClick={() => close(call, d.value)}
                  >
                    {busy?.id === call.id && busy.disposition === d.value && <Loader2 className="size-3.5 animate-spin" />}
                    {d.label}
                  </button>
                ))}
                {noteFor === call.id ? (
                  <input
                    className="border-input bg-background h-7 min-w-44 rounded-md border px-2 text-xs"
                    value={note}
                    maxLength={200}
                    placeholder="Note (saved with the button you press)"
                    onChange={(e) => setNote(e.target.value)}
                    aria-label="Note"
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground h-7 px-1 text-xs underline-offset-2 hover:underline"
                    onClick={() => {
                      setNoteFor(call.id)
                      setNote('')
                    }}
                  >
                    Add note
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
