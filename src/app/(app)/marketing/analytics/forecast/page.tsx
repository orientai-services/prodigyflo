import { requirePermissionPage } from '@/lib/rbac'
import { getForecastReport } from '@/lib/revops'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { StatTile } from '@/components/stat-tile'
import { TrendChart } from '@/components/charts/trend-chart'
import { Badge } from '@/components/ui/badge'
import { currency, number, percent } from '@/lib/format'
import { cn } from '@/lib/utils'
import { RevopsTabs } from '../revops-tabs'

export const metadata = { title: 'Revenue forecast' }

export default async function ForecastPage() {
  const user = await requirePermissionPage('analytics:marketing')
  const report = await getForecastReport(user)

  const coverage =
    report.openTotal > 0
      ? ((report.openTotal - report.unweightedValue) / report.openTotal) * 100
      : null

  return (
    <>
      <PageHeader
        title="Revenue forecast"
        description="An estimate, not a promise: open pipeline weighted by how often clients who reached each stage historically went on to close won. Stages without history fall back to the staff-entered probability on each client."
      >
        <RevopsTabs active="forecast" />
      </PageHeader>

      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Weighted forecast"
            value={currency(report.weightedTotal)}
            hint="open value × measured stage win rate"
          />
          <StatTile
            label="Open pipeline"
            value={currency(report.openTotal)}
            hint="unweighted estimated value"
            sample={`n=${report.stages.reduce((a, s) => a + s.clients, 0)} clients`}
          />
          <StatTile
            label="Closed won, last 90 days"
            value={currency(report.trailingWon90d)}
            hint="the recent reality the forecast is judged against"
          />
          <StatTile
            label="Forecast coverage"
            value={coverage !== null ? percent(coverage) : '—'}
            hint={
              report.unweightedClients > 0
                ? `${report.unweightedClients} client${report.unweightedClients === 1 ? '' : 's'} carry no probability at all and are excluded`
                : 'every open dollar carries a probability'
            }
          />
        </div>

        {report.stages.length === 0 ? (
          <EmptyState
            icon="TrendingUp"
            title="No open pipeline to forecast"
            description="Once clients with an estimated value are in progress, the weighted forecast builds itself from their stage history."
          />
        ) : (
          <>
            <TrendChart
              title="Closed-won revenue and forecast"
              description="Solid history: monthly closed-won revenue. Forecast: weighted open pipeline bucketed by expected close date (missing or past dates count in the current month)."
              data={report.trend.map((t) => ({ label: t.label, won: t.won, forecast: t.forecast }))}
              series={[
                { key: 'won', label: 'Closed won', format: 'currency' },
                { key: 'forecast', label: 'Weighted forecast (estimate)', format: 'currency' },
              ]}
              footnote="The forecast series is an estimate from measured stage-progression rates — it is not a commitment."
            />

            <section>
              <h2 className="mb-3 text-sm font-semibold">By stage</h2>
              <div className="scroll-x rounded-lg border">
                <table className="w-full min-w-[56rem] text-sm tabular-nums">
                  <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">Stage</th>
                      <th className="px-3 py-2 text-right">Open clients</th>
                      <th className="px-3 py-2 text-right">Open value</th>
                      <th className="px-3 py-2 text-right">Win probability</th>
                      <th className="px-3 py-2 text-left">Basis</th>
                      <th className="px-3 py-2 text-right">Weighted value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.stages.map((s) => (
                      <tr key={s.stageKey} className="border-b last:border-0">
                        <td className="px-3 py-2.5 font-medium">{s.label}</td>
                        <td className="px-3 py-2.5 text-right">{number(s.clients)}</td>
                        <td className="px-3 py-2.5 text-right">{currency(s.openValue)}</td>
                        <td className="px-3 py-2.5 text-right">
                          {s.measuredProbability !== null ? percent(s.measuredProbability * 100) : '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          {s.probabilitySource === 'measured' ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                'border-transparent',
                                s.n < report.minimumSample
                                  ? 'bg-warning/10 text-warning'
                                  : 'bg-success/10 text-success',
                              )}
                            >
                              measured · n={s.n}
                              {s.n < report.minimumSample ? ' (small sample)' : ''}
                            </Badge>
                          ) : s.probabilitySource === 'client-fallback' ? (
                            <Badge variant="outline" className="text-muted-foreground">
                              no stage history · per-client estimates
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-muted text-muted-foreground border-transparent">
                              no probability — excluded
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium">{currency(s.weightedValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-surface-sunk/60 border-t">
                      <td className="px-3 py-2.5 font-semibold">Total</td>
                      <td className="px-3 py-2.5 text-right">
                        {number(report.stages.reduce((a, s) => a + s.clients, 0))}
                      </td>
                      <td className="px-3 py-2.5 text-right">{currency(report.openTotal)}</td>
                      <td className="px-3 py-2.5" colSpan={2} />
                      <td className="px-3 py-2.5 text-right font-semibold">
                        {currency(report.weightedTotal)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                Win probability = share of clients who ever entered the stage and whose outcome is
                decided (won or lost) that closed won; open clients never count toward n. Stages
                with n below {report.minimumSample} (this organization&apos;s minimum ranking
                sample) are flagged. Where a stage has no decided history at all, each client&apos;s
                own staff-entered probability weights their value instead.
              </p>
            </section>
          </>
        )}
      </div>
    </>
  )
}
