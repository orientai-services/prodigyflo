import { requirePermissionPage } from '@/lib/rbac'
import { getJourneyReport } from '@/lib/revops'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { StatTile } from '@/components/stat-tile'
import { BarCompare } from '@/components/charts/bar-compare'
import { Badge } from '@/components/ui/badge'
import { duration, number, percent } from '@/lib/format'
import { RevopsTabs } from '../revops-tabs'

export const metadata = { title: 'Customer journey' }

export default async function JourneyPage() {
  const user = await requirePermissionPage('analytics:marketing')
  const report = await getJourneyReport(user)

  const worst = report.biggestDropoffs[0] ?? null

  return (
    <>
      <PageHeader
        title="Customer journey"
        description="How long clients actually spend in each stage, and where decided clients most often end up lost instead of won. Sample sizes are shown everywhere — small ones are flagged, not hidden."
      >
        <RevopsTabs active="journey" />
      </PageHeader>

      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Median lead → close"
            value={
              report.medianLeadToCloseDays !== null
                ? `${report.medianLeadToCloseDays.toFixed(report.medianLeadToCloseDays < 10 ? 1 : 0)} days`
                : '—'
            }
            hint="first recorded stage to closed won"
            sample={report.wonSample ? `n=${report.wonSample} won` : 'no closed-won clients yet'}
          />
          <StatTile
            label="Biggest drop-off stage"
            value={worst ? worst.label : '—'}
            hint={
              worst
                ? `only ${percent(worst.wonShare ?? 0)} of decided clients who reached it went on to win`
                : `needs at least ${report.minimumSample} decided clients per stage`
            }
            sample={worst ? `n=${worst.decided} decided` : undefined}
          />
          <StatTile
            label="Clients in scope"
            value={number(report.clientCount)}
            hint="everything below is measured on these"
          />
          <StatTile
            label="Minimum ranking sample"
            value={String(report.minimumSample)}
            hint="stages below this n are flagged, never ranked"
          />
        </div>

        {report.stages.length === 0 ? (
          <EmptyState
            icon="Route"
            title="No journey history yet"
            description="Stage timings appear as clients move through the pipeline — every stage change is recorded automatically."
          />
        ) : (
          <>
            <BarCompare
              title="Median time in stage"
              description="Median of completed stays per stage — a client still sitting in a stage does not shorten its median."
              rows={report.stages
                .filter((s) => s.medianMinutes !== null)
                .map((s) => ({
                  key: s.stageKey,
                  label: s.label,
                  sublabel: `n=${s.staysMeasured} completed stay${s.staysMeasured === 1 ? '' : 's'}`,
                  value: (s.medianMinutes ?? 0) / 60,
                  display: duration(s.medianMinutes),
                  muted: s.staysMeasured < report.minimumSample,
                }))}
              format="hours"
              valueLabel="Median time"
              emptyMessage="No completed stage stays measured yet."
              footnote={`Greyed rows have fewer than ${report.minimumSample} measured stays — read them as anecdotes, not patterns.`}
            />

            <section>
              <h2 className="mb-3 text-sm font-semibold">Stage by stage</h2>
              <div className="scroll-x rounded-lg border">
                <table className="w-full min-w-[56rem] text-sm tabular-nums">
                  <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">Stage</th>
                      <th className="px-3 py-2 text-right">Clients entered</th>
                      <th className="px-3 py-2 text-right">Median time in stage</th>
                      <th className="px-3 py-2 text-right">Measured stays</th>
                      <th className="px-3 py-2 text-right">Decided outcomes</th>
                      <th className="px-3 py-2 text-right">Went on to win</th>
                      <th className="px-3 py-2 text-left">Sample</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.stages.map((s) => (
                      <tr key={s.stageKey} className="border-b last:border-0">
                        <td className="px-3 py-2.5 font-medium">{s.label}</td>
                        <td className="px-3 py-2.5 text-right">{number(s.entered)}</td>
                        <td className="px-3 py-2.5 text-right">{duration(s.medianMinutes)}</td>
                        <td className="px-3 py-2.5 text-right">{number(s.staysMeasured)}</td>
                        <td className="px-3 py-2.5 text-right">{number(s.decided)}</td>
                        <td className="px-3 py-2.5 text-right">
                          {s.wonShare !== null ? percent(s.wonShare) : '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          {s.belowMinimumSample ? (
                            <Badge variant="outline" className="bg-warning/10 text-warning border-transparent">
                              below n={report.minimumSample}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-muted-foreground">
                              n={s.decided}
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                “Went on to win” = of the clients who ever entered the stage and are now decided
                (closed won or lost), the share that won — open clients are excluded so in-flight
                work never reads as a loss. Drop-off ranking only considers stages at or above the
                minimum sample of {report.minimumSample} decided clients.
              </p>
            </section>

            {report.biggestDropoffs.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold">Where clients are lost</h2>
                <div className="grid gap-3 sm:grid-cols-3">
                  {report.biggestDropoffs.map((s, i) => (
                    <StatTile
                      key={s.stageKey}
                      label={`#${i + 1} drop-off · ${s.label}`}
                      value={percent(100 - (s.wonShare ?? 0))}
                      hint="of decided clients reaching this stage were ultimately lost"
                      sample={`n=${s.decided}`}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </>
  )
}
