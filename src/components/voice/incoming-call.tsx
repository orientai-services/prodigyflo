'use client'

import Link from 'next/link'
import { Phone, PhoneOff } from 'lucide-react'
// Meta lead ids carry colons ('lead:meta:<org>:<leadgen>'), so the target is
// parsed whole by the desk's own rule rather than split on the first ':'.
import { targetHref } from '@/lib/call-center/lead-link'
import { useVoice } from './voice-provider'

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
      className="bg-popover text-popover-foreground fixed inset-x-0 top-0 z-[60] rounded-b-2xl border-b pt-[env(safe-area-inset-top)] shadow-lg sm:inset-x-auto sm:top-4 sm:right-4 sm:w-80 sm:rounded-xl sm:border sm:pt-0"
      role="alertdialog"
      aria-label="Incoming call"
    >
      <div className="px-4 py-4 sm:px-3 sm:py-3">
        <p className="text-muted-foreground text-sm sm:text-xs">Incoming call{incoming.line ? ` · ${incoming.line}` : ''}</p>
        <p className="mt-0.5 truncate text-lg font-semibold sm:text-sm">{incoming.caller}</p>
        {href && (
          <Link href={href} className="text-primary mt-0.5 inline-flex min-h-11 items-center text-sm underline-offset-2 hover:underline sm:min-h-0 sm:text-xs">
            Open their record
          </Link>
        )}
        {busy && <p className="text-muted-foreground mt-1 text-sm sm:text-xs">Hang up the current call to take this one.</p>}
        <div className="mt-3 flex gap-3 sm:mt-2 sm:gap-2">
          <button
            type="button"
            className="inline-flex h-12 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-base font-medium text-white hover:bg-emerald-700 disabled:opacity-50 sm:h-8 sm:rounded-md sm:text-xs"
            onClick={() => void voice.accept()}
            disabled={busy}
          >
            <Phone className="size-4 sm:size-3.5" />
            Accept
          </button>
          <button
            type="button"
            className="hover:bg-muted inline-flex h-12 flex-1 items-center justify-center gap-1.5 rounded-lg border text-base font-medium sm:h-8 sm:rounded-md sm:text-xs"
            onClick={voice.decline}
          >
            <PhoneOff className="size-4 sm:size-3.5" />
            Decline
          </button>
        </div>
      </div>
    </div>
  )
}
