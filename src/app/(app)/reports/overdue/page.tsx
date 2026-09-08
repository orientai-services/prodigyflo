import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { requireUser } from '@/lib/rbac'
import { getOverdueTasks, getSlaExpiredClients, requireAnalyticsLevel } from '@/lib/reporting'
import { PageHeader } from '@/components/page-header'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { currency, duration, fullName, humanize, number, relativeTime, shortDate } from '@/lib/format'

export const metadata = { title: 'Overdue follow-ups' }

export default async function OverdueReportPage() {
  const user = await requireUser()
  requireAnalyticsLevel(user)

  const [tasks, slaExpired] = await Promise.all([
    getOverdueTasks(user),
    getSlaExpiredClients(user),
  ])

  const worstTask = tasks[0]
  const worstClient = slaExpired[0]

  return (
    <>
      <PageHeader
        title="Overdue follow-ups"
        description="What is slipping: tasks past their due date, and clients past their stage SLA with no activity since"
        actions={
          <Button variant="outline" size="sm" render={<Link href="/reports" />}>
            <ChevronLeft className="size-3.5" />
            All reports
          </Button>
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        <StatGrid>
          <StatTile label="Overdue tasks" value={number(tasks.length)} hint="Open, past due date" />
          <StatTile
            label="Stalled clients"
            value={number(slaExpired.length)}
            hint="SLA expired, no activity since"
          />
          <StatTile
            label="Longest overdue task"
            value={worstTask ? duration(worstTask.overdueHours * 60) : '—'}
            hint={worstTask ? worstTask.title : 'Nothing overdue'}
          />
          <StatTile
            label="Longest stalled client"
            value={worstClient ? duration(worstClient.overdueHours * 60) : '—'}
            hint={worstClient ? `${worstClient.firstName} ${worstClient.lastName} · ${worstClient.stageName}` : 'Nobody stalled'}
          />
        </StatGrid>

        <CollapsibleSection
          title="Tasks past due"
          summary={tasks.length === 0 ? 'all clear' : `${number(tasks.length)} overdue`}
          storageKey="report-overdue-tasks"
        >
          {tasks.length === 0 ? (
            <EmptyState
              icon="CircleCheckBig"
              title="No overdue tasks"
              description="Every open task is still inside its due date. Nice."
              className="rounded-lg border py-10"
            />
          ) : (
            <div className="scroll-x rounded-lg border">
              <table className="w-full min-w-[48rem] text-sm tabular-nums">
                <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Task</th>
                    <th className="px-4 py-2 text-left">Client</th>
                    <th className="px-4 py-2 text-left">Assignee</th>
                    <th className="px-4 py-2 text-left">Priority</th>
                    <th className="px-4 py-2 text-right">Due</th>
                    <th className="px-4 py-2 text-right">Overdue by</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.id} className="hover:bg-muted/40 border-b transition-colors last:border-0">
                      <td className="px-4 py-2.5 font-medium">{t.title}</td>
                      <td className="px-4 py-2.5">
                        {t.client ? (
                          <Link href={`/clients/${t.client.id}`} className="hover:underline">
                            {fullName(t.client)}
                            <span className="text-muted-foreground block text-xs">{t.client.stageName}</span>
                          </Link>
                        ) : (
                          <span className="text-muted-foreground italic">No client</span>
                        )}
                      </td>
                      <td className="text-muted-foreground px-4 py-2.5">
                        {t.assigneeName ?? <span className="italic">Unassigned</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant={t.priority === 'URGENT' || t.priority === 'HIGH' ? 'destructive' : 'secondary'}>
                          {humanize(t.priority)}
                        </Badge>
                      </td>
                      <td className="text-muted-foreground px-4 py-2.5 text-right text-xs whitespace-nowrap">
                        {shortDate(t.dueAt)}
                      </td>
                      <td className="text-danger px-4 py-2.5 text-right font-medium whitespace-nowrap">
                        {duration(t.overdueHours * 60)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title="Clients past SLA with no activity"
          summary={slaExpired.length === 0 ? 'all clear' : `${number(slaExpired.length)} stalled`}
          storageKey="report-overdue-sla"
        >
          {slaExpired.length === 0 ? (
            <EmptyState
              icon="ShieldCheck"
              title="No stalled clients"
              description="Everyone past an SLA has at least been touched since the deadline."
              className="rounded-lg border py-10"
            />
          ) : (
            <div className="scroll-x rounded-lg border">
              <table className="w-full min-w-[48rem] text-sm tabular-nums">
                <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Client</th>
                    <th className="px-4 py-2 text-left">Stage</th>
                    <th className="px-4 py-2 text-left">Owner</th>
                    <th className="px-4 py-2 text-right">Value</th>
                    <th className="px-4 py-2 text-right">Last activity</th>
                    <th className="px-4 py-2 text-right">Past SLA by</th>
                  </tr>
                </thead>
                <tbody>
                  {slaExpired.map((c) => (
                    <tr key={c.id} className="hover:bg-muted/40 border-b transition-colors last:border-0">
                      <td className="px-4 py-2.5">
                        <Link href={`/clients/${c.id}`} className="font-medium hover:underline">
                          {fullName(c)}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="text-sm">{c.stageName}</span>
                        <span className="text-muted-foreground block text-xs">{c.slaHours}h SLA</span>
                      </td>
                      <td className="text-muted-foreground px-4 py-2.5">
                        {c.ownerName ?? <span className="italic">Unassigned</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">{currency(c.estimatedValue)}</td>
                      <td className="text-muted-foreground px-4 py-2.5 text-right text-xs whitespace-nowrap">
                        {relativeTime(c.lastActivityAt)}
                      </td>
                      <td className="text-danger px-4 py-2.5 text-right font-medium whitespace-nowrap">
                        {duration(c.overdueHours * 60)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CollapsibleSection>
      </div>
    </>
  )
}
