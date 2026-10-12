'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  calendarHref,
  dayKeyOf,
  rangeFor,
  rangeLabel,
  shiftDate,
  type CalendarState,
  type CalendarVM,
  type CalendarView,
  type VisitVM,
} from '@/lib/call-center/calendar/planner'
import { DayGrid } from './day-grid'
import { MonthGrid } from './month-grid'
import { Rail } from './rail'
import { VisitScheduler, type SchedulerLead, type SchedulerMode } from './scheduler'
import { VisitPanel } from './visit-panel'
import { repOf } from './visit-block'
import { WeekGrid } from './week-grid'
import './calendar.css'

const VIEWS: { id: CalendarView; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
]

const PHONE_QUERY = '(max-width: 767.98px)'

const SPAN: Record<CalendarView, string> = { day: 'on this day', week: 'this week', month: 'this month' }

/**
 * The Calendar tab's planner (docs/CALENDAR.md §2): view switch, range
 * stepper, rep filter, the grid, the rail, the visit panel and the
 * scheduler. Navigation is plain links on `/call-center?tab=calendar`; the
 * server renders each view from the database.
 */
export function CalendarPlanner({ vm }: { vm: CalendarVM }) {
  const router = useRouter()
  const state: CalendarState = { view: vm.view, date: vm.date, rep: vm.rep }
  const [now, setNow] = useState(() => new Date(vm.now))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [booking, setBooking] = useState<{ lead: SchedulerLead; mode: SchedulerMode } | null>(null)
  const selected = vm.visits.find((v) => v.id === selectedId) ?? vm.nextHours.find((v) => v.id === selectedId) ?? null

  // The now line moves with the clock.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // A phone opens on the Day view unless the link named a view.
  const { viewSet, view, date, rep } = vm
  useEffect(() => {
    if (viewSet || view !== 'week' || !window.matchMedia(PHONE_QUERY).matches) return
    router.replace(calendarHref({ view, date, rep }, { view: 'day' }), { scroll: false })
  }, [router, viewSet, view, date, rep])

  const refresh = () => router.refresh()
  const dayHref = (key: string) => calendarHref(state, { view: 'day', date: key })
  const open = (visit: VisitVM) => setSelectedId(visit.id)
  const repLabel = vm.rep ? repOf(vm.reps, vm.rep).label : null
  const days = rangeFor(vm.view, vm.date).days

  return (
    <div className="cal">
      <div className="cal-bar">
        <nav className="cal-views" aria-label="Calendar view">
          {VIEWS.map((v) => (
            <Link key={v.id} className={v.id === vm.view ? 'on' : ''} aria-current={v.id === vm.view ? 'page' : undefined} href={calendarHref(state, { view: v.id })}>
              {v.label}
            </Link>
          ))}
        </nav>
        <div className="cal-step">
          <Link className="cal-arrow" aria-label={`Previous ${vm.view}`} href={calendarHref(state, { date: shiftDate(vm.view, vm.date, -1) })}>‹</Link>
          <h3 className="cal-range" aria-live="polite">{rangeLabel(vm.view, vm.date)}</h3>
          <Link className="cal-arrow" aria-label={`Next ${vm.view}`} href={calendarHref(state, { date: shiftDate(vm.view, vm.date, 1) })}>›</Link>
          <Link className="cal-today" href={calendarHref(state, { date: dayKeyOf(now) })}>Today</Link>
        </div>
      </div>
      <nav className="cal-filter" aria-label="Rep filter and colors">
        <Link className={vm.rep ? '' : 'on'} aria-current={vm.rep ? undefined : 'true'} href={calendarHref(state, { rep: null })}>All reps</Link>
        {vm.reps.map((r) => (
          <Link
            key={r.key}
            className={`cal-rep-${r.color}${vm.rep === r.key ? ' on' : ''}`}
            aria-current={vm.rep === r.key ? 'true' : undefined}
            href={calendarHref(state, { rep: r.key })}
          >
            <i className="cal-dot" aria-hidden="true" />
            {r.label}
          </Link>
        ))}
      </nav>
      <div className="cal-layout">
        <div className="cal-main card">
          {!vm.visits.length ? (
            <p className="cal-empty" role="status">
              No visits{repLabel ? ` for ${repLabel}` : ''} {SPAN[vm.view]}. Book one from To schedule or with Book visit on a lead.
            </p>
          ) : null}
          <div className="cal-scroll">
            {vm.view === 'month' ? (
              <MonthGrid month={vm.date} visits={vm.visits} reps={vm.reps} now={now} dayHref={dayHref} />
            ) : vm.view === 'day' ? (
              <DayGrid day={vm.date} visits={vm.visits} reps={vm.reps} now={now} selectedId={selectedId} onOpen={open} />
            ) : (
              <WeekGrid days={days} visits={vm.visits} reps={vm.reps} now={now} selectedId={selectedId} dayHref={dayHref} onOpen={open} />
            )}
          </div>
        </div>
        <div className={`cal-side${selected ? ' has-panel' : ''}`}>
          {selected ? (
            <VisitPanel
              key={selected.id}
              visit={selected}
              rep={repOf(vm.reps, selected.repKey)}
              onClose={() => setSelectedId(null)}
              onChanged={refresh}
              onReschedule={(visit) =>
                setBooking({
                  lead: { id: visit.leadId, name: visit.name },
                  mode: { kind: 'reschedule', slotId: visit.id, repKey: visit.repKey, startsAt: visit.startsAt },
                })
              }
            />
          ) : null}
          <Rail
            now={now}
            reps={vm.reps}
            nextHours={vm.nextHours}
            toSchedule={vm.toSchedule}
            followUps={vm.followUps}
            onBook={(lead) => setBooking({ lead: { id: lead.id, name: lead.name }, mode: { kind: 'hold' } })}
          />
        </div>
      </div>
      {booking ? (
        <VisitScheduler
          key={`${booking.lead.id}-${booking.mode.kind}`}
          data={vm.scheduler}
          lead={booking.lead}
          mode={booking.mode}
          onSaved={() => {
            if (booking.mode.kind === 'reschedule') setSelectedId(null)
            refresh()
          }}
          onClose={() => setBooking(null)}
        />
      ) : null}
    </div>
  )
}
