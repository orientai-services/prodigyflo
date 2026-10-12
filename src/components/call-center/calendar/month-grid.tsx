import Link from 'next/link'
import {
  dayKeyOf,
  groupByDay,
  monthCells,
  monthChips,
  shortName,
  statusLook,
  timeLabel,
  type RepVM,
  type VisitVM,
} from '@/lib/call-center/calendar/planner'
import { repOf } from './visit-block'

const HEADS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Month view: up to three chips a day and "+N more"; a day opens its Day view. */
export function MonthGrid({
  month,
  visits,
  reps,
  now,
  dayHref,
}: {
  month: string
  visits: VisitVM[]
  reps: RepVM[]
  now: Date
  dayHref: (key: string) => string
}) {
  const byDay = groupByDay(visits)
  const today = dayKeyOf(now)
  return (
    <div className="cal-month">
      <div className="cal-month-heads" aria-hidden="true">
        {HEADS.map((h) => <span key={h}>{h}</span>)}
      </div>
      {monthCells(month).map((week) => (
        <div key={week[0].key} className="cal-month-week">
          {week.map((cell) => {
            const list = byDay.get(cell.key) ?? []
            const { shown, more } = monthChips(list)
            return (
              <Link
                key={cell.key}
                href={dayHref(cell.key)}
                className={['cal-cell', cell.inMonth ? '' : 'out', cell.key === today ? 'today' : ''].filter(Boolean).join(' ')}
                aria-label={`${cell.key}: ${list.length ? `${list.length} visit${list.length === 1 ? '' : 's'}` : 'no visits'}. Open the day.`}
              >
                <span className="cal-num">{cell.day}</span>
                {shown.map((visit) => {
                  const look = statusLook(visit.status)
                  return (
                    <span key={visit.id} className={`cal-mchip cal-rep-${repOf(reps, visit.repKey).color}${look.struck ? ' struck' : ''}`}>
                      <span className="cal-mchip-text">{timeLabel(visit.startsAt).replace(':00 ', ' ')} {shortName(visit.name)}</span>
                    </span>
                  )
                })}
                {more ? <span className="cal-more">+{more} more</span> : null}
              </Link>
            )
          })}
        </div>
      ))}
    </div>
  )
}
