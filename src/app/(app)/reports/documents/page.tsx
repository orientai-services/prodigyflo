import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { requireUser } from '@/lib/rbac'
import { getDocumentCompletion, requireAnalyticsLevel } from '@/lib/reporting'
import { PageHeader } from '@/components/page-header'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { BarCompare } from '@/components/charts/bar-compare'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { number, percent, rate } from '@/lib/format'

export const metadata = { title: 'Document completion' }

export default async function DocumentCompletionPage() {
  const user = await requireUser()
  requireAnalyticsLevel(user)

  const rows = await getDocumentCompletion(user)
  const requested = rows.reduce((s, r) => s + r.requested, 0)
  const received = rows.reduce((s, r) => s + r.received, 0)
  const approved = rows.reduce((s, r) => s + r.approved, 0)
  const rejected = rows.reduce((s, r) => s + r.rejected, 0)

  const withVolume = rows.filter((r) => r.requested > 0)
  const slowest = [...withVolume].sort((a, b) => (a.approvedRate ?? 0) - (b.approvedRate ?? 0))

  return (
    <>
      <PageHeader
        title="Document completion"
        description="How every document requirement is performing: requested, received, and approved"
        actions={
          <Button variant="outline" size="sm" render={<Link href="/reports" />}>
            <ChevronLeft className="size-3.5" />
            All reports
          </Button>
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        <StatGrid>
          <StatTile label="Requested" value={number(requested)} hint="Documents asked of clients" />
          <StatTile
            label="Received"
            value={percent(rate(received, requested), 0)}
            hint="A file actually arrived"
            sample={`${number(received)} of ${number(requested)}`}
          />
          <StatTile
            label="Approved"
            value={percent(rate(approved, requested), 0)}
            hint="Passed review"
            sample={`${number(approved)} of ${number(requested)}`}
          />
          <StatTile
            label="Rejected"
            value={percent(rate(rejected, requested), 0)}
            hint="Sent back to the client"
            sample={`${number(rejected)} of ${number(requested)}`}
          />
        </StatGrid>

        {rows.length === 0 ? (
          <EmptyState
            icon="FileCheck2"
            title="No document requirements configured"
            description="Once document packages exist and requests go out, completion rates appear here."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <CollapsibleSection
              variant="card"
              className="self-start"
              storageKey="report-docs-requirements"
              title="Every requirement"
              description="Requested, received, and approved for each document"
              summary={`${number(rows.length)} requirements`}
            >
              <div className="scroll-x">
                <table className="w-full min-w-[44rem] text-sm tabular-nums">
                <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Requirement</th>
                    <th className="px-4 py-2 text-right">Requested</th>
                    <th className="px-4 py-2 text-right">Received</th>
                    <th className="px-4 py-2 text-right">Approved</th>
                    <th className="px-4 py-2 text-right">Received rate</th>
                    <th className="px-4 py-2 text-right">Approved rate</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.requirementId} className="hover:bg-muted/40 border-b transition-colors last:border-0">
                      <td className="px-4 py-2.5">
                        <span className="font-medium">{r.name}</span>
                        <span className="text-muted-foreground block text-xs">
                          {r.packageName}
                          {r.isRequired && ' · required'}
                        </span>
                        {r.isAttorneyRequired && (
                          <Badge variant="outline" className="mt-1">
                            Attorney package
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">{number(r.requested)}</td>
                      <td className="px-4 py-2.5 text-right">{number(r.received)}</td>
                      <td className="px-4 py-2.5 text-right">{number(r.approved)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {r.receivedRate === null ? '—' : percent(r.receivedRate, 0)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium">
                        {r.approvedRate === null ? '—' : percent(r.approvedRate, 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                </table>
              </div>
            </CollapsibleSection>

            <BarCompare
              title="Hardest documents to finish"
              description="Lowest approval rate first — the paperwork that stalls deals"
              format="percent"
              valueLabel="Approved rate"
              rows={slowest.slice(0, 8).map((r) => ({
                key: r.requirementId,
                label: r.name,
                sublabel: `${number(r.approved)} of ${number(r.requested)}`,
                value: r.approvedRate ?? 0,
              }))}
              emptyMessage="No documents have been requested yet."
            />
          </div>
        )}
      </div>
    </>
  )
}
