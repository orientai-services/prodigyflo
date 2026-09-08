import Link from 'next/link'
import { NURTURE_KIND_LABEL, getNurtureQueue } from '@/lib/nurture'
import { SALES_LEVEL_LABEL, requireSalesAccess } from '@/lib/coaching'
import { can } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { NurtureStatusChip } from '@/components/client/nurture-panel'
import { dateTime, fullName, number, relativeTime } from '@/lib/format'
import { ProbabilityBadge, SalesNav } from '../ui'
import { ConfirmTouchButton, LogNurtureDialog } from './nurture-controls'

export const metadata = { title: 'Pre-call nurture' }

export default async function NurturePage() {
  const { user, level } = await requireSalesAccess()
  const canQualify = can(user, 'qualification:review')
  const { rows, hotLeadThreshold, confirmedThisWeek } = await getNurtureQueue(user)

  const needsNurture = rows.filter((r) => r.status === 'none').length
  const awaitingConfirm = rows.filter((r) => r.status === 'sent').length
  const withAppointment = rows.filter((r) => r.appointmentAt !== null).length

  return (
    <>
      <PageHeader
        title="Pre-call nurture"
        description={`Every booked call and hot lead in the ${SALES_LEVEL_LABEL[level]} gets a personal touch before the closer dials`}
        actions={
          <Badge variant="outline" className="tabular-nums">
            Hot at {hotLeadThreshold}%+ · calls within 7 days
          </Badge>
        }
      >
        <SalesNav current="nurture" canQualify={canQualify} />
      </PageHeader>

      <div className="space-y-4 p-4 sm:p-6">
        <StatGrid>
          <StatTile
            label="Needs nurture"
            value={number(needsNurture)}
            hint="No touch logged yet — send the video first"
          />
          <StatTile
            label="Sent, awaiting confirm"
            value={number(awaitingConfirm)}
            hint="Confirm once the client has seen it"
          />
          <StatTile
            label="Confirmed this week"
            value={number(confirmedThisWeek)}
            hint="Touches confirmed in the past 7 days"
          />
          <StatTile
            label="Calls booked"
            value={number(withAppointment)}
            hint={
              withAppointment > 0
                ? `of ${number(rows.length)} in the queue, next 7 days`
                : 'No unnurtured calls in the next 7 days'
            }
          />
        </StatGrid>

        <div className="bg-card shadow-e1 rounded-xl border">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Nurture before you dial</h2>
            <p className="text-muted-foreground text-xs">
              Soonest call first, then the hottest unbooked leads — a lead leaves this queue only
              when its nurture is confirmed
            </p>
          </div>
          {rows.length === 0 ? (
            <EmptyState
              icon="HeartHandshake"
              title="Every upcoming call is nurtured"
              description={`Nothing in the ${SALES_LEVEL_LABEL[level]} needs a pre-call touch right now. New bookings and leads crossing ${hotLeadThreshold}% show up here automatically.`}
            />
          ) : (
            <div className="scroll-x">
              <table className="w-full min-w-[56rem] text-sm tabular-nums">
                <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Lead</th>
                    <th className="px-4 py-2 text-left">Appointment</th>
                    <th className="px-4 py-2 text-left">Probability</th>
                    <th className="px-4 py-2 text-left">Owner</th>
                    <th className="px-4 py-2 text-left">Nurture</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.clientId}
                      className="hover:bg-muted/40 border-b transition-colors last:border-0"
                    >
                      <td className="px-4 py-2.5">
                        <Link href={`/clients/${row.clientId}`} className="font-medium hover:underline">
                          {fullName(row)}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">
                        {row.appointmentAt ? (
                          <>
                            {dateTime(row.appointmentAt, row.appointmentTimezone ?? undefined)}
                            <span className="text-muted-foreground block text-xs">
                              {relativeTime(row.appointmentAt)}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">No call booked</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {row.aiCloseProbability === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : row.isHot ? (
                          <ProbabilityBadge value={row.aiCloseProbability} />
                        ) : (
                          <span className="text-muted-foreground">
                            {Math.round(row.aiCloseProbability)}%
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {row.ownerName ?? <span className="text-muted-foreground">Unassigned</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <NurtureStatusChip status={row.status} />
                        {row.latestTouch && (
                          <span className="text-muted-foreground block text-xs">
                            {NURTURE_KIND_LABEL[row.latestTouch.kind]} ·{' '}
                            {relativeTime(row.latestTouch.sentAt)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-2">
                          {row.status === 'sent' && row.latestTouch && (
                            <ConfirmTouchButton touchId={row.latestTouch.id} />
                          )}
                          <LogNurtureDialog
                            clientId={row.clientId}
                            clientName={fullName(row)}
                            variant={row.status === 'none' ? 'default' : 'outline'}
                          />
                        </div>
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
