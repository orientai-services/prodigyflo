'use client'

import { useId } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatValue, type ValueFormat } from '@/lib/format'
import {
  CHART_HEIGHT,
  ChartFrame,
  ChartTooltip,
  GRID_INK,
  MUTED_INK,
  SERIES_COLORS,
  type ChartSize,
} from './chart-frame'

export type TrendPoint = { label: string } & Record<string, string | number>

export type TrendSeries = {
  key: string
  label: string
  /** Serializable format key — a function cannot cross the RSC boundary. */
  format: ValueFormat
}

/**
 * Change over time. One y-scale only — two measures of different magnitude get
 * two charts, never a second axis. Each line carries a soft gradient area fill
 * derived from its own series token via opacity — never a new hex.
 */
export function TrendChart({
  title,
  description,
  data,
  series,
  footnote,
  size = 'md',
  height,
  className,
}: {
  title: string
  description?: string
  data: TrendPoint[]
  series: TrendSeries[]
  footnote?: string
  /** Standard chart scale — sm 200 / md 240 / lg 300. */
  size?: ChartSize
  /** Escape hatch for a non-standard pixel height; prefer `size`. */
  height?: number
  className?: string
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const colored = series.map((s, i) => ({ ...s, color: SERIES_COLORS[i % SERIES_COLORS.length] }))
  const gradientId = (key: string) => `trend-${uid}-${key.replace(/[^a-zA-Z0-9]/g, '')}`

  return (
    <ChartFrame
      title={title}
      description={description}
      series={colored.map((s) => ({ label: s.label, color: s.color }))}
      tableColumns={[
        { key: 'label', label: 'Period' },
        ...colored.map((s) => ({ key: s.key, label: s.label, align: 'right' as const })),
      ]}
      tableRows={data.map((d) => [d.label, ...colored.map((s) => formatValue(Number(d[s.key] ?? 0), s.format))])}
      footnote={footnote}
      className={className}
    >
      <div style={{ height: height ?? CHART_HEIGHT[size] }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
            <defs>
              {colored.map((s) => (
                <linearGradient key={s.key} id={gradientId(s.key)} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid stroke={GRID_INK} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fill: MUTED_INK, fontSize: 11 }}
              dy={6}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fill: MUTED_INK, fontSize: 11 }}
              width={52}
              tickFormatter={(v) => formatValue(Number(v), colored[0].format)}
            />
            <Tooltip
              cursor={{ stroke: GRID_INK, strokeWidth: 1 }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <ChartTooltip
                    label={String(label)}
                    rows={payload.map((p) => {
                      const s = colored.find((c) => c.key === p.dataKey)
                      return {
                        label: s?.label ?? String(p.dataKey),
                        value: s ? formatValue(Number(p.value), s.format) : String(p.value),
                        color: s?.color,
                      }
                    })}
                  />
                ) : null
              }
            />
            {colored.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2}
                fill={`url(#${gradientId(s.key)})`}
                fillOpacity={1}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  )
}
