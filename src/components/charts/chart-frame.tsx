'use client'

import { useState } from 'react'
import { Table2, BarChart3 } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Fixed categorical order. A 6th series folds into "Other" — never a new hue. */
export const SERIES_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const

export const MUTED_INK = 'var(--muted-foreground)'
export const GRID_INK = 'var(--border)'

export type TableColumn = { key: string; label: string; align?: 'left' | 'right' }

/** Standard chart-area scale — one of three heights, never ad-hoc pixels. */
export type ChartSize = 'sm' | 'md' | 'lg'
export const CHART_HEIGHT: Record<ChartSize, number> = { sm: 200, md: 240, lg: 300 }

/**
 * Wraps every chart with a title, an always-present legend for multi-series,
 * and a table view — so identity is never carried by color alone and any
 * contrast-relief obligation is satisfied.
 */
export function ChartFrame({
  title,
  description,
  series,
  tableColumns,
  tableRows,
  footnote,
  size,
  className,
  children,
}: {
  title: string
  description?: string
  /** Omit or pass one entry for a single-series chart — no legend box is drawn. */
  series?: { label: string; color: string }[]
  tableColumns: TableColumn[]
  tableRows: (string | number)[][]
  footnote?: string
  /** Fixes the chart area to the standard sm/md/lg scale (200/240/300px). */
  size?: ChartSize
  className?: string
  children: React.ReactNode
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const showLegend = (series?.length ?? 0) >= 2

  return (
    <figure className={cn('bg-card rounded-lg border', className)}>
      <figcaption className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{title}</h3>
          {description && <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>}
        </div>

        <div className="flex items-center gap-3">
          {showLegend && (
            <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {series!.map((s) => (
                <li key={s.label} className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <span className="size-2 rounded-[2px]" style={{ background: s.color }} aria-hidden />
                  {s.label}
                </li>
              ))}
            </ul>
          )}

          <div className="bg-muted flex rounded-md p-0.5" role="group" aria-label="View mode">
            {(['chart', 'table'] as const).map((mode) => {
              const Icon = mode === 'chart' ? BarChart3 : Table2
              return (
                <button
                  key={mode}
                  onClick={() => setView(mode)}
                  aria-pressed={view === mode}
                  aria-label={`${mode} view`}
                  className={cn(
                    'rounded px-1.5 py-1 transition-colors',
                    view === mode ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5" />
                </button>
              )
            })}
          </div>
        </div>
      </figcaption>

      <div className="p-4">
        {view === 'chart' ? (
          size ? <div style={{ height: CHART_HEIGHT[size] }}>{children}</div> : children
        ) : (
          <div className="scroll-x">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-muted-foreground border-b text-xs">
                  {tableColumns.map((c) => (
                    <th key={c.key} className={cn('px-2 py-1.5 font-medium', c.align === 'right' ? 'text-right' : 'text-left')}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {row.map((cell, j) => (
                      <td
                        key={j}
                        className={cn(
                          'px-2 py-1.5',
                          tableColumns[j]?.align === 'right' ? 'text-right tabular-nums' : 'text-left',
                        )}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {footnote && <p className="text-muted-foreground border-t px-4 py-2 text-xs">{footnote}</p>}
    </figure>
  )
}

/** Shared tooltip shell so every chart's hover layer looks identical. */
export function ChartTooltip({
  label,
  rows,
}: {
  label: string
  rows: { label: string; value: string; color?: string }[]
}) {
  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-2.5 py-2 text-xs shadow-md">
      <p className="font-medium">{label}</p>
      <ul className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            {r.color && <span className="size-2 shrink-0 rounded-[2px]" style={{ background: r.color }} aria-hidden />}
            <span className="text-muted-foreground">{r.label}</span>
            <span className="ml-auto font-medium tabular-nums">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
