'use client'

import { useActionState, useState } from 'react'
import { Check, ChevronRight, Loader2, MessageSquarePlus, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  acceptInsightAction,
  dismissInsightAction,
  type InsightReviewResult,
} from '@/lib/engine/actions'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { kindChipClass, type InsightCitationView } from './engine-view'

/**
 * One PENDING_REVIEW insight, reviewable in place: kind chip + score meter,
 * body, expandable evidence citations, then Accept / Dismiss with an optional
 * note. Both verdicts post through the same form — the pressed button's
 * name/value picks the action — so a single pending state guards double
 * submits, and the server action claims the row atomically anyway.
 */

export type PendingInsightView = {
  id: string
  kind: string
  title: string
  body: string
  /** Already clamped 0–100 server-side; null when the model gave no score. */
  score: number | null
  /** Pre-formatted server-side so client and server render identical text. */
  createdAgo: string
  citations: InsightCitationView[]
}

export function InsightReviewCard({ insight }: { insight: PendingInsightView }) {
  const [showEvidence, setShowEvidence] = useState(false)
  const [showNote, setShowNote] = useState(false)

  const [state, formAction, pending] = useActionState<InsightReviewResult | null, FormData>(
    async (_prev, formData) => {
      const decision = formData.get('decision') === 'accept' ? 'accept' : 'dismiss'
      const note = String(formData.get('note') ?? '').trim() || undefined
      const act = decision === 'accept' ? acceptInsightAction : dismissInsightAction
      const result = await act({ insightId: insight.id, note })
      if (result.ok) {
        toast.success(decision === 'accept' ? 'Insight accepted' : 'Insight dismissed', {
          description: note
            ? 'Your note conditions the next scan.'
            : 'Your verdict conditions the next scan.',
        })
      } else {
        toast.error(result.error)
      }
      return result
    },
    null,
  )

  return (
    <article className="bg-card shadow-e1 motion-safe:hover:shadow-e2 flex h-full flex-col rounded-xl border transition-shadow">
      <div className="flex-1 p-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[0.625rem] font-semibold tracking-wide uppercase',
              kindChipClass(insight.kind),
            )}
          >
            {insight.kind}
          </span>
          {insight.score !== null && (
            <span
              className="ml-auto flex shrink-0 items-center gap-1.5"
              title={`Priority score ${insight.score} of 100`}
            >
              <span className="text-muted-foreground text-xs font-medium tabular-nums">
                {insight.score}
              </span>
              <span className="bg-muted h-1 w-10 overflow-hidden rounded-full">
                <span
                  className="bg-primary block h-full rounded-full"
                  style={{ width: `${insight.score}%` }}
                />
              </span>
            </span>
          )}
        </div>

        <h3 className="mt-2.5 text-sm font-semibold">{insight.title}</h3>
        <p className="text-muted-foreground mt-1 text-sm whitespace-pre-line">{insight.body}</p>
        <p className="text-muted-foreground/70 mt-2 text-xs">Proposed {insight.createdAgo}</p>

        {insight.citations.length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowEvidence((v) => !v)}
              aria-expanded={showEvidence}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded text-xs font-medium transition-colors outline-none focus-visible:ring-3"
            >
              <ChevronRight
                className={cn(
                  'size-3.5 transition-transform motion-safe:duration-200',
                  showEvidence && 'rotate-90',
                )}
              />
              {insight.citations.length} evidence citation{insight.citations.length === 1 ? '' : 's'}
            </button>
            {showEvidence && (
              <ul className="border-border mt-2 space-y-2.5 border-l-2 pl-3">
                {insight.citations.map((c, i) => (
                  <li key={i} className="text-xs">
                    <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[0.625rem]">
                      {c.source}
                      {c.ref ? ` · ${c.ref}` : ''}
                    </span>
                    <p className="text-muted-foreground mt-1">{c.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <form action={formAction} className="border-t p-3">
        {showNote && (
          <Textarea
            name="note"
            maxLength={2000}
            autoFocus
            placeholder="Optional review note — the engine reads it before the next scan"
            className="mb-2.5 min-h-16 text-sm"
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" name="decision" value="accept" size="sm" disabled={pending}>
            <Check data-slot="icon" /> Accept
          </Button>
          <Button
            type="submit"
            name="decision"
            value="dismiss"
            size="sm"
            variant="outline"
            disabled={pending}
          >
            <X data-slot="icon" /> Dismiss
          </Button>
          {!showNote && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowNote(true)}>
              <MessageSquarePlus data-slot="icon" /> Add note
            </Button>
          )}
          {pending && (
            <Loader2 className="text-muted-foreground size-4 motion-safe:animate-spin" />
          )}
          {state && !state.ok && <span className="text-danger text-xs">{state.error}</span>}
        </div>
      </form>
    </article>
  )
}
