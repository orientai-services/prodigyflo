'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw, Check, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { recoverLeadAction } from './actions'

/**
 * The one interactive control on the recycler — starts recovery for a lead.
 * Optimistically shows a spinner, toasts the outcome, and refreshes so the row
 * drops out of the worklist once it re-activates.
 */
export function RecoverButton({ clientId, name }: { clientId: string; name: string }) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function onRecover() {
    startTransition(async () => {
      const res = await recoverLeadAction({ clientId })
      if (res.ok) {
        toast.success('Recovery started', { description: `${name} is back in the follow-up queue.` })
        router.refresh()
      } else {
        toast.error('Could not start recovery', { description: res.error })
      }
    })
  }

  return (
    <button
      type="button"
      onClick={onRecover}
      disabled={pending}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all',
        'bg-[var(--rec-primary)] text-[var(--rec-on-primary)] shadow-sm',
        'hover:bg-[var(--rec-primary-strong)] active:translate-y-px',
        'disabled:cursor-not-allowed disabled:opacity-70',
      )}
    >
      {pending ? (
        <>
          <Loader2 className="size-3.5 animate-spin" />
          Starting…
        </>
      ) : (
        <>
          <RefreshCw className="size-3.5" />
          Start recovery
        </>
      )}
    </button>
  )
}

/** A tiny static confirmation chip — used where a lead is already re-engaged. */
export function RecoveredChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--rec-primary-soft)] px-2.5 py-0.5 text-xs font-semibold text-[var(--rec-primary-ink)]">
      <Check className="size-3" />
      Live
    </span>
  )
}
