'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Flame, Gauge, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { CloseScoreView } from '@/lib/ai/closeops-ai'
import { rescoreClientAction } from './closeops-actions'

/** Color grade for the chip: hot ≥ 80, warm ≥ 60, cool below. */
function grade(probability: number) {
  if (probability >= 80) {
    return { dot: 'bg-success', text: 'text-success', bar: 'bg-success', label: 'Hot' }
  }
  if (probability >= 60) {
    return { dot: 'bg-warning', text: 'text-warning', bar: 'bg-warning', label: 'Warm' }
  }
  return { dot: 'bg-muted-foreground/60', text: 'text-muted-foreground', bar: 'bg-muted-foreground/50', label: 'Cool' }
}

/**
 * The "Close probability" chip: score + when it was scored, a reasons popover,
 * and a Rescore button. Reasons are returned by the scoring run and shown
 * in-session only — the stored record is just the number and its timestamp.
 */
export function CloseProbabilityChip({
  clientId,
  probability,
  scoredAt,
  canRun,
  mock,
}: {
  clientId: string
  probability: number | null
  scoredAt: string | null
  canRun: boolean
  mock: boolean
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [rescoring, setRescoring] = useState(false)
  const [lastRun, setLastRun] = useState<CloseScoreView | null>(null)

  // A rescore in this session supersedes the server-rendered value until refresh lands.
  const shown = lastRun ? lastRun.probability : probability
  const shownAt = lastRun ? lastRun.scoredAt : scoredAt
  const g = shown === null ? null : grade(shown)

  const rescore = () => {
    setRescoring(true)
    startTransition(async () => {
      try {
        const result = await rescoreClientAction({ clientId })
        if (result.ok) {
          setLastRun(result.score)
          toast.success(`Scored ${result.score.probability}% (${result.score.confidence} confidence)`)
          router.refresh()
        } else {
          toast.error(result.error)
        }
      } catch {
        toast.error('The client could not be scored. Try again in a moment.')
      } finally {
        setRescoring(false)
      }
    })
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              'bg-card hover:bg-surface-sunk inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
              shown === null && 'border-dashed text-muted-foreground',
            )}
            title="AI close probability — a prioritization signal, not a decision"
          >
            {shown === null ? (
              <>
                <Gauge className="size-3.5" />
                Close probability: not scored
              </>
            ) : (
              <>
                {shown >= 80 ? <Flame className={cn('size-3.5', g!.text)} /> : <span className={cn('size-2 rounded-full', g!.dot)} />}
                <span>
                  Close probability <span className="tabular-nums">{shown}%</span>
                </span>
                <span className="text-muted-foreground font-normal">· {shownAt ? relativeTime(shownAt) : '—'}</span>
              </>
            )}
          </button>
        }
      />
      <PopoverContent align="start" className="w-80">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">AI close probability</p>
            {g && (
              <Badge variant="outline" className={cn('text-[0.625rem]', g.text)}>
                {g.label}
              </Badge>
            )}
            {mock && (
              <Badge variant="outline" title="No AI key is configured, so a deterministic sample model runs.">
                Demo mode
              </Badge>
            )}
          </div>

          {shown !== null ? (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-semibold tabular-nums tracking-tight">{shown}%</span>
                <span className="text-muted-foreground text-xs">
                  scored {shownAt ? relativeTime(shownAt) : '—'}
                  {lastRun ? ` · ${lastRun.confidence} confidence` : ''}
                </span>
              </div>
              <div className="bg-surface-sunk h-1.5 w-full overflow-hidden rounded-full border">
                <div className={cn('h-full rounded-full', g!.bar)} style={{ width: `${shown}%` }} />
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              This client has not been scored yet. {canRun ? 'Run a score to place them in the call queue.' : ''}
            </p>
          )}

          {lastRun && lastRun.reasons.length > 0 ? (
            <div>
              <p className="text-muted-foreground mb-1 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">
                Why this number
              </p>
              <ul className="space-y-1">
                {lastRun.reasons.map((r) => (
                  <li key={r} className="text-muted-foreground flex gap-1.5 text-xs">
                    <span className="bg-muted-foreground/40 mt-1.5 size-1 shrink-0 rounded-full" />
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            shown !== null && (
              <p className="text-muted-foreground text-xs">
                Reasons are produced with each scoring run and are not stored. Rescore to see the current reasoning.
              </p>
            )
          )}

          <div className="flex items-center justify-between gap-2 border-t pt-2.5">
            <p className="text-muted-foreground text-[0.6875rem]">AI signal — humans decide.</p>
            {canRun && (
              <Button variant="outline" size="sm" disabled={rescoring} onClick={rescore}>
                {rescoring ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                {shown === null ? 'Score now' : 'Rescore'}
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
