import Link from 'next/link'
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Flame,
  LifeBuoy,
  Minus,
  Send,
  Sunrise,
  Sunset,
} from 'lucide-react'
import {
  defaultHuddleMode,
  getEodWrap,
  getMorningHuddle,
  getOrgTimezone,
  type EodWrap,
  type HuddleAppointment,
  type HuddleMode,
  type MorningHuddle,
} from '@/lib/huddle'
import { SALES_LEVEL_LABEL, requireSalesAccess } from '@/lib/coaching'
import type { NurtureStatus } from '@/lib/nurture'
import { can } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { currency, fullName, humanize, number, percent, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { BriefChip, ProbabilityBadge, SalesNav } from '../ui'

export const metadata = { title: 'Daily huddle' }

/** Appointment time in the org's clock — the room reads one timezone. */
function timeIn(date: Date, timeZone: string): string {
  try {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone })
  } catch {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
}

export default async function DailyHuddlePage({ searchParams }: PageProps<'/sales/huddle'>) {
  const { user, level } = await requireSalesAccess()
  const timezone = await getOrgTimezone(user.organizationId)
  const canQualify = can(user, 'qualification:review')

  const params = await searchParams
  const requested = typeof params.mode === 'string' ? params.mode : null
  const mode: HuddleMode =
    requested === 'morning' || requested === 'wrap'
      ? requested
      : defaultHuddleMode(new Date(), timezone)

  const data = mode === 'morning' ? await getMorningHuddle(user) : await getEodWrap(user)

  return (
    <>
      <PageHeader
        title="Daily huddle"
        description={
          mode === 'morning'
            ? `Morning stand-up for the ${SALES_LEVEL_LABEL[level]} — what good looks like today`
            : `End-of-day wrap for the ${SALES_LEVEL_LABEL[level]} — today's numbers, read aloud`
        }
      >
        <SalesNav current="huddle" canQualify={canQualify} />
        <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Huddle mode">
          <ModePill mode="morning" current={mode} icon={<Sunrise className="size-3.5" />} label="Morning huddle" />
          <ModePill mode="wrap" current={mode} icon={<Sunset className="size-3.5" />} label="End-of-day wrap" />
        </div>
      </PageHeader>

      <div className="space-y-4 p-4 sm:p-6">
        {mode === 'morning' ? (
          <MorningBoard data={data as MorningHuddle} />
        ) : (
          <WrapBoard data={data as EodWrap} />
        )}
      </div>
    </>
  )
}

function ModePill({
  mode,
  current,
  icon,
  label,
}: {
  mode: HuddleMode
  current: HuddleMode
  icon: React.ReactNode
  label: string
}) {
  const active = mode === current
  return (
    <Link
      href={`/sales/huddle?mode=${mode}`}
      role="tab"
      aria-selected={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-primary text-primary-foreground border-transparent'
          : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {icon}
      {label}
    </Link>
  )
}

/** A stand-up number: big enough to read from across the room. */
function HuddleStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card rounded-xl border p-4">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {sub && <p className="text-muted-foreground mt-1 text-xs tabular-nums">{sub}</p>}
    </div>
  )
}

function NurtureChip({ status }: { status: NurtureStatus }) {
  if (status === 'confirmed') {
    return (
      <span className="bg-success/10 text-success inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium">
        <CheckCircle2 className="size-3" /> Nurture confirmed
      </span>
    )
  }
  if (status === 'sent') {
    return (
      <span className="bg-warning/10 text-warning inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium">
        <Send className="size-3" /> Nurture sent
      </span>
    )
  }
  return (
    <span className="text-muted-foreground bg-muted inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium">
      <Minus className="size-3" /> No nurture
    </span>
  )
}

function AppointmentList({
  appointments,
  timezone,
  emptyTitle,
  emptyDescription,
}: {
  appointments: HuddleAppointment[]
  timezone: string
  emptyTitle: string
  emptyDescription: string
}) {
  if (appointments.length === 0) {
    return <EmptyState icon="CalendarClock" title={emptyTitle} description={emptyDescription} />
  }
  return (
    <ul className="divide-y">
      {appointments.map((a) => (
        <li key={a.id}>
          <Link
            href={`/clients/${a.clientId}`}
            className="hover:bg-muted/40 flex items-center gap-3 px-4 py-2.5 text-sm transition-colors"
          >
            <span className="w-20 shrink-0 text-right font-semibold tabular-nums">
              {timeIn(a.startsAt, timezone)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{a.clientName}</span>
              <span className="text-muted-foreground block truncate text-xs">
                {humanize(a.type)}
                {a.ownerName ? ` · ${a.ownerName}` : ''}
                {a.status === 'CONFIRMED' ? ' · confirmed' : ''}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <NurtureChip status={a.nurture} />
              {typeof a.aiCloseProbability === 'number' && (
                <ProbabilityBadge value={a.aiCloseProbability} />
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

// ── Morning ──────────────────────────────────────────────────────────────────

function MorningBoard({ data }: { data: MorningHuddle }) {
  return (
    <>
      {/* Yesterday recap strip */}
      <section aria-label="Yesterday recap">
        <p className="text-muted-foreground mb-2 text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
          Yesterday
        </p>
        <div className="grid grid-cols-3 gap-3">
          <HuddleStat label="Calls logged" value={number(data.yesterday.calls)} />
          <HuddleStat label="Wins" value={number(data.yesterday.wins)} />
          <HuddleStat label="Revenue won" value={currency(data.yesterday.revenue)} />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        {/* Today's appointments */}
        <div className="bg-card shadow-e1 rounded-xl border">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <CalendarClock className="text-primary size-4" /> Today&rsquo;s appointments
              </h2>
              <p className="text-muted-foreground text-xs">
                Every booked call walks in nurtured — chase the grey chips first
              </p>
            </div>
            <span className="text-muted-foreground text-xs tabular-nums">
              {number(data.appointments.length)} booked
            </span>
          </div>
          <AppointmentList
            appointments={data.appointments}
            timezone={data.timezone}
            emptyTitle="No appointments on the books today"
            emptyDescription="A clear calendar means the day belongs to the hot-lead queue below."
          />
        </div>

        {/* Top hot leads */}
        <div className="bg-card shadow-e1 self-start rounded-xl border">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <Flame className="text-warning size-4" /> Call these today
              </h2>
              <p className="text-muted-foreground text-xs">
                Top of the {data.hotLeadThreshold}%+ queue — AI orders it, you make the calls
              </p>
            </div>
            <Link
              href="/sales/hot-leads"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium transition-colors"
            >
              Full queue <ArrowRight className="size-3.5" />
            </Link>
          </div>
          {data.hotLeads.length === 0 ? (
            <EmptyState
              icon="Flame"
              title="No hot leads right now"
              description={`Leads appear here once the AI scores them at ${data.hotLeadThreshold}% or higher.`}
            />
          ) : (
            <ul className="divide-y">
              {data.hotLeads.map((lead) => (
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
                    <span className="flex shrink-0 items-center gap-2">
                      <BriefChip
                        generatedAt={lead.lastBriefGeneratedAt}
                        viewedAt={lead.lastBriefViewedAt}
                      />
                      <ProbabilityBadge value={lead.aiCloseProbability} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Leaking leads */}
      <div className="bg-card shadow-e1 rounded-xl border">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <LifeBuoy className="text-danger size-4" /> Rescue before they leak
            </h2>
            <p className="text-muted-foreground text-xs">
              Live leads silent for {number(data.leakageDays)}+ days — one touch today keeps them
              out of the leakage number
            </p>
          </div>
          <span
            className={cn(
              'text-xs font-semibold tabular-nums',
              data.leakingTotal > 0 ? 'text-danger' : 'text-success',
            )}
          >
            {number(data.leakingTotal)} leaking
          </span>
        </div>
        {data.leaking.length === 0 ? (
          <EmptyState
            icon="ShieldCheck"
            title="Nothing is leaking"
            description="Every live lead has been touched inside the window. Keep it that way."
          />
        ) : (
          <ul className="divide-y">
            {data.leaking.map((lead) => (
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
                  <span className="flex shrink-0 items-center gap-2">
                    {typeof lead.aiCloseProbability === 'number' && (
                      <ProbabilityBadge value={lead.aiCloseProbability} />
                    )}
                    <span className="text-danger text-xs font-medium tabular-nums">
                      quiet {relativeTime(lead.lastActivityAt).replace(' ago', '')}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

// ── End-of-day wrap ──────────────────────────────────────────────────────────

function WrapBoard({ data }: { data: EodWrap }) {
  return (
    <>
      {/* Today's numbers */}
      <section aria-label="Today's numbers">
        <p className="text-muted-foreground mb-2 text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
          Today
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          <HuddleStat
            label="Calls logged"
            value={number(data.calls)}
            sub={
              data.avgAdherencePct === null
                ? 'no funnel checklists scored'
                : `${percent(data.avgAdherencePct)} avg funnel adherence · ${number(data.adherenceScored)} scored`
            }
          />
          <HuddleStat label="Wins" value={number(data.wins)} sub="deals closed won today" />
          <HuddleStat label="Revenue won" value={currency(data.revenue)} sub="closed-won value today" />
          <HuddleStat
            label="Briefs generated"
            value={number(data.briefsGenerated)}
            sub={`${number(data.briefsViewed)} viewed today`}
          />
          <HuddleStat
            label="Nurture touches"
            value={number(data.nurtureSent)}
            sub={`${number(data.nurtureConfirmed)} confirmed today`}
          />
          <HuddleStat label="QA notes" value={number(data.qaNotes)} sub="coaching written today" />
        </div>
      </section>

      {/* Per-closer mini-rows (team-or-wider reach only) */}
      {data.closers !== null && (
        <div className="bg-card shadow-e1 rounded-xl border">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Closer by closer</h2>
            <p className="text-muted-foreground text-xs">
              Today&rsquo;s calls, brief usage on those calls, and wins — say every name out loud
            </p>
          </div>
          {data.closers.length === 0 ? (
            <EmptyState
              icon="Users"
              title="No closers in your scope"
              description="Active closers on your roster will appear here with their daily numbers."
            />
          ) : (
            <div className="scroll-x">
              <table className="w-full min-w-[28rem] text-sm tabular-nums">
                <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Closer</th>
                    <th className="px-4 py-2 text-right">Calls</th>
                    <th className="px-4 py-2 text-right">Briefed</th>
                    <th className="px-4 py-2 text-right">Wins</th>
                  </tr>
                </thead>
                <tbody>
                  {data.closers.map((c) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="px-4 py-2.5 font-medium">{c.name}</td>
                      <td
                        className={cn(
                          'px-4 py-2.5 text-right',
                          c.calls === 0 && 'text-muted-foreground',
                        )}
                      >
                        {number(c.calls)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {c.briefedPct === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={cn(
                              'font-medium',
                              c.briefedPct >= 80 ? 'text-success' : 'text-warning',
                            )}
                          >
                            {percent(c.briefedPct)}
                          </span>
                        )}
                      </td>
                      <td
                        className={cn(
                          'px-4 py-2.5 text-right font-semibold',
                          c.wins > 0 && 'text-success',
                        )}
                      >
                        {number(c.wins)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tomorrow preview */}
      <div className="bg-card shadow-e1 rounded-xl border">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <CalendarClock className="text-primary size-4" /> Tomorrow&rsquo;s appointments
            </h2>
            <p className="text-muted-foreground text-xs">
              Leave tonight knowing who is on the calendar — nurture the grey chips before you go
            </p>
          </div>
          <span className="text-muted-foreground text-xs tabular-nums">
            {number(data.tomorrow.length)} booked
          </span>
        </div>
        <AppointmentList
          appointments={data.tomorrow}
          timezone={data.timezone}
          emptyTitle="Nothing booked for tomorrow yet"
          emptyDescription="Set tomorrow up tonight — book from the hot-leads queue before heading out."
        />
      </div>
    </>
  )
}
