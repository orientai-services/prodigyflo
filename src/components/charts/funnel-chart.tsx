'use client'

import { ChartFrame } from './chart-frame'
import { number, percent } from '@/lib/format'
import { cn } from '@/lib/utils'

export type FunnelStep = {
  key: string
  label: string
  count: number
  ofTotal: number | null
  stepConversion: number | null
  droppedOff: number
}

/**
 * A funnel is magnitude down an ordered set of steps — one measure, one hue.
 * Every bar carries its own value label, so the reading never depends on color.
 */
export function FunnelChart({
  steps,
  title = 'Client journey funnel',
  description,
  className,
}: {
  steps: FunnelStep[]
  title?: string
  description?: string
  className?: string
}) {
  const max = Math.max(1, ...steps.map((s) => s.count))
  const worst = steps.reduce<FunnelStep | null>(
    (acc, s) => (s.stepConversion !== null && (!acc || s.stepConversion < (acc.stepConversion ?? 100)) ? s : acc),
    null,
  )

  return (
    <ChartFrame
      title={title}
      description={description}
      tableColumns={[
        { key: 'label', label: 'Step' },
        { key: 'count', label: 'Clients', align: 'right' },
        { key: 'ofTotal', label: '% of leads', align: 'right' },
        { key: 'step', label: 'Step conversion', align: 'right' },
        { key: 'drop', label: 'Dropped off', align: 'right' },
      ]}
      tableRows={steps.map((s) => [
        s.label,
        number(s.count),
        s.ofTotal === null ? '—' : percent(s.ofTotal, 1),
        s.stepConversion === null ? '—' : percent(s.stepConversion, 1),
        s.droppedOff ? number(s.droppedOff) : '—',
      ])}
      footnote={
        worst
          ? `Largest drop-off: ${worst.droppedOff} clients leave before “${worst.label}” (${percent(worst.stepConversion ?? 0, 0)} step conversion).`
          : undefined
      }
      className={className}
    >
      <ol className="space-y-2.5">
        {steps.map((step) => {
          const width = (step.count / max) * 100
          const isWorst = worst?.key === step.key && step.droppedOff > 0
          return (
            <li key={step.key}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="truncate font-medium">{step.label}</span>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {number(step.count)}
                  {step.stepConversion !== null && (
                    <span className={cn('ml-2', isWorst && 'text-danger font-medium')}>
                      {percent(step.stepConversion, 0)}
                    </span>
                  )}
                </span>
              </div>
              <div className="bg-muted mt-1 h-2.5 overflow-hidden rounded-[4px]">
                <div
                  className="h-full rounded-[4px]"
                  style={{ width: `${Math.max(width, 1)}%`, background: 'var(--chart-1)' }}
                />
              </div>
            </li>
          )
        })}
      </ol>
    </ChartFrame>
  )
}
