import { AlertTriangle, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { duration, hoursBetween } from '@/lib/format'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * Time in stage, coloured against the stage SLA.
 * No SLA configured means no judgement is rendered — just the elapsed time.
 */
export function SlaIndicator({
  since,
  slaHours,
  className,
}: {
  since: Date | string
  slaHours: number | null
  className?: string
}) {
  const elapsed = hoursBetween(since)
  const pct = slaHours ? (elapsed / slaHours) * 100 : null
  const breached = pct !== null && pct >= 100
  const warning = pct !== null && pct >= 80 && pct < 100

  const body = (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs tabular-nums',
        breached ? 'text-danger font-medium' : warning ? 'text-warning' : 'text-muted-foreground',
        className,
      )}
    >
      {breached ? <AlertTriangle className="size-3" /> : <Clock className="size-3" />}
      {duration(elapsed * 60)}
    </span>
  )

  if (!slaHours) return body

  return (
    <Tooltip>
      <TooltipTrigger render={body} />
      <TooltipContent>
        {breached
          ? `Past the ${slaHours}h SLA for this stage`
          : `${Math.round(pct!)}% of the ${slaHours}h stage SLA used`}
      </TooltipContent>
    </Tooltip>
  )
}
