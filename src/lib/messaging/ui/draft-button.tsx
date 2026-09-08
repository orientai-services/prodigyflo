'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { draftMessageAction } from '@/app/(app)/clients/[clientId]/ai-actions'

/**
 * Self-contained "Draft with AI" island the composer (or any other surface) can
 * adopt without changes here. The draft is handed to `onDraft` — this component
 * never sends anything itself, and the server records the draft as a
 * PENDING_REVIEW AI recommendation for the audit trail.
 *
 * Default rendering is a small button; pass `children` as a render function for
 * full control over the trigger UI.
 */

export type DraftIntent = 'follow_up' | 'documents' | 'appointment' | 're_engage'

export type MessageDraft = {
  subject: string | null
  body: string
  recommendationId: string
  /** True when the deterministic sample model produced the draft. */
  mock: boolean
}

export type DraftButtonState = {
  pending: boolean
  error: string | null
  /** Requests a draft; `intent` overrides the component's default. */
  run: (intent?: DraftIntent) => void
}

const INTENT_LABEL: Record<DraftIntent, string> = {
  follow_up: 'follow-up',
  documents: 'document chase',
  appointment: 'appointment confirmation',
  re_engage: 're-engagement',
}

export function DraftButton({
  clientId,
  channel,
  intent = 'follow_up',
  onDraft,
  disabled = false,
  children,
}: {
  clientId: string
  channel: 'EMAIL' | 'SMS'
  intent?: DraftIntent
  /** Receives the draft for the caller to place into its own editor. */
  onDraft: (draft: MessageDraft) => void
  disabled?: boolean
  children?: (state: DraftButtonState) => ReactNode
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const run = (overrideIntent?: DraftIntent) => {
    if (pending || disabled) return
    setError(null)
    startTransition(async () => {
      try {
        const result = await draftMessageAction({ clientId, channel, intent: overrideIntent ?? intent })
        if (result.ok) {
          onDraft({
            subject: result.draft.subject,
            body: result.draft.body,
            recommendationId: result.recommendationId,
            mock: result.mock,
          })
          toast.success(
            `Draft ${INTENT_LABEL[overrideIntent ?? intent]} ready${result.mock ? ' (sample model)' : ''} — review before sending`,
          )
        } else {
          setError(result.error)
          toast.error(result.error)
        }
      } catch {
        setError('The draft could not be generated. Try again in a moment.')
        toast.error('The draft could not be generated.')
      }
    })
  }

  if (children) return <>{children({ pending, error, run })}</>

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending || disabled}
      onClick={() => run()}
      title="Generates a draft from this client's file. You review and edit it — nothing is sent automatically."
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
      Draft with AI
    </Button>
  )
}
