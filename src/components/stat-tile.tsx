'use client'

import { useEffect, useState } from 'react'
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { countUpText, sparkGeometry } from '@/components/charts/spark'

export type StatTrend = {
  /** Percentage-point or percentage change versus the comparison window. */
  delta: number
  label: string
  /** When true, a falling number is the good outcome (e.g. days-to-close). */
  inverse?: boolean
}

const COUNT_UP_MS = 700

/**
 * Animates the digits of a formatted value from zero to their final reading.
 * SSR and the first client render both show the final value (no hydration
 * mismatch); the animation starts in an effect and is skipped entirely when
 * the user prefers reduced motion.
 */
function useCountUp(value: string): string {
  // The animation frame is keyed to the value it was computed for — a prop
  // change mid-animation falls back to the final text instantly.
  const [frame, setFrame] = useState<{ for: string; text: string } | null>(null)

  useEffect(() => {
    if (!/\d/.test(value)) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_UP_MS)
      const eased = 1 - Math.pow(1 - t, 3)
      setFrame(t >= 1 ? null : { for: value, text: countUpText(value, eased) })
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])

  return frame && frame.for === value ? frame.text : value
}

/** Decorative micro-trend under the value — identity stays in the text. */
function Sparkline({ data }: { data: number[] }) {
  const { line, area } = sparkGeometry(data, 100, 32, 2)
  if (!line) return null
  return (
    <svg
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      aria-hidden
      className="mt-2 h-8 w-full"
    >
      <path d={area} fill="var(--sparkline-fill)" />
      <path
        d={line}
        fill="none"
        stroke="var(--chart-1)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export function StatTile({
  label,
  value,
  hint,
  sample,
  trend,
  sparkline,
  className,
}: {
  label: string
  value: string
  hint?: string
  /** Denominator behind the figure — shown so ratios are never read blind. */
  sample?: string
  trend?: StatTrend
  /** Serializable micro-trend series, oldest first — drawn under the value. */
  sparkline?: number[]
  className?: string
}) {
  const good = trend ? (trend.inverse ? trend.delta < 0 : trend.delta > 0) : null
  const flat = trend ? Math.abs(trend.delta) < 0.05 : false
  const TrendIcon = flat ? ArrowRight : trend && trend.delta > 0 ? ArrowUpRight : ArrowDownRight
  const display = useCountUp(value)

  return (
    <div
      className={cn(
        'bg-card rounded-lg border p-4 transition-shadow hover:shadow-e2 motion-safe:transition-[box-shadow,transform] motion-safe:duration-200 motion-safe:hover:-translate-y-0.5',
        className,
      )}
    >
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{display}</span>
        {trend && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums',
                    flat
                      ? 'bg-muted text-muted-foreground'
                      : good
                        ? 'text-success bg-[color-mix(in_oklab,var(--success)_12%,transparent)]'
                        : 'text-danger bg-[color-mix(in_oklab,var(--danger)_12%,transparent)]',
                  )}
                >
                  <TrendIcon className="size-3" />
                  {Math.abs(trend.delta).toFixed(1)}%
                </span>
              }
            />
            <TooltipContent>{trend.label}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {sparkline && sparkline.length >= 2 && <Sparkline data={sparkline} />}
      {(hint || sample) && (
        <p className="text-muted-foreground mt-1 text-xs">
          {hint}
          {hint && sample && <span aria-hidden> · </span>}
          {sample && <span className="tabular-nums">{sample}</span>}
        </p>
      )}
    </div>
  )
}

export function StatGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('stagger-children grid grid-cols-2 gap-3 lg:grid-cols-4', className)}>{children}</div>
  )
}
