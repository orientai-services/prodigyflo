import { requirePermissionPage } from '@/lib/rbac'
import { getAttributionReport } from '@/lib/revops'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { StatTile } from '@/components/stat-tile'
import { BarCompare } from '@/components/charts/bar-compare'
import { Badge } from '@/components/ui/badge'
import { currency, number } from '@/lib/format'
import { RevopsTabs } from './revops-tabs'

export const metadata = { title: 'Revenue attribution' }

export default async function AttributionPage() {
  const user = await requirePermissionPage('analytics:marketing')
  const { table, totals } = await getAttributionReport(user)

  const hasData = table.some((r) => r.leadsFirst > 0 || r.leadsLast > 0 || r.touches > 0)

  return (
    <>
      <PageHeader
        title="Revenue attribution"
        description="Which campaigns and sources produced the leads that became closed-won revenue. Every figure names its attribution model — first-touch credits the touch that introduced the client, last-touch the one closest to close."
      >
        <RevopsTabs active="attribution" />
      </PageHeader>

      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Closed-won revenue"
            value={currency(totals.revenue)}
            hint="attributed below under both models"
            sample={`n=${totals.won} won`}
          />
          <StatTile label="Leads in scope" value={number(totals.leads)} hint="clients visible to you" />
          <StatTile
            label="Tracked ad spend"
            value={currency(totals.spend)}
            hint="campaigns with recorded spend"
          />
          <StatTile
            label="Blended CPL"
            value={totals.spend && totals.leads ? currency(totals.spend / totals.leads) : '—'}
            hint="all tracked spend ÷ all leads"
            sample={totals.leads ? `n=${totals.leads}` : undefined}
          />
        </div>

        {!hasData ? (
          <EmptyState
            icon="GitBranch"
            title="No attribution data yet"
            description="Attribution rows appear once clients carry campaign or source touches. Lead intake and campaign sync record them automatically."
          />
        ) : (
          <>
            <BarCompare
              title="Revenue by first touch"
              description="First-touch model: all revenue credited to the campaign or source that first brought the client in."
              rows={table
                .filter((r) => r.revenueFirst > 0)
                .slice(0, 12)
                .map((r) => ({
                  key: r.key,
                  label: r.name,
                  sublabel: r.kind === 'campaign' ? (r.channel ?? 'campaign') : r.kind,
                  value: r.revenueFirst,
                }))}
              format="currency"
              valueLabel="Revenue (first touch)"
              emptyMessage="No closed-won revenue to attribute yet."
              footnote="First-touch attribution — the earliest recorded touch per client takes full credit."
            />

            <section>
              <h2 className="mb-3 text-sm font-semibold">By campaign and source</h2>
              <div className="scroll-x rounded-lg border">
                <table className="w-full min-w-[64rem] text-sm tabular-nums">
                  <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">Campaign / source</th>
                      <th className="px-3 py-2 text-right">Touches</th>
                      <th className="px-3 py-2 text-right">Leads (first)</th>
                      <th className="px-3 py-2 text-right">Leads (last)</th>
                      <th className="px-3 py-2 text-right">Won (first)</th>
                      <th className="px-3 py-2 text-right">Won (last)</th>
                      <th className="px-3 py-2 text-right">Revenue (first)</th>
                      <th className="px-3 py-2 text-right">Revenue (last)</th>
                      <th className="px-3 py-2 text-right">Spend</th>
                      <th className="px-3 py-2 text-right">CPL (first)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {table.map((r) => (
                      <tr key={r.key} className="border-b last:border-0">
                        <td className="px-3 py-2.5">
                          <span className="font-medium">{r.name}</span>
                          <Badge variant="outline" className="text-muted-foreground ml-2 text-[0.625rem]">
                            {r.kind === 'campaign' ? (r.channel ?? 'campaign') : r.kind}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right">{number(r.touches)}</td>
                        <td className="px-3 py-2.5 text-right">{number(r.leadsFirst)}</td>
                        <td className="px-3 py-2.5 text-right">{number(r.leadsLast)}</td>
                        <td className="px-3 py-2.5 text-right">{number(r.wonFirst)}</td>
                        <td className="px-3 py-2.5 text-right">{number(r.wonLast)}</td>
                        <td className="px-3 py-2.5 text-right">{currency(r.revenueFirst)}</td>
                        <td className="px-3 py-2.5 text-right">{currency(r.revenueLast)}</td>
                        <td className="px-3 py-2.5 text-right">{r.spend !== null ? currency(r.spend) : '—'}</td>
                        <td className="px-3 py-2.5 text-right">
                          {r.cplFirst !== null ? currency(r.cplFirst, { cents: true }) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                “First” columns use first-touch attribution (earliest recorded touch per client);
                “last” columns use last-touch (latest touch). A client with no recorded touches
                falls back to the campaign or source on their record for both models. CPL shows
                only where spend is tracked, and is spend ÷ first-touch leads.
              </p>
            </section>
          </>
        )}
      </div>
    </>
  )
}
