import Link from 'next/link'
import { ArrowRight, CheckCircle2, Flame, Settings2, ShieldCheck } from 'lucide-react'
import { can } from '@/lib/rbac'
import {
  evaluatePhase,
  getCloseOpsConfig,
  getCloseOpsMetrics,
  getHotLeads,
  phaseDef,
} from '@/lib/closeops'
import { getQualifierCoverage } from '@/lib/qualifier'
import { SALES_LEVEL_LABEL, requireSalesAccess } from '@/lib/coaching'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { fullName, number } from '@/lib/format'
import { PhaseMetricCard, ProbabilityBadge, SalesNav } from './ui'

export const metadata = { title: 'Sales command' }

export default async function SalesOverviewPage() {
  const { user, level } = await requireSalesAccess()

  const canQualify = can(user, 'qualification:review')

  const config = await getCloseOpsConfig(user.organizationId)
  const def = phaseDef(config.phase)
  const [metrics, hotPreview, coverage] = await Promise.all([
    getCloseOpsMetrics(user, config),
    getHotLeads(user, config, 5),
    canQualify ? getQualifierCoverage(user, config) : Promise.resolve(null),
  ])
  const checks = evaluatePhase(def, metrics)
  const met = checks.filter((c) => c.met === true).length
  const judged = checks.filter((c) => c.met !== null).length

  const samples: (string | undefined)[] = [
    `n=${number(metrics.qualifiedWon + metrics.qualifiedLost)} decided`,
    `${number(metrics.qualifiedWon)} won in window`,
    'this calendar month',
    `${number(metrics.leakingCount)} of ${number(metrics.liveCount)} live`,
    `${number(metrics.callsWithBrief)}/${number(metrics.callsTotal)} calls`,
  ]

  return (
    <>
      <PageHeader
        title="Sales command"
        description={`The close-rate operating cockpit for the ${SALES_LEVEL_LABEL[level]} · last 90 days`}
      >
        <SalesNav current="overview" canQualify={canQualify} />
      </PageHeader>

      <div className="space-y-4 p-4 sm:p-6">
        {/* Phase banner */}
        <div className="bg-card shadow-e1 rounded-xl border p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge>Phase {def.phase}</Badge>
                <h2 className="truncate text-base font-semibold">{def.name}</h2>
              </div>
              <p className="text-muted-foreground mt-1.5 max-w-3xl text-sm">{def.objective}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-muted-foreground text-xs tabular-nums">
                {number(met)}/{number(judged)} targets on track
              </span>
              <Button variant="outline" size="sm" render={<Link href="/sales/ops" />}>
                {can(user, 'org:manage') ? (
                  <>
                    <Settings2 data-slot="icon" /> Operations
                  </>
                ) : (
                  <>
                    Operations <ArrowRight data-slot="icon" />
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* The five phase metrics */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
          {checks.map((check, i) => (
            <PhaseMetricCard key={check.label} check={check} sample={samples[i]} />
          ))}
        </div>

        {/* Qualifier coverage — the Phase 2 human sign-off over the hot list.
            Reviewers only: the queue behind the button requires qualification:review. */}
        {canQualify && coverage && (
          <div className="bg-card shadow-e1 rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-lg">
                  <ShieldCheck className="text-primary size-4.5" />
                </div>
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs font-medium">Qualifier coverage</p>
                  <p className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums">
                    {coverage.approvedPct === null ? (
                      <span className="text-muted-foreground text-lg font-medium">
                        no hot leads
                      </span>
                    ) : (
                      `${coverage.approvedPct}%`
                    )}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">
                    {coverage.approvedPct === null
                      ? 'Coverage appears once leads cross the hot-lead threshold'
                      : `${number(coverage.approved)} of ${number(coverage.total)} hot leads carry a fresh human approval` +
                        ` · ${number(coverage.needsReview)} never reviewed` +
                        (coverage.stale > 0 ? ` · ${number(coverage.stale)} stale` : '') +
                        (coverage.rejected > 0 ? ` · ${number(coverage.rejected)} rejected` : '')}
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" render={<Link href="/sales/qualifier" />}>
                {coverage.needsReview + coverage.stale > 0 ? (
                  <>
                    Review {number(coverage.needsReview + coverage.stale)} waiting{' '}
                    <ArrowRight data-slot="icon" />
                  </>
                ) : (
                  <>
                    Qualifier queue <ArrowRight data-slot="icon" />
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
          {/* Hot leads */}
          <div className="bg-card shadow-e1 rounded-xl border">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Flame className="text-warning size-4" /> Hot leads at {config.hotLeadThreshold}%+
                </h2>
                <p className="text-muted-foreground text-xs">
                  AI probability orders the queue — a human still makes every call decision
                </p>
              </div>
              <Button variant="outline" size="sm" render={<Link href="/sales/hot-leads" />}>
                {number(metrics.hotLeadCount)} in queue <ArrowRight data-slot="icon" />
              </Button>
            </div>
            {hotPreview.length === 0 ? (
              <p className="text-muted-foreground px-4 py-8 text-center text-sm">
                No leads at or above {config.hotLeadThreshold}% right now. Scores come from the AI
                panel on each client record.
              </p>
            ) : (
              <ul className="divide-y">
                {hotPreview.map((lead) => (
                  <li key={lead.id}>
                    <Link
                      href={`/clients/${lead.id}`}
                      className="hover:bg-muted/40 flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition-colors"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{fullName(lead)}</span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {lead.stageName}
                          {lead.ownerName ? ` · ${lead.ownerName}` : ''}
                        </span>
                      </span>
                      <ProbabilityBadge value={lead.aiCloseProbability} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Today's focus */}
          <div className="bg-card shadow-e1 self-start rounded-xl border">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Today&rsquo;s focus</h2>
              <p className="text-muted-foreground text-xs">
                The Phase {def.phase} operating rhythm — what good looks like every day
              </p>
            </div>
            <ul className="space-y-2.5 px-4 py-3.5">
              {def.focusAreas.map((area) => (
                <li key={area} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" />
                  <span>{area}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </>
  )
}
