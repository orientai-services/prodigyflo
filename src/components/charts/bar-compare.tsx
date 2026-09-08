'use client'

import { formatValue, type ValueFormat } from '@/lib/format'
import { ChartFrame } from './chart-frame'
import { cn } from '@/lib/utils'

export type BarRow = {
  key: string
  label: string
  value: number
  /** Rendered to the right of the bar; falls back to the formatted value. */
  display?: string
  /** Secondary line under the label — sample size, team, channel. */
  sublabel?: string
  /** Overrides the single-hue fill. Use only for status, never for rank. */
  color?: string
  /** Marks rows the caller wants visually de-emphasised (e.g. small samples). */
  muted?: boolean
}

/**
 * Horizontal magnitude comparison, sorted by the caller. One hue by default:
 * the bars encode size, and color carries no extra meaning.
 */
export function BarCompare({
  title,
  description,
  rows,
  format,
  valueLabel = 'Value',
  footnote,
  emptyMessage = 'Nothing to compare yet.',
  className,
}: {
  title: string
  description?: string
  rows: BarRow[]
  /** Serializable format key — a function cannot cross the RSC boundary. */
  format: ValueFormat
  valueLabel?: string
  footnote?: string
  emptyMessage?: string
  className?: string
}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)))

  return (
    <ChartFrame
      title={title}
      description={description}
      tableColumns={[
        { key: 'label', label: 'Name' },
        { key: 'value', label: valueLabel, align: 'right' },
      ]}
      tableRows={rows.map((r) => [r.sublabel ? `${r.label} — ${r.sublabel}` : r.label, r.display ?? formatValue(r.value, format)])}
      footnote={footnote}
      className={className}
    >
      {rows.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">{emptyMessage}</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((row) => (
            <li key={row.key} className={cn(row.muted && 'opacity-60')}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{row.label}</span>
                  {row.sublabel && <span className="text-muted-foreground ml-1.5">{row.sublabel}</span>}
                </span>
                <span className="shrink-0 font-medium tabular-nums">{row.display ?? formatValue(row.value, format)}</span>
              </div>
              <div className="bg-muted mt-1 h-2 overflow-hidden rounded-[4px]">
                <div
                  className="h-full rounded-[4px]"
                  style={{
                    width: `${Math.max((Math.abs(row.value) / max) * 100, row.value === 0 ? 0 : 1)}%`,
                    background: row.color ?? 'var(--chart-1)',
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </ChartFrame>
  )
}
