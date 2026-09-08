'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Check,
  FileSearch,
  Gauge,
  ListTodo,
  Loader2,
  Minus,
  ScanSearch,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { AssistView } from '@/lib/ai/assists'
import { runAssistAction, reviewAssistAction } from './ai-actions'

type AssistKind = AssistView['kind']

const RUN_BUTTONS: { kind: AssistKind; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { kind: 'summary', label: 'Summarize', icon: FileSearch },
  { kind: 'next_actions', label: 'Suggest next actions', icon: ListTodo },
  { kind: 'discrepancies', label: 'Check for discrepancies', icon: ScanSearch },
  { kind: 'qualification', label: 'Qualification signals', icon: Gauge },
]

const SEVERITY_CLASS: Record<string, string> = {
  high: 'bg-danger',
  medium: 'bg-warning',
  low: 'bg-muted-foreground/50',
}

function acceptLabel(item: AssistView): string {
  if (item.kind === 'next_actions' && item.actions.length > 0) {
    return `Accept — create ${item.actions.length} task${item.actions.length === 1 ? '' : 's'}`
  }
  if (item.kind === 'summary') return 'Accept — pin as note'
  if (item.kind === 'discrepancies' && item.discrepancies.length > 0) return 'Accept — create task'
  return 'Mark reviewed'
}

function ConfidenceMeter({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title="Model confidence in this analysis">
      <span className="bg-surface-sunk inline-block h-1.5 w-16 overflow-hidden rounded-full border">
        <span
          className={`block h-full rounded-full ${value >= 70 ? 'bg-success' : value >= 50 ? 'bg-warning' : 'bg-danger'}`}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </span>
      {value}% confidence
    </span>
  )
}

function DirectionIcon({ direction }: { direction: 'positive' | 'negative' | 'neutral' }) {
  if (direction === 'positive') return <TrendingUp className="text-success size-3.5 shrink-0" />
  if (direction === 'negative') return <TrendingDown className="text-danger size-3.5 shrink-0" />
  return <Minus className="text-muted-foreground size-3.5 shrink-0" />
}

function AssistBody({ item }: { item: AssistView }) {
  if (item.kind === 'summary') {
    return (
      <div className="space-y-2">
        <p className="text-sm leading-relaxed">{item.summary}</p>
        {item.facts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.facts.map((f) => (
              <span
                key={`${f.label}:${f.value}`}
                className="bg-surface-sunk text-muted-foreground rounded-md border px-1.5 py-0.5 text-[0.6875rem]"
                title={`Source: ${f.source}`}
              >
                <span className="font-medium">{f.label}:</span> {f.value}
              </span>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (item.kind === 'next_actions') {
    return (
      <ul className="space-y-2">
        {item.actions.map((a) => (
          <li key={a.title} className="flex items-start gap-2 text-sm">
            <Badge
              variant={a.priority === 'HIGH' || a.priority === 'URGENT' ? 'destructive' : 'secondary'}
              className="mt-0.5 shrink-0 text-[0.625rem]"
            >
              {a.priority.toLowerCase()}
            </Badge>
            <div>
              <p className="font-medium">
                {a.title}
                <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                  due in {a.dueInDays} day{a.dueInDays === 1 ? '' : 's'}
                </span>
              </p>
              <p className="text-muted-foreground text-xs">{a.reason}</p>
            </div>
          </li>
        ))}
      </ul>
    )
  }

  if (item.kind === 'discrepancies') {
    if (item.discrepancies.length === 0) {
      return (
        <p className="text-success flex items-center gap-1.5 text-sm">
          <Check className="size-4" />
          No discrepancies — the record, verified documents and intake answers agree.
        </p>
      )
    }
    return (
      <ul className="divide-y">
        {item.discrepancies.map((d) => (
          <li key={`${d.field}:${d.b}`} className="py-2 text-sm first:pt-0 last:pb-0">
            <p className="flex items-center gap-1.5 font-medium capitalize">
              <span className={`size-2 shrink-0 rounded-full ${SEVERITY_CLASS[d.severity] ?? SEVERITY_CLASS.low}`} />
              {d.field}
              <span className="text-muted-foreground text-[0.6875rem] font-normal uppercase tracking-[0.06em]">
                {d.severity}
              </span>
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {d.a} <span className="text-foreground font-medium">vs</span> {d.b}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">{d.note}</p>
          </li>
        ))}
      </ul>
    )
  }

  // qualification
  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {item.signals.map((s) => (
          <li key={s.label} className="flex items-start gap-2 text-sm">
            <DirectionIcon direction={s.direction} />
            <span>
              <span className="font-medium">{s.label}</span>
              <span className="text-muted-foreground"> — {s.note}</span>
            </span>
          </li>
        ))}
      </ul>
      {item.caveat && (
        <p className="border-warning/40 bg-warning/5 text-muted-foreground rounded-md border px-2.5 py-1.5 text-xs italic">
          {item.caveat}
        </p>
      )}
    </div>
  )
}

export function AIPanel({
  clientId,
  canRun,
  canReview,
  mock,
  modelLabel,
  items,
}: {
  clientId: string
  canRun: boolean
  canReview: boolean
  mock: boolean
  modelLabel: string | null
  items: AssistView[]
}) {
  const router = useRouter()
  const [running, setRunning] = useState<AssistKind | null>(null)
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const pending = items.filter((i) => i.status === 'PENDING_REVIEW')
  const reviewed = items.filter((i) => i.status !== 'PENDING_REVIEW').slice(0, 3)

  const run = (kind: AssistKind) => {
    setRunning(kind)
    setError(null)
    startTransition(async () => {
      try {
        const result = await runAssistAction({ clientId, kind })
        if (result.ok) {
          toast.success(`${result.item.label} ready for review`)
          router.refresh()
        } else {
          setError(result.error)
          toast.error(result.error)
        }
      } catch {
        setError('The analysis could not be run. Try again in a moment.')
        toast.error('The analysis could not be run.')
      } finally {
        setRunning(null)
      }
    })
  }

  const review = (item: AssistView, decision: 'accept' | 'dismiss') => {
    setReviewing(item.id)
    startTransition(async () => {
      try {
        const result = await reviewAssistAction({ clientId, recommendationId: item.id, decision })
        if (result.ok) {
          toast.success(
            decision === 'dismiss'
              ? 'Dismissed — no changes were made'
              : result.effect === 'tasks_created'
                ? `Accepted — ${result.count} task${result.count === 1 ? '' : 's'} created`
                : result.effect === 'note_pinned'
                  ? 'Accepted — summary pinned as an internal note'
                  : 'Marked as reviewed',
          )
          router.refresh()
        } else {
          toast.error(result.error)
          router.refresh()
        }
      } catch {
        toast.error('The review could not be saved.')
      } finally {
        setReviewing(null)
      }
    })
  }

  return (
    <section className="bg-card shadow-e1 rounded-lg border">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Sparkles className="text-primary size-4" />
        <h3 className="text-sm font-medium">AI assistant</h3>
        {mock ? (
          <Badge variant="outline" title="No AI key is configured, so a deterministic sample model runs. Results are illustrative.">
            Demo mode
          </Badge>
        ) : (
          modelLabel && (
            <Badge variant="outline" className="text-muted-foreground">
              {modelLabel}
            </Badge>
          )
        )}
        <p className="text-muted-foreground w-full text-xs sm:ml-auto sm:w-auto">
          Reads this file only. Every result waits for your review — nothing is applied automatically.
        </p>
      </header>

      <div className="space-y-3 p-4">
        {canRun && (
          <div className="flex flex-wrap gap-2">
            {RUN_BUTTONS.map(({ kind, label, icon: Icon }) => (
              <Button
                key={kind}
                variant="outline"
                size="sm"
                disabled={running !== null}
                onClick={() => run(kind)}
              >
                {running === kind ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
                {label}
              </Button>
            ))}
          </div>
        )}

        {error && (
          <p className="border-danger/40 bg-danger/5 text-danger flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs">
            <AlertTriangle className="size-3.5 shrink-0" />
            {error}
          </p>
        )}

        {pending.length === 0 && !running && (
          <p className="bg-surface-sunk/50 text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
            {canRun
              ? 'Nothing is waiting for review. Run an assist above — a summary, suggested actions, a discrepancy check, or qualification signals.'
              : 'Nothing is waiting for review.'}
          </p>
        )}

        {pending.map((item) => (
          <article key={item.id} className="bg-surface-raised/40 rounded-lg border p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{item.label}</span>
              <Badge variant="secondary" className="text-[0.625rem]">
                Awaiting review
              </Badge>
              {item.confidence !== null && <ConfidenceMeter value={item.confidence} />}
              <span className="text-muted-foreground ml-auto text-[0.6875rem]">
                {item.provider === 'mock' ? 'sample model' : (item.model ?? item.provider)}
              </span>
            </div>

            {item.kind !== 'summary' && item.summary && (
              <p className="text-muted-foreground mb-2 text-xs">{item.summary}</p>
            )}
            <AssistBody item={item} />

            {item.complianceFlags.length > 0 && item.kind !== 'qualification' && (
              <ul className="mt-2 space-y-1">
                {item.complianceFlags.map((f) => (
                  <li key={f.text} className="text-muted-foreground flex items-start gap-1.5 text-xs">
                    <AlertTriangle
                      className={`mt-0.5 size-3 shrink-0 ${f.level === 'blocker' ? 'text-danger' : f.level === 'review' ? 'text-warning' : 'text-muted-foreground'}`}
                    />
                    {f.text}
                  </li>
                ))}
              </ul>
            )}

            <footer className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2.5">
              {canReview ? (
                <>
                  <Button size="sm" disabled={reviewing === item.id} onClick={() => review(item, 'accept')}>
                    {reviewing === item.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Check className="size-3.5" />
                    )}
                    {acceptLabel(item)}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={reviewing === item.id} onClick={() => review(item, 'dismiss')}>
                    <X className="size-3.5" />
                    Dismiss
                  </Button>
                </>
              ) : (
                <p className="text-muted-foreground text-xs">An authorized reviewer accepts or dismisses this.</p>
              )}
            </footer>
          </article>
        ))}

        {reviewed.length > 0 && (
          <div className="border-t pt-2">
            <p className="text-muted-foreground mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">
              Recently reviewed
            </p>
            <ul className="space-y-1">
              {reviewed.map((item) => (
                <li key={item.id} className="text-muted-foreground flex items-center gap-2 text-xs">
                  {item.status === 'ACCEPTED' ? (
                    <Check className="text-success size-3 shrink-0" />
                  ) : (
                    <X className="size-3 shrink-0" />
                  )}
                  <span className="text-foreground">{item.label}</span>
                  <span>
                    {item.status === 'ACCEPTED' ? 'accepted' : 'dismissed'}
                    {item.reviewedByName ? ` by ${item.reviewedByName}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
