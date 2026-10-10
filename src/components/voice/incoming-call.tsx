'use client'

import Link from 'next/link'
import { Phone, PhoneOff } from 'lucide-react'
import { useVoice } from './voice-provider'

/** 'client:<id>' → the client's page; 'lead:<id>' → that lead on the Call Center desk. */
function targetHref(target: string): string | null {
  const [kind, id] = target.split(':', 2)
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null
  if (kind === 'client') return `/clients/${id}`
  if (kind === 'lead') return `/call-center?lead=${id}`
  return null
}

/**
 * The ringing banner. It shows only what the server put on the leg
 * (`pfCaller` is a name or a masked number, never a full one) and links to
 * the client or lead when the caller matched one.
 */
export function IncomingCall() {
  const voice = useVoice()
  const incoming = voice?.incoming
  if (!voice || !incoming) return null

  const href = targetHref(incoming.target)
  const busy = voice.status !== 'idle'

  return (
    <div
      className="bg-popover text-popover-foreground fixed inset-x-0 top-0 z-[60] border-b shadow-lg sm:inset-x-auto sm:top-4 sm:right-4 sm:w-80 sm:rounded-xl sm:border"
      role="alertdialog"
      aria-label="Incoming call"
    >
      <div className="px-3 py-3">
        <p className="text-muted-foreground text-xs">Incoming call{incoming.line ? ` · ${incoming.line}` : ''}</p>
        <p className="mt-0.5 truncate text-sm font-semibold">{incoming.caller}</p>
        {href && (
          <Link href={href} className="text-primary mt-0.5 inline-block text-xs underline-offset-2 hover:underline">
            Open their record
          </Link>
        )}
        {busy && <p className="text-muted-foreground mt-1 text-xs">Hang up the current call to take this one.</p>}
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-600 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            onClick={() => void voice.accept()}
            disabled={busy}
          >
            <Phone className="size-3.5" />
            Accept
          </button>
          <button
            type="button"
            className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border text-xs font-medium hover:bg-muted"
            onClick={voice.decline}
          >
            <PhoneOff className="size-3.5" />
            Decline
          </button>
        </div>
      </div>
    </div>
  )
}
