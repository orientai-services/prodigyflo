import { cn } from '@/lib/utils'

/**
 * Tiny inline-SVG trend marks for the Meta command center. Pure presentational
 * functions of a serializable number[] — safe on either side of the RSC
 * boundary, colored purely via currentColor + tokens.
 */

/** Smooth 7–30 point line for KPI tiles. Flat-lines gracefully on empty data. */
export function Sparkline({ data, className }: { data: number[]; className?: string }) {
  const w = 96
  const h = 28
  const points = data.length >= 2 ? data : [0, 0]
  const max = Math.max(...points, 1)
  const min = Math.min(...points, 0)
  const span = max - min || 1
  const step = w / (points.length - 1)
  const path = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`)
    .join(' ')

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={cn('text-primary/70 h-7 w-24', className)}
      aria-hidden
      preserveAspectRatio="none"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 7-day spend microbar for table rows — Ads-Manager-familiar at a glance. */
export function Microbar({ data, className }: { data: number[]; className?: string }) {
  const points = data.length > 0 ? data : [0]
  const max = Math.max(...points, 1)
  const bw = 5
  const gap = 2
  const h = 18
  const w = points.length * (bw + gap) - gap

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn('text-primary/60 h-4', className)} style={{ width: w }} aria-hidden>
      {points.map((v, i) => {
        const bh = Math.max(1.5, (v / max) * (h - 2))
        return (
          <rect
            key={i}
            x={i * (bw + gap)}
            y={h - bh}
            width={bw}
            height={bh}
            rx={1}
            fill="currentColor"
            opacity={v === 0 ? 0.25 : 1}
          />
        )
      })}
    </svg>
  )
}
