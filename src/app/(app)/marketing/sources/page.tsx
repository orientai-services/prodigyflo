import Link from 'next/link'
import { Download } from 'lucide-react'
import { requirePermissionPage } from '@/lib/rbac'
import {
  MARKETING_RANGES,
  getMarketingOverview,
  marketingRange,
  type SourceRollup,
} from '@/lib/marketing-metrics'
import { PageHeader } from '@/components/page-header'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { EmptyState } from '@/components/empty-state'
import { BarCompare } from '@/components/charts/bar-compare'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { currency, humanize, number, percent } from '@/lib/format'
import { MarketingTabs } from '../marketing-tabs'

export const metadata = { title: 'Lead sources' }

/** Enough decided volume to compare rates without being noise. */
const MIN_SAMPLE = 10

function bestBy(sources: SourceRollup[], key: 'qualifiedRate' | 'wonRate'): SourceRollup | null {
  const eligible = sources.filter((s) => s.leads >= MIN_SAMPLE && s[key] !== null)
  if (eligible.length === 0) return null
  return eligible.reduce((best, s) => ((s[key] ?? 0) > (best[key] ?? 0) ? s : best))
}

function RateBar({ pct, color }: { pct: number | null; color: string }) {
  return (
    <div className="bg-muted h-1.5 w-20 overflow-hidden rounded-full">
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.min(pct ?? 0, 100)}%`, background: color }}
      />
    </div>
  )
}

export default async function LeadSourcesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePermissionPage('analytics:marketing')
  const params = await searchParams
  const range = marketingRange(typeof params.range === 'string' ? params.range : undefined)

  const { totals, sources, campaigns } = await getMarketingOverview(user, range)
  const activeSources = sources.filter((s) => s.leads > 0)
  const attributed = totals.leads - totals.unattributed
  const coverage = totals.leads ? (attributed / totals.leads) * 100 : null
  const bestQualified = bestBy(sources, 'qualifiedRate')
  const bestWon = bestBy(sources, 'wonRate')

  return (
    <>
      <PageHeader
        title="Lead sources"
        description={`Which sources produce leads that qualify and close · ${range.label.toLowerCase()}`}
        actions={
          <>
            <Button variant="outline" size="sm" render={<a href={`/exports/marketing-sources?range=${range.key}`} />}>
              <Download className="size-3.5" />
              Export CSV
            </Button>
            <div className="bg-surface-sunk flex items-center gap-0.5 rounded-lg border p-0.5">
              {MARKETING_RANGES.map((r) => (
                <Link
                  key={r.key}
                  href={`/marketing/sources?range=${r.key}`}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    range.key === r.key
                      ? 'bg-surface-raised shadow-e1'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {r.label}
                </Link>
              ))}
            </div>
          </>
        }
      >
        <MarketingTabs active="sources" />
      </PageHeader>

      <div className="space-y-6 p-4 sm:p-6">
        <StatGrid>
          <StatTile
            label="Attributed leads"
            value={number(attributed)}
            hint={`of ${number(totals.leads)} new leads in range`}
          />
          <StatTile
            label="Attribution coverage"
            value={coverage === null ? '—' : percent(coverage, 1)}
            hint={
              totals.unattributed > 0
                ? `${number(totals.unattributed)} leads carry no source`
                : 'every lead carries a source'
            }
          />
          <StatTile
            label="Best qualified rate"
            value={bestQualified ? percent(bestQualified.qualifiedRate, 1) : '—'}
            hint={bestQualified ? bestQualified.name : `needs ${MIN_SAMPLE}+ leads per source`}
            sample={bestQualified ? `n=${number(bestQualified.leads)}` : undefined}
          />
          <StatTile
            label="Best close rate"
            value={bestWon ? percent(bestWon.wonRate, 1) : '—'}
            hint={bestWon ? bestWon.name : `needs ${MIN_SAMPLE}+ leads per source`}
            sample={bestWon ? `n=${number(bestWon.leads)}` : undefined}
          />
        </StatGrid>

        {activeSources.length === 0 && campaigns.length === 0 ? (
          <EmptyState
            icon="Radar"
            title="No attributed leads in this window"
            description="As leads arrive with a source or campaign attached, their volume and conversion appear here. Intake sources set attribution automatically."
          />
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <BarCompare
                title="Lead volume by source"
                description="Every lead in range attributed to a source"
                format="number"
                valueLabel="Leads"
                rows={activeSources.map((s) => ({
                  key: s.id,
                  label: s.name,
                  sublabel: humanize(s.channel),
                  value: s.leads,
                }))}
                emptyMessage="No attributed leads yet."
              />
              <BarCompare
                title="Close rate by source"
                description="Closed-won ÷ leads per source — small samples are dimmed, not hidden"
                format="percent"
                valueLabel="Close rate"
                rows={activeSources.map((s) => ({
                  key: s.id,
                  label: s.name,
                  sublabel: `${number(s.won)} won of ${number(s.leads)} leads`,
                  value: s.wonRate ?? 0,
                  display: s.won === 0 ? 'no closes yet' : percent(s.wonRate, 1),
                  muted: s.leads < MIN_SAMPLE,
                }))}
                footnote={`Sources with fewer than ${MIN_SAMPLE} leads are dimmed — too little data to judge fairly.`}
                emptyMessage="No attributed leads yet."
              />
            </div>

            {/* ── Source conversion table ──────────────────────────────── */}
            <section>
              <div className="mb-3">
                <h2 className="text-sm font-semibold">Source performance</h2>
                <p className="text-muted-foreground text-xs">
                  The full funnel per source: leads in, share that reached qualified, share that closed
                </p>
              </div>
              <div className="scroll-x rounded-lg border">
                <table className="w-full min-w-[52rem] text-sm tabular-nums">
                  <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">Source</th>
                      <th className="px-3 py-2 text-right">Leads</th>
                      <th className="px-3 py-2 text-right">Qualified</th>
                      <th className="px-3 py-2 text-left">Qualified rate</th>
                      <th className="px-3 py-2 text-right">Won</th>
                      <th className="px-3 py-2 text-left">Close rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.filter((s) => s.leads > 0 || s.isActive).map((s) => (
                      <tr
                        key={s.id}
                        className={cn(
                          'hover:bg-muted/40 border-b transition-colors last:border-0',
                          s.leads < MIN_SAMPLE && 'opacity-70',
                        )}
                      >
                        <td className="px-3 py-2.5">
                          <span className="font-medium">{s.name}</span>
                          <span className="text-muted-foreground ml-2 text-xs">{humanize(s.channel)}</span>
                          {!s.isActive && (
                            <Badge variant="outline" className="text-muted-foreground ml-2 text-[0.625rem]">
                              inactive
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium">{number(s.leads)}</td>
                        <td className="px-3 py-2.5 text-right">{number(s.qualified)}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <RateBar pct={s.qualifiedRate} color="var(--chart-1)" />
                            <span className="text-xs">
                              {s.qualifiedRate === null ? '—' : percent(s.qualifiedRate, 1)}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right">{number(s.won)}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <RateBar pct={s.wonRate} color="var(--success)" />
                            <span className="text-xs">{s.wonRate === null ? '—' : percent(s.wonRate, 1)}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                Counted on leads created in the window; “qualified” and “won” mean the client entered that
                stage at any point (stage history), so late conversions still credit their source. Rows with
                fewer than {MIN_SAMPLE} leads are faded.
              </p>
            </section>

            {/* ── Campaign efficiency ──────────────────────────────────── */}
            <section>
              <div className="mb-3">
                <h2 className="text-sm font-semibold">Campaign efficiency</h2>
                <p className="text-muted-foreground text-xs">
                  Spend against funnel outcomes per campaign — revenue attribution lives in{' '}
                  <Link href="/marketing/analytics" className="hover:text-foreground underline underline-offset-2">
                    Attribution &amp; forecast
                  </Link>
                </p>
              </div>
              {campaigns.length === 0 ? (
                <div className="rounded-lg border">
                  <EmptyState
                    icon="Megaphone"
                    title="No campaign activity in range"
                    description="Campaigns appear once they record spend, delivery, or attributed leads."
                    className="py-10"
                  />
                </div>
              ) : (
                <div className="scroll-x rounded-lg border">
                  <table className="w-full min-w-[56rem] text-sm tabular-nums">
                    <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                      <tr>
                        <th className="px-3 py-2 text-left">Campaign</th>
                        <th className="px-3 py-2 text-right">Spend</th>
                        <th className="px-3 py-2 text-right">Leads</th>
                        <th className="px-3 py-2 text-right">Qualified</th>
                        <th className="px-3 py-2 text-right">Won</th>
                        <th className="px-3 py-2 text-right">CPL</th>
                        <th className="px-3 py-2 text-right">Cost / qualified</th>
                        <th className="px-3 py-2 text-right">CTR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {campaigns.map((c) => (
                        <tr key={c.id} className="hover:bg-muted/40 border-b transition-colors last:border-0">
                          <td className="px-3 py-2.5">
                            <span className="font-medium">{c.name}</span>
                            <span className="text-muted-foreground block text-xs">
                              {humanize(c.channel)}
                              {c.sourceName ? ` · ${c.sourceName}` : ''}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right">{c.spend ? currency(c.spend) : '—'}</td>
                          <td className="px-3 py-2.5 text-right font-medium">{number(c.leads)}</td>
                          <td className="px-3 py-2.5 text-right">
                            {number(c.qualified)}
                            <span className="text-muted-foreground ml-1 text-xs">
                              ({c.qualifiedRate === null ? '—' : percent(c.qualifiedRate, 0)})
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right">{number(c.won)}</td>
                          <td className="px-3 py-2.5 text-right">
                            {c.costPerLead === null ? '—' : currency(c.costPerLead, { cents: true })}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            {c.costPerQualified === null ? '—' : currency(c.costPerQualified, { cents: true })}
                          </td>
                          <td className="px-3 py-2.5 text-right">{c.ctr === null ? '—' : percent(c.ctr, 1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </>
  )
}
