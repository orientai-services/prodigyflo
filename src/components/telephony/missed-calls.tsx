'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2 } from 'lucide-react'
import { markMissedCallHandled } from '@/lib/telephony/actions'
import type { DialTarget, MissedCallVM } from '@/lib/telephony/voice-contract'
import { actionFailure, thrownMessage, whenLabel } from '@/lib/telephony/ui/result'
import { CallButton } from '@/components/voice/call-button'
import { RecordingPlayer } from '@/components/voice/recording-player'

/**
 * Missed calls and voicemails that still need someone (plan §2.12, §6.1).
 * A row leaves the list when anyone marks it handled; calling back does not
 * clear it on its own, because a call back that nobody answers hasn't
 * handled anything.
 */

const REASON_WORDS: Record<MissedCallVM['reason'], string> = {
  'no-answer': 'Nobody answered',
  'hung-up': 'Hung up while ringing',
  voicemail: 'Left a voicemail',
  busy: 'Line was busy',
  failed: 'Call failed',
}

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
  const [handled, setHandled] = useState<Set<string>>(new Set())
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const openRef = useRef<HTMLLIElement | null>(null)

  useEffect(() => {
    openRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [openId])

  const visible = calls.filter((c) => !handled.has(c.id))

  const markHandled = (id: string) => {
    setError(null)
    startTransition(async () => {
      try {
        const failure = actionFailure(await markMissedCallHandled(id, note.trim() || undefined))
        if (failure) {
          setError(failure.error)
          return
        }
        setHandled((set) => new Set(set).add(id))
        setNoteFor(null)
        setNote('')
        router.refresh()
      } catch (err) {
        setError(thrownMessage(err))
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
                  <p className="truncate text-sm font-semibold">
                    {href ? (
                      <Link href={href} className="hover:underline">
                        {call.caller}
                      </Link>
                    ) : (
                      call.caller
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {whenLabel(call.at)} · {call.lineLabel} · {REASON_WORDS[call.reason]}
                  </p>
                </div>
              </div>
              {call.voicemail && <RecordingPlayer src={call.voicemail.src} seconds={call.voicemail.seconds} label="Voicemail" />}
              <div className="flex flex-wrap items-start gap-2">
                <CallButton
                  target={call.target ?? { kind: 'missed', id: call.id }}
                  who={call.caller}
                  label="Call back"
                  canOverrideHours={canOverrideHours}
                />
                {noteFor === call.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="border-input bg-background h-7 min-w-44 rounded-md border px-2 text-xs"
                      value={note}
                      maxLength={200}
                      placeholder="Note (optional)"
                      onChange={(e) => setNote(e.target.value)}
                      aria-label="Note"
                    />
                    <button
                      type="button"
                      className="bg-primary text-primary-foreground inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium disabled:opacity-50"
                      disabled={pending}
                      onClick={() => markHandled(call.id)}
                    >
                      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                      Done
                    </button>
                    <button type="button" className="h-7 rounded-md border px-2.5 text-xs" onClick={() => setNoteFor(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="hover:bg-muted h-7 rounded-md border px-2.5 text-xs"
                    onClick={() => {
                      setNoteFor(call.id)
                      setNote('')
                    }}
                  >
                    Mark handled
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
