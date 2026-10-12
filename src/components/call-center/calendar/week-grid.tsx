import Link from 'next/link'
import {
  GRID_END_MINUTE,
  GRID_START_MINUTE,
  dayHead,
  dayKeyOf,
  groupByDay,
  laneLayout,
  minuteLabel,
  nowOffset,
  timeLabel,
  type RepVM,
  type VisitVM,
} from '@/lib/call-center/calendar/planner'
import { VisitBlock, repOf } from './visit-block'

const HOURS = Array.from({ length: (GRID_END_MINUTE - GRID_START_MINUTE) / 60 }, (_, i) => GRID_START_MINUTE + i * 60)
const NO_LANE = { lane: 0, lanes: 1, conflict: false }

/**
 * The hour grid shared by Week (seven columns) and Day (one wide column):
 * 8 AM–8 PM Pacific, a faint line every 30 minutes, the red now line on today.
 */
export function TimeGrid({
  days,
  visits,
  reps,
  now,
  selectedId,
  detailed = false,
  dayHref,
  onOpen,
}: {
  days: string[]
  visits: VisitVM[]
  reps: RepVM[]
  now: Date
  selectedId: string | null
  detailed?: boolean
  dayHref?: (key: string) => string
  onOpen: (visit: VisitVM) => void
}) {
  const byDay = groupByDay(visits)
  const today = dayKeyOf(now)
  const nowAt = days.map((key) => nowOffset(now, key)).find((offset) => offset !== null) ?? null
  return (
    <div className={`cal-time${detailed ? ' cal-time-day' : ''}`} style={{ ['--cal-cols' as string]: days.length }}>
      <div className="cal-heads" aria-hidden={detailed ? true : undefined}>
        <span />
        {days.map((key) => {
          const head = dayHead(key)
          const label = (
            <>
              <small>{head.weekday}</small> <b>{head.day}</b>
            </>
          )
          return (
            <span key={key} className={`cal-head${key === today ? ' today' : ''}`}>
              {dayHref ? <Link href={dayHref(key)}>{label}</Link> : label}
            </span>
          )
        })}
      </div>
      <div className="cal-body">
        <div className="cal-gutter" aria-hidden="true">
          {HOURS.map((m) => (
            <span key={m} style={{ top: `${((m - GRID_START_MINUTE) / (GRID_END_MINUTE - GRID_START_MINUTE)) * 100}%` }}>
              {minuteLabel(m).replace(':00 ', '').toLowerCase()}
            </span>
          ))}
          <span className="cal-gutter-end">{minuteLabel(GRID_END_MINUTE).replace(':00 ', '').toLowerCase()}</span>
          {nowAt !== null ? (
            <span className="cal-now-time" style={{ top: `${nowAt * 100}%` }}>{timeLabel(now)}</span>
          ) : null}
        </div>
        {days.map((key) => {
          const list = byDay.get(key) ?? []
          const lanes = laneLayout(list)
          const offset = nowOffset(now, key)
          return (
            <div key={key} className={`cal-col${key === today ? ' today' : ''}`} role="group" aria-label={`${dayHead(key).weekday} ${dayHead(key).day}`}>
              {list.map((visit) => (
                <VisitBlock
                  key={visit.id}
                  visit={visit}
                  rep={repOf(reps, visit.repKey)}
                  lane={lanes.get(visit.id) ?? NO_LANE}
                  detailed={detailed}
                  selected={visit.id === selectedId}
                  onOpen={onOpen}
                />
              ))}
              {offset !== null ? <i className="cal-now" style={{ top: `${offset * 100}%` }} aria-label={`Now, ${timeLabel(now)}`} /> : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function WeekGrid(props: Omit<Parameters<typeof TimeGrid>[0], 'detailed'>) {
  return <TimeGrid {...props} />
}
