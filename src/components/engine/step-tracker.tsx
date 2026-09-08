import { humanize } from '@/lib/format'
import { cn } from '@/lib/utils'
import { orderSteps, stepTone, type StatusTone, type StepView } from './engine-view'

/**
 * Compact horizontal DAG tracker: one dot per step
 * (collect → retrieve → analyze → persist → measure), colored by status from
 * the semantic tokens. Renders server-side; hover titles carry the detail and
 * an sr-only sentence narrates the whole pipeline for screen readers.
 */

const DOT_TONE: Record<StatusTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-muted ring-1 ring-border ring-inset',
}

function stepTitle(step: StepView): string {
  const parts = [`${humanize(step.key)} — ${step.status.toLowerCase()}`]
  if (step.attempts > 1) parts.push(`attempt ${step.attempts}`)
  if (step.error) parts.push(step.error)
  return parts.join(' · ')
}

export function StepTracker({ steps, className }: { steps: StepView[]; className?: string }) {
  const ordered = orderSteps(steps)
  if (ordered.length === 0) return <span className="text-muted-foreground text-xs">—</span>

  return (
    <div className={cn('flex items-center', className)}>
      {ordered.map((step, i) => (
        <div key={step.key} className="flex items-center">
          {i > 0 && <span aria-hidden className="bg-border h-px w-3" />}
          <span
            title={stepTitle(step)}
            aria-hidden
            className={cn(
              'block size-2.5 shrink-0 rounded-full',
              DOT_TONE[stepTone(step.status)],
              step.status === 'RUNNING' && 'motion-safe:animate-pulse',
            )}
          />
        </div>
      ))}
      <span className="sr-only">
        {ordered.map((s) => `${humanize(s.key)}: ${s.status.toLowerCase()}`).join(', ')}
      </span>
    </div>
  )
}
