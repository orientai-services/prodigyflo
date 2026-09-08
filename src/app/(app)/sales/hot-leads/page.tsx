import Link from 'next/link'
import { ShieldCheck } from 'lucide-react'
import { getCloseOpsConfig, getHotLeads, phaseDef } from '@/lib/closeops'
import { getReviewStatusMap, type ReviewStatus } from '@/lib/qualifier'
import { SALES_LEVEL_LABEL, requireSalesAccess } from '@/lib/coaching'
import { can } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { currency, fullName, number, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { BriefChip, ProbabilityBadge, SalesNav } from '../ui'
import { ReviewStatusChip } from '../qualifier/status-chip'

export const metadata = { title: 'Hot leads' }

const FILTERS: { key: string; label: string; statuses: ReviewStatus[] | null }[] = [
  { key: 'all', label: 'All', statuses: null },
  { key: 'approved', label: 'Approved', statuses: ['approved'] },
  { key: 'needs_review', label: 'Needs review', statuses: ['needs_review', 'stale'] },
]

export default async function HotLeadsPage({ searchParams }: PageProps<'/sales/hot-leads'>) {
  const { user, level } = await requireSalesAccess()
  const canQualify = can(user, 'qualification:review')
  const params = await searchParams
  const filterKey = typeof params.filter === 'string' ? params.filter : 'all'
  const filter = FILTERS.find((f) => f.key === filterKey) ?? FILTERS[0]

  const config = await getCloseOpsConfig(user.organizationId)
  const def = phaseDef(config.phase)
  const leads = await getHotLeads(user, config)
  const reviewMap = await getReviewStatusMap(
    user,
    leads.map((l) => l.id),
  )
  const statusOf = (id: string): ReviewStatus => reviewMap.get(id)?.status ?? 'needs_review'

  const phase2 = config.phase >= 2
  const countFor = (statuses: ReviewStatus[] | null) =>
    statuses === null ? leads.length : leads.filter((l) => statuses.includes(statusOf(l.id))).length
  const shown =
    filter.statuses === null
      ? leads
      : leads.filter((l) => filter.statuses!.includes(statusOf(l.id)))

  const pipelineValue = leads.reduce((sum, l) => sum + (l.estimatedValue ?? 0), 0)
  const viewed = leads.filter((l) => l.lastBriefViewedAt !== null).length
  const unbriefed = leads.filter((l) => l.lastBriefGeneratedAt === null).length

  return (
    <>
      <PageHeader
        title="Hot leads"
        description={`The call queue for the ${SALES_LEVEL_LABEL[level]} — hottest first, staleness breaks ties`}
        actions={
          <Badge variant="outline" className="tabular-nums">
            Phase {def.phase} · threshold {config.hotLeadThreshold}%+
          </Badge>
        }
      >
        <SalesNav current="hot-leads" canQualify={canQualify} />
        <div className="mt-3 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key === 'all' ? '/sales/hot-leads' : `/sales/hot-leads?filter=${f.key}`}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                f.key === filter.key
                  ? 'bg-primary text-primary-foreground border-transparent'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {f.label}
              <span className="ml-1 tabular-nums opacity-70">{countFor(f.statuses)}</span>
            </Link>
          ))}
        </div>
      </PageHeader>

      <div className="space-y-4 p-4 sm:p-6">
        <StatGrid>
          <StatTile
            label="In the queue"
            value={number(leads.length)}
            hint={`AI probability ${config.hotLeadThreshold}%+ · live leads only`}
          />
          <StatTile
            label="Estimated value"
            value={currency(pipelineValue, { compact: true })}
            hint="Sum of estimates in the queue"
          />
          <StatTile
            label="Briefs viewed"
            value={number(viewed)}
            hint={leads.length > 0 ? `of ${number(leads.length)} hot leads` : 'No hot leads'}
          />
          <StatTile
            label="Missing a brief"
            value={number(unbriefed)}
            hint="Generate one before the call"
          />
        </StatGrid>

        <div className="bg-card shadow-e1 rounded-xl border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Call these next</h2>
              <p className="text-muted-foreground text-xs">
                The score prioritizes the queue; qualification and the close are always a human call
              </p>
            </div>
            {phase2 && (
              <Link
                href="/sales/qualifier"
                className="bg-primary/5 text-primary hover:bg-primary/10 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
              >
                <ShieldCheck className="size-3.5" />
                Phase {config.phase} works approved leads — unapproved rows are dimmed
              </Link>
            )}
          </div>
          {shown.length === 0 ? (
            <EmptyState
              icon="Flame"
              title={
                filter.key === 'all'
                  ? `No leads at ${config.hotLeadThreshold}%+ yet`
                  : `No hot leads in “${filter.label}”`
              }
              description={
                filter.key === 'all'
                  ? 'Probability-to-close scores come from the AI panel on each client record. Score your live leads there and the hottest ones queue up here automatically.'
                  : 'Qualifier decisions land here as they are recorded. Switch the filter to see the rest of the queue.'
              }
            />
          ) : (
            <div className="scroll-x">
              <table className="w-full min-w-[58rem] text-sm tabular-nums">
                <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Lead</th>
                    <th className="px-4 py-2 text-left">Probability</th>
                    <th className="px-4 py-2 text-left">Qualifier</th>
                    <th className="px-4 py-2 text-left">Stage</th>
                    <th className="px-4 py-2 text-left">Owner</th>
                    <th className="px-4 py-2 text-left">Last activity</th>
                    <th className="px-4 py-2 text-right">Est. value</th>
                    <th className="px-4 py-2 text-left">AI Brief</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((lead) => {
                    const status = statusOf(lead.id)
                    // Phase 2+: unapproved leads stay visible but recede — the
                    // qualifier's sign-off is the signal, never a hard block.
                    const dimmed = phase2 && status !== 'approved'
                    return (
                      <tr
                        key={lead.id}
                        className={cn(
                          'hover:bg-muted/40 border-b transition-colors last:border-0',
                          dimmed && 'opacity-55 hover:opacity-100',
                        )}
                      >
                        <td className="px-4 py-2.5">
                          <Link href={`/clients/${lead.id}`} className="font-medium hover:underline">
                            {fullName(lead)}
                          </Link>
                          {lead.aiCloseProbabilityAt && (
                            <span className="text-muted-foreground block text-xs">
                              scored {relativeTime(lead.aiCloseProbabilityAt)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <ProbabilityBadge value={lead.aiCloseProbability} />
                        </td>
                        <td className="px-4 py-2.5">
                          <ReviewStatusChip status={status} />
                        </td>
                        <td className="px-4 py-2.5">{lead.stageName}</td>
                        <td className="px-4 py-2.5">
                          {lead.ownerName ?? (
                            <span className="text-muted-foreground">Unassigned</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">{relativeTime(lead.lastActivityAt)}</td>
                        <td className="px-4 py-2.5 text-right font-medium">
                          {lead.estimatedValue === null ? (
                            <span className="text-muted-foreground font-normal">—</span>
                          ) : (
                            currency(lead.estimatedValue)
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <BriefChip
                            generatedAt={lead.lastBriefGeneratedAt}
                            viewedAt={lead.lastBriefViewedAt}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
