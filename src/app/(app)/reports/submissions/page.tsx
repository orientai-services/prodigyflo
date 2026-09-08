import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { requireUser } from '@/lib/rbac'
import {
  getSubmissionStatusBreakdown,
  getSubmissionTrend,
  requireAnalyticsLevel,
} from '@/lib/reporting'
import { PageHeader } from '@/components/page-header'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { TrendChart } from '@/components/charts/trend-chart'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { humanize, number, percent, rate } from '@/lib/format'

export const metadata = { title: 'CYS submissions' }

export default async function SubmissionsReportPage() {
  const user = await requireUser()
  requireAnalyticsLevel(user)

  const [trend, breakdown] = await Promise.all([
    getSubmissionTrend(user, 12),
    getSubmissionStatusBreakdown(user),
  ])

  const total = breakdown.reduce((s, r) => s + r.count, 0)
  const get = (status: string) => breakdown.find((b) => b.status === status)?.count ?? 0
  const approved = get('APPROVED')
  const rejected = get('REJECTED')
  const corrections = get('CORRECTIONS_REQUESTED')
  const inFlight = get('SUBMITTED') + get('ACKNOWLEDGED') + get('RESUBMITTED')
  const decided = approved + rejected

  return (
    <>
      <PageHeader
        title="CYS submissions"
        description="Submission volume over the last 12 weeks, plus where every package stands today"
        actions={
          <Button variant="outline" size="sm" render={<Link href="/reports" />}>
            <ChevronLeft className="size-3.5" />
            All reports
          </Button>
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        <StatGrid>
          <StatTile label="Total submissions" value={number(total)} hint="All time, in your scope" />
          <StatTile
            label="In flight"
            value={number(inFlight)}
            hint="Submitted, acknowledged, or resubmitted"
          />
          <StatTile
            label="Approval rate"
            value={decided === 0 ? '—' : percent(rate(approved, decided), 0)}
            hint="Approved ÷ decided"
            sample={`n=${number(decided)}`}
          />
          <StatTile
            label="Awaiting corrections"
            value={number(corrections)}
            hint="Sent back for fixes"
          />
        </StatGrid>

        {total === 0 ? (
          <EmptyState
            icon="Send"
            title="No submissions yet"
            description="When deals start going out to CYS, weekly volume and outcomes appear here."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <TrendChart
              title="Weekly submission activity"
              description="Created, sent, and approved per week — the gap between lines is your backlog"
              data={trend}
              series={[
                { key: 'created', label: 'Created', format: 'number' },
                { key: 'submitted', label: 'Submitted', format: 'number' },
                { key: 'approved', label: 'Approved', format: 'number' },
              ]}
              footnote="A submission counts in the week each event happened, so one package can appear in several weeks."
            />

            <CollapsibleSection
              variant="card"
              className="self-start"
              storageKey="report-submissions-status"
              title="Where packages sit now"
              description="Every submission by current status"
              summary={`${number(total)} total`}
            >
              <table className="w-full text-sm tabular-nums">
                <tbody>
                  {breakdown.map((row) => (
                    <tr key={row.status} className="border-b last:border-0">
                      <td className="px-4 py-2 text-sm">{humanize(row.status)}</td>
                      <td className="px-4 py-2 text-right font-medium">{number(row.count)}</td>
                      <td className="text-muted-foreground w-16 px-4 py-2 text-right text-xs">
                        {total ? percent(rate(row.count, total), 0) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CollapsibleSection>
          </div>
        )}
      </div>
    </>
  )
}
