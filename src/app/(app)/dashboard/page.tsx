import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { requirePermissionPage, requireUser } from '@/lib/rbac'
import {
  getAtRiskClients,
  getFunnel,
  getLossReasons,
  getMetrics,
  getMonthlyTrend,
  getWorkloadDistribution,
} from '@/lib/analytics'
import { getAttentionItems } from '@/lib/attention'
import { PageHeader } from '@/components/page-header'
import { AttentionCard } from '@/components/dashboard/attention-card'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { FunnelChart } from '@/components/charts/funnel-chart'
import { TrendChart } from '@/components/charts/trend-chart'
import { BarCompare } from '@/components/charts/bar-compare'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { StageBadge } from '@/components/stage-badge'
import { EmptyState } from '@/components/empty-state'
import { currency, duration, number, percent } from '@/lib/format'

export const metadata = { title: 'Dashboard' }

export default async function DashboardPage() {
  const session = await requireUser()
  if (session.role === 'ADMIN' || session.role === 'SUPER_ADMIN' || session.role === 'CLOSER') {
    redirect('/board')
  }

  const user = await requirePermissionPage('analytics:org')

  const [metrics, funnel, trend, atRisk, workload, lossReasons, attention] = await Promise.all([
    getMetrics(user),
    getFunnel(user),
    getMonthlyTrend(user, 6),
    getAtRiskClients(user, 8),
    getWorkloadDistribution(user),
    getLossReasons(user),
    getAttentionItems(user),
  ])

  const overCapacity = workload.filter((w) => w.utilization > 100).length
  const lostTotal = lossReasons.reduce((s, r) => s + r.count, 0)

  return (
    <>
      <PageHeader
        title={`Good to see you, ${user.name.split(' ')[0]}`}
        description={`${user.organizationName} · every client, all regions`}
      />

      <div className="space-y-5 p-4 sm:p-6">
        <StatGrid>
          <StatTile
            label="Open pipeline"
            value={currency(metrics.pipelineValue, { compact: true })}
            hint="Active clients"
            sample={`${number(metrics.total - metrics.won - metrics.lost)} open`}
          />
          <StatTile
            label="Closed-won revenue"
            value={currency(metrics.revenue, { compact: true })}
            hint="All time"
            sample={`${number(metrics.won)} deals`}
            sparkline={trend.map((t) => Number(t.revenue ?? 0))}
          />
          <StatTile
            label="Close rate"
            value={metrics.closeRate === null ? '—' : percent(metrics.closeRate, 1)}
            hint="Won ÷ decided"
            sample={`n=${metrics.won + metrics.lost}`}
          />
          <StatTile
            label="Median speed to contact"
            value={
              metrics.medianSpeedToContactHours === null
                ? '—'
                : duration(metrics.medianSpeedToContactHours * 60)
            }
            hint="Lead created → first contact"
            sample={`n=${metrics.contacted}`}
          />
        </StatGrid>

        <CollapsibleSection
          title="Needs attention"
          description="What has drifted off-target across your book"
          summary={attention.length > 0 ? `${number(attention.length)} items` : 'all clear'}
          storageKey="dash-attention"
        >
          <AttentionCard user={user} items={attention} hideHeader />
        </CollapsibleSection>


        <CollapsibleSection
          title="Funnel & trend"
          description="Where clients convert, and how revenue is moving"
          summary={`${number(metrics.total)} clients`}
          storageKey="dash-funnel"
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <FunnelChart
              steps={funnel}
              description={`Every client created to date · n=${number(metrics.total)}`}
            />
            <TrendChart
              title="Closed-won revenue"
              description="Last 6 months, by month the deal was won"
              data={trend}
              series={[{ key: 'revenue', label: 'Revenue', format: 'currencyCompact' }]}
              size="md"
            />
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Team"
          description="Who is overloaded, and which clients are slipping"
          summary={
            atRisk.length > 0 || overCapacity > 0
              ? `${number(atRisk.length)} at-risk · ${number(overCapacity)} over cap`
              : 'on track'
          }
          storageKey="dash-team"
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="bg-card rounded-lg border">
              <header className="flex items-center justify-between border-b px-4 py-3">
                <div>
                  <h2 className="text-sm font-medium">At-risk clients</h2>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Past the SLA for their current stage
                  </p>
                </div>
                {atRisk.length > 0 && (
                  <span className="text-danger inline-flex items-center gap-1 text-xs font-medium">
                    <AlertTriangle className="size-3.5" />
                    {atRisk.length}
                  </span>
                )}
              </header>

              {atRisk.length === 0 ? (
                <EmptyState
                  icon="CircleCheck"
                  title="Nothing is overdue"
                  description="Every active client is inside the SLA for its current stage."
                />
              ) : (
                <ul className="divide-y">
                  {atRisk.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/clients/${c.id}`}
                        className="hover:bg-muted/60 flex items-center gap-3 px-4 py-2.5 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {c.firstName} {c.lastName}
                          </p>
                          <p className="text-muted-foreground mt-0.5 truncate text-xs">
                            {c.owner?.name ?? 'Unassigned'} · {currency(c.estimatedValue)}
                          </p>
                        </div>
                        <StageBadge
                          stageKey={c.currentStage.key}
                          name={c.currentStage.name}
                          category={c.currentStage.category}
                        />
                        <span className="text-danger w-16 shrink-0 text-right text-xs font-medium tabular-nums">
                          +{duration(c.overBy * 60)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <BarCompare
              title="Closer workload"
              description={
                overCapacity
                  ? `${overCapacity} closer${overCapacity === 1 ? '' : 's'} over capacity`
                  : 'Active clients against each closer’s configured cap'
              }
              rows={workload.slice(0, 10).map((w) => ({
                key: w.id,
                label: w.name,
                sublabel: w.teamName ?? undefined,
                value: w.utilization,
                display: `${w.active}/${w.capacity}`,
                color: w.utilization > 100 ? 'var(--danger)' : undefined,
              }))}
              format="percent"
              valueLabel="Active / capacity"
              footnote="Bars show utilisation against each closer’s own cap, so caps of different sizes stay comparable."
            />
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Loss reasons"
          description="Why deals are lost, by recorded reason"
          summary={
            lostTotal > 0
              ? `${number(lostTotal)} lost · ${number(lossReasons.length)} reasons`
              : 'none recorded'
          }
          defaultOpen={false}
          storageKey="dash-loss"
        >
          <BarCompare
            title="Why deals are lost"
            description="Recorded loss reasons across all closed-lost clients"
            rows={lossReasons.map((r) => ({
              key: r.reason,
              label: r.reason,
              value: r.count,
              display: `${r.count} · ${percent(r.share ?? 0, 0)}`,
            }))}
            format="number"
            valueLabel="Clients"
            emptyMessage="No loss reasons recorded yet."
          />
        </CollapsibleSection>
      </div>
    </>
  )
}
