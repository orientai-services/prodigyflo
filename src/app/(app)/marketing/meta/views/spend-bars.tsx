'use client'

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatValue } from '@/lib/format'
import { CHART_HEIGHT, ChartFrame, ChartTooltip, GRID_INK, MUTED_INK } from '@/components/charts/chart-frame'

/**
 * Daily spend as bars, in the shared chart frame (title, table view, tokens).
 * Data arrives as plain { date, spend } rows from the server.
 */
export function SpendBars({
  title, description, data, footnote,
}: { title: string; description?: string; data: { date: string; spend: number }[]; footnote?: string }) {
  const rows = data.map((d) => ({ label: d.date.slice(5), date: d.date, spend: d.spend }))

  return (
    <ChartFrame
      title={title}
      description={description}
      tableColumns={[
        { key: 'date', label: 'Day' },
        { key: 'spend', label: 'Spend', align: 'right' },
      ]}
      tableRows={[...rows].reverse().map((r) => [r.date, formatValue(r.spend, 'currencyCents')])}
      footnote={footnote}
    >
      <div style={{ height: CHART_HEIGHT.sm }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid stroke={GRID_INK} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fill: MUTED_INK, fontSize: 11 }}
              minTickGap={16}
              dy={6}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fill: MUTED_INK, fontSize: 11 }}
              width={52}
              tickFormatter={(v) => formatValue(Number(v), 'currency')}
            />
            <Tooltip
              cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <ChartTooltip
                    label={String((payload[0].payload as { date: string }).date)}
                    rows={[{ label: 'Spend', value: formatValue(Number(payload[0].value), 'currencyCents'), color: 'var(--chart-1)' }]}
                  />
                ) : null
              }
            />
            <Bar dataKey="spend" fill="var(--chart-1)" radius={[2, 2, 0, 0]} maxBarSize={14} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  )
}
