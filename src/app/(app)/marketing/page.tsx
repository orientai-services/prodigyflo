import Link from 'next/link'
import { ArrowRight, ChartSpline, Download, Megaphone, Radar } from 'lucide-react'
import { requirePermissionPage } from '@/lib/rbac'
import {
  MARKETING_RANGES,
  getIntakeFunnel,
  getMarketingOverview,
  marketingRange,
} from '@/lib/marketing-metrics'
import { PageHeader } from '@/components/page-header'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { EmptyState } from '@/components/empty-state'
import { TrendChart } from '@/components/charts/trend-chart'
import { BarCompare } from '@/components/charts/bar-compare'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { currency, humanize, number, percent } from '@/lib/format'
import { MarketingTabs } from './marketing-tabs'

export const metadata = { title: 'Marketing' }

const INTAKE_STATUS_META: Record<string, { label: string; color: string; hint: string }> = {
  RECEIVED: { label: 'Received', color: 'var(--chart-1)', hint: 'arrived, awaiting processing' },
  APPLIED: { label: 'Applied', color: 'var(--success)', hint: 'became or updated a lead' },
  DUPLICATE: { label: 'Duplicate', color: 'var(--chart-3)', hint: 'matched an existing person' },
  NEEDS_MAPPING: { label: 'Needs mapping', color: 'var(--warning)', hint: 'fields unmapped — fix in Settings' },
  FAILED: { label: 'Failed', color: 'var(--danger)', hint: 'errored — needs attention' },
}

const QUICK_LINKS = [
  {
    href: '/marketing/sources',
    icon: Radar,
    title: 'Lead sources',
    description: 'Volume, qualified rate, and close rate for every source and campaign.',
  },
  {
    href: '/marketing/analytics',
    icon: ChartSpline,
    title: 'Attribution & forecast',
    description: 'First/last-touch revenue attribution, forecast, and customer journey.',
  },
  {
    href: '/marketing/meta',
    icon: Megaphone,
    title: 'Meta Ads',
    description: 'Campaign sync, spend pacing, and lead-ad delivery from Meta.',
  },
] as const

export default async function MarketingOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePermissionPage('analytics:marketing')
  const params = await searchParams
  const range = marketingRange(typeof params.range === 'string' ? params.range : undefined)

  const [overview, intake] = await Promise.all([
    getMarketingOverview(user, range),
    getIntakeFunnel(user, range.from),
  ])
  const { totals, weekly, sources, campaigns, ads } = overview

  const activeSources = sources.filter((s) => s.leads > 0)
  const attributed = totals.leads - totals.unattributed
  const maxStatus = Math.max(1, ...intake.byStatus.map((s) => s.count))
  const hasAnything = totals.leads > 0 || campaigns.length > 0 || intake.total > 0

  return (
    <>
      <PageHeader
        title="Marketing"
        description={`Lead generation across sources, campaigns, ad spend, and intake · ${range.label.toLowerCase()}`}
        actions={
          <>
            <Button variant="outline" size="sm" render={<a href={`/exports/marketing-campaigns?range=${range.key}`} />}>
              <Download className="size-3.5" />
              Export CSV
            </Button>
            <div className="bg-surface-sunk flex items-center gap-0.5 rounded-lg border p-0.5">
              {MARKETING_RANGES.map((r) => (
                <Link
                  key={r.key}
                  href={`/marketing?range=${r.key}`}
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
        <MarketingTabs active="overview" />
      </PageHeader>

      <div className="space-y-6 p-4 sm:p-6">
        {/* ── Headline metrics ─────────────────────────────────────────── */}
        <StatGrid>
          <StatTile
            label="New leads"
            value={number(totals.leads)}
            hint={`${number(attributed)} attributed to a source`}
            trend={
              totals.leadsDeltaPct !== null
                ? {
                    delta: totals.leadsDeltaPct,
                    label: `vs ${number(totals.prevLeads)} in the prior ${range.days} days`,
                  }
                : undefined
            }
          />
          <StatTile
            label="Reached qualified"
            value={number(totals.qualified)}
            hint={totals.qualifiedRate === null ? 'no leads in range' : `${percent(totals.qualifiedRate, 1)} of new leads`}
            sample={totals.leads ? `n=${number(totals.leads)}` : undefined}
          />
          <StatTile
            label="Closed won"
            value={number(totals.won)}
            hint={totals.wonRate === null ? 'no leads in range' : `${percent(totals.wonRate, 1)} of new leads`}
            sample={totals.leads ? `n=${number(totals.leads)}` : undefined}
          />
          <StatTile
            label="Ad spend"
            value={currency(ads.spend)}
            hint={
              ads.spend
                ? `${number(ads.impressions, { compact: true })} impressions · ${number(ads.clicks, { compact: true })} clicks`
                : 'no tracked spend in range'
            }
          />
        </StatGrid>
        <StatGrid>
          <StatTile
            label="Cost per lead"
            value={ads.costPerLead === null ? '—' : currency(ads.costPerLead, { cents: true })}
            hint="spend ÷ leads from paid campaigns"
            sample={ads.campaignLeads ? `n=${number(ads.campaignLeads)}` : undefined}
          />
          <StatTile
            label="Cost per qualified lead"
            value={ads.costPerQualified === null ? '—' : currency(ads.costPerQualified, { cents: true })}
            hint="spend ÷ qualified from paid campaigns"
            sample={ads.campaignQualified ? `n=${number(ads.campaignQualified)}` : undefined}
          />
          <StatTile
            label="Click-through rate"
            value={ads.ctr === null ? '—' : percent(ads.ctr, 1)}
            hint={ads.cpc === null ? 'no ad delivery in range' : `${currency(ads.cpc, { cents: true })} per click`}
          />
          <StatTile
            label="Intake submissions"
            value={number(intake.total)}
            hint={
              intake.total
                ? `${number(intake.byStatus.find((s) => s.status === 'APPLIED')?.count ?? 0)} applied to the CRM`
                : 'no inbound payloads in range'
            }
          />
        </StatGrid>

        {!hasAnything ? (
          <EmptyState
            icon="Megaphone"
            title="No marketing activity in this window"
            description="New leads, campaign spend, and intake submissions appear here as they arrive. Try a longer range, or connect an intake source."
          />
        ) : (
          <>
            {/* ── Lead trend + sources ─────────────────────────────────── */}
            <div className="grid gap-4 lg:grid-cols-2">
              <TrendChart
                title="New leads by week"
                description={`Clients created per week · ${range.label.toLowerCase()}`}
                data={weekly.map((w) => ({ label: w.label, leads: w.count }))}
                series={[{ key: 'leads', label: 'New leads', format: 'number' }]}
                footnote="Each point is the 7 days ending on the labeled date; the oldest bucket can be a partial week."
              />
              <BarCompare
                title="Leads by source"
                description="Where this window's leads were attributed"
                format="number"
                valueLabel="Leads"
                rows={[
                  ...activeSources.map((s) => ({
                    key: s.id,
                    label: s.name,
                    sublabel: humanize(s.channel),
                    value: s.leads,
                  })),
                  ...(totals.unattributed > 0
                    ? [
                        {
                          key: '__none__',
                          label: 'No source recorded',
                          sublabel: 'attribution gap',
                          value: totals.unattributed,
                          color: 'var(--muted-foreground)',
                          muted: true,
                        },
                      ]
                    : []),
                ]}
                emptyMessage="No leads in this window yet."
                footnote={
                  totals.unattributed > 0
                    ? `${number(totals.unattributed)} of ${number(totals.leads)} leads carry no source — intake mapping closes this gap.`
                    : undefined
                }
              />
            </div>

            {/* ── Campaign spend table ─────────────────────────────────── */}
            <section>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">Campaign spend & delivery</h2>
                  <p className="text-muted-foreground text-xs">
                    In-range ad numbers next to what actually landed in the CRM
                  </p>
                </div>
                <Link href="/marketing/sources" className="text-muted-foreground hover:text-foreground text-xs font-medium">
                  Full source breakdown <ArrowRight className="inline size-3" />
                </Link>
              </div>
              {campaigns.length === 0 ? (
                <div className="rounded-lg border">
                  <EmptyState
                    icon="Megaphone"
                    title="No campaign activity in range"
                    description="Campaigns appear once they record spend, delivery, or attributed leads. Meta Ads sync writes these automatically."
                    className="py-10"
                  />
                </div>
              ) : (
                <div className="scroll-x rounded-lg border">
                  <table className="w-full min-w-[64rem] text-sm tabular-nums">
                    <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                      <tr>
                        <th className="px-3 py-2 text-left">Campaign</th>
                        <th className="px-3 py-2 text-right">Spend</th>
                        <th className="px-3 py-2 text-right">Impressions</th>
                        <th className="px-3 py-2 text-right">Clicks</th>
                        <th className="px-3 py-2 text-right">Ad leads</th>
                        <th className="px-3 py-2 text-right">CRM leads</th>
                        <th className="px-3 py-2 text-right">Qualified</th>
                        <th className="px-3 py-2 text-right">Won</th>
                        <th className="px-3 py-2 text-right">CPL</th>
                        <th className="px-3 py-2 text-right">Cost / qualified</th>
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
                          <td className="px-3 py-2.5 text-right">{number(c.impressions)}</td>
                          <td className="px-3 py-2.5 text-right">{number(c.clicks)}</td>
                          <td className="px-3 py-2.5 text-right">{number(c.adLeads)}</td>
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
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-muted-foreground mt-2 text-xs">
                “Ad leads” is what the platform reported; “CRM leads” is clients actually created here and
                attributed to the campaign. CPL and cost per qualified divide in-range spend by CRM figures.
              </p>
            </section>

            {/* ── Intake funnel ────────────────────────────────────────── */}
            <section>
              <div className="mb-3">
                <h2 className="text-sm font-semibold">Intake submissions</h2>
                <p className="text-muted-foreground text-xs">
                  Every inbound payload — forms, sheets, imports, Meta lead ads — and what happened to it
                </p>
              </div>
              {intake.total === 0 ? (
                <div className="rounded-lg border">
                  <EmptyState
                    icon="Inbox"
                    title="No intake submissions in range"
                    description="Connect a web form, Google Sheet, or Meta Lead Ads in Settings → Intake to start receiving leads automatically."
                    className="py-10"
                  />
                </div>
              ) : (
                <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
                  <div className="bg-card rounded-lg border p-4">
                    <ul className="space-y-3">
                      {intake.byStatus.map((s) => {
                        const meta = INTAKE_STATUS_META[s.status]
                        return (
                          <li key={s.status}>
                            <div className="flex items-baseline justify-between gap-3 text-xs">
                              <span>
                                <span className="font-medium">{meta.label}</span>
                                <span className="text-muted-foreground ml-1.5">{meta.hint}</span>
                              </span>
                              <span className="shrink-0 font-medium tabular-nums">{number(s.count)}</span>
                            </div>
                            <div className="bg-muted mt-1 h-2 overflow-hidden rounded-[4px]">
                              <div
                                className="h-full rounded-[4px]"
                                style={{
                                  width: `${Math.max((s.count / maxStatus) * 100, s.count === 0 ? 0 : 1)}%`,
                                  background: meta.color,
                                }}
                              />
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>

                  <div className="scroll-x self-start rounded-lg border">
                    <table className="w-full min-w-[36rem] text-sm tabular-nums">
                      <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                        <tr>
                          <th className="px-3 py-2 text-left">Intake source</th>
                          <th className="px-3 py-2 text-right">Submissions</th>
                          <th className="px-3 py-2 text-right">Applied</th>
                          <th className="px-3 py-2 text-right">New clients</th>
                          <th className="px-3 py-2 text-right">Duplicates</th>
                          <th className="px-3 py-2 text-right">Issues</th>
                        </tr>
                      </thead>
                      <tbody>
                        {intake.bySource.filter((s) => s.total > 0).map((s) => {
                          const issues = s.failed + s.needsMapping
                          return (
                            <tr key={s.id} className="hover:bg-muted/40 border-b transition-colors last:border-0">
                              <td className="px-3 py-2.5">
                                <span className="font-medium">{s.name}</span>
                                <span className="text-muted-foreground ml-2 text-xs">{humanize(s.kind)}</span>
                                {!s.isEnabled && (
                                  <Badge variant="outline" className="text-muted-foreground ml-2 text-[0.625rem]">
                                    disabled
                                  </Badge>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right">{number(s.total)}</td>
                              <td className="px-3 py-2.5 text-right">
                                {number(s.applied)}
                                <span className="text-muted-foreground ml-1 text-xs">
                                  ({s.appliedRate === null ? '—' : percent(s.appliedRate, 0)})
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-right">{number(s.createdClients)}</td>
                              <td className="px-3 py-2.5 text-right">{number(s.duplicates)}</td>
                              <td className={cn('px-3 py-2.5 text-right', issues > 0 && 'text-danger font-medium')}>
                                {number(issues)}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          </>
        )}

        {/* ── Quick links ──────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-sm font-semibold">Go deeper</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {QUICK_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="group bg-card hover:bg-muted/40 rounded-lg border p-4 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <link.icon className="text-muted-foreground size-4" />
                  <ArrowRight className="text-muted-foreground size-3.5 transition-transform group-hover:translate-x-0.5" />
                </div>
                <p className="mt-2.5 text-sm font-medium">{link.title}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">{link.description}</p>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </>
  )
}
