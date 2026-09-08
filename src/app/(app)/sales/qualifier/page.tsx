import Link from 'next/link'
import { getCloseOpsConfig, phaseDef } from '@/lib/closeops'
import { getQualifierDayCounts, getQualifierQueue } from '@/lib/qualifier'
import { requirePermissionPage } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { fullName, number, relativeTime, shortDate } from '@/lib/format'
import { BriefChip, ProbabilityBadge, SalesNav } from '../ui'
import { ReviewActions } from './review-actions'
import { ReviewStatusChip } from './status-chip'

export const metadata = { title: 'Qualifier queue' }

export default async function QualifierPage() {
  const user = await requirePermissionPage('qualification:review')

  const config = await getCloseOpsConfig(user.organizationId)
  const def = phaseDef(config.phase)
  const [queue, today] = await Promise.all([
    getQualifierQueue(user, config),
    getQualifierDayCounts(user),
  ])

  const staleCount = queue.filter((l) => l.review.status === 'stale').length
  const neverReviewed = queue.length - staleCount

  return (
    <>
      <PageHeader
        title="Qualifier queue"
        description="Every hot lead gets a human qualification review before closers work it — the AI score informs, you decide"
        actions={
          <Badge variant="outline" className="tabular-nums">
            Phase {def.phase} · threshold {config.hotLeadThreshold}%+
          </Badge>
        }
      >
        {/* requirePermissionPage above guarantees the viewer holds qualification:review. */}
        <SalesNav current="qualifier" canQualify />
      </PageHeader>

      <div className="space-y-4 p-4 sm:p-6">
        <StatGrid>
          <StatTile
            label="Waiting on review"
            value={number(queue.length)}
            hint={
              queue.length > 0
                ? `${number(neverReviewed)} never reviewed · ${number(staleCount)} stale`
                : 'The hot list is fully covered'
            }
          />
          <StatTile
            label="Approved today"
            value={number(today.approvedToday)}
            hint="Cleared for closer work"
          />
          <StatTile
            label="Rejected today"
            value={number(today.rejectedToday)}
            hint="Held back with a reason"
          />
          <StatTile
            label="Stale approvals"
            value={number(staleCount)}
            hint={`Score moved >10 pts or was rescored since sign-off`}
          />
        </StatGrid>

        <div className="bg-card shadow-e1 rounded-xl border">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Review these leads</h2>
            <p className="text-muted-foreground text-xs">
              Hottest first. Open the lead for the full record and AI brief, then approve or reject —
              your decision is recorded, with the probability it was made at.
            </p>
          </div>
          {queue.length === 0 ? (
            <EmptyState
              icon="ShieldCheck"
              title="Queue is clear"
              description={`Every lead at ${config.hotLeadThreshold}%+ carries a fresh human decision. New hot leads and rescored approvals land back here automatically.`}
            />
          ) : (
            <div className="scroll-x">
              <table className="w-full min-w-[62rem] text-sm tabular-nums">
                <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Lead</th>
                    <th className="px-4 py-2 text-left">Probability</th>
                    <th className="px-4 py-2 text-left">Status</th>
                    <th className="px-4 py-2 text-left">Stage</th>
                    <th className="px-4 py-2 text-left">Owner</th>
                    <th className="px-4 py-2 text-left">Last activity</th>
                    <th className="px-4 py-2 text-left">AI Brief</th>
                    <th className="px-4 py-2 text-right">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((lead) => (
                    <tr
                      key={lead.id}
                      className="hover:bg-muted/40 border-b transition-colors last:border-0"
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
                        <ReviewStatusChip status={lead.review.status} />
                        {lead.review.status === 'stale' && lead.review.reviewedAt && (
                          <span className="text-muted-foreground block pt-1 text-xs">
                            approved
                            {lead.review.probabilityAtReview !== null
                              ? ` at ${lead.review.probabilityAtReview}%`
                              : ''}
                            {lead.review.reviewerName ? ` by ${lead.review.reviewerName}` : ''} ·{' '}
                            {shortDate(lead.review.reviewedAt)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">{lead.stageName}</td>
                      <td className="px-4 py-2.5">
                        {lead.ownerName ?? <span className="text-muted-foreground">Unassigned</span>}
                      </td>
                      <td className="px-4 py-2.5">{relativeTime(lead.lastActivityAt)}</td>
                      <td className="px-4 py-2.5">
                        <BriefChip
                          generatedAt={lead.lastBriefGeneratedAt}
                          viewedAt={lead.lastBriefViewedAt}
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <ReviewActions
                          clientId={lead.id}
                          leadName={fullName(lead)}
                          probability={lead.aiCloseProbability}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
