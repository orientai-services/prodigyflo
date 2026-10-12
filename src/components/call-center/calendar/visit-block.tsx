import { blockPlacement, statusLook, timeRange, type Lane, type RepVM, type VisitVM } from '@/lib/call-center/calendar/planner'

/** The rep's color class and label, also for a legacy rep key no longer in the list. */
export function repOf(reps: readonly RepVM[], key: string): RepVM {
  return reps.find((r) => r.key === key) ?? { key, label: key, color: 'teal' }
}

/**
 * One visit on the week or day grid: a button positioned by its start time,
 * 90 minutes tall, colored by rep. `detailed` (the Day view) adds the last
 * four, language and the lead's note.
 */
export function VisitBlock({
  visit,
  rep,
  lane,
  detailed = false,
  selected = false,
  onOpen,
}: {
  visit: VisitVM
  rep: RepVM
  lane: Lane
  detailed?: boolean
  selected?: boolean
  onOpen: (visit: VisitVM) => void
}) {
  const place = blockPlacement(visit.startsAt, visit.endsAt)
  const look = statusLook(visit.status)
  const when = timeRange(visit.startsAt, visit.endsAt)
  return (
    <button
      type="button"
      className={['cal-block', `cal-rep-${rep.color}`, `cal-st-${look.look}`, selected ? 'on' : ''].filter(Boolean).join(' ')}
      style={{
        top: `${place.top * 100}%`,
        height: `${place.height * 100}%`,
        left: `calc(${(lane.lane / lane.lanes) * 100}% + 2px)`,
        width: `calc(${100 / lane.lanes}% - 4px)`,
      }}
      aria-label={`${visit.name}, ${when}, ${rep.label}, ${look.label}${lane.conflict ? ', overlaps another visit for this rep' : ''}`}
      onClick={() => onOpen(visit)}
    >
      <b className="cal-block-name">
        {lane.conflict ? <span className="cal-warn" title="Overlaps another visit for this rep">⚠</span> : null}
        {visit.name}
      </b>
      <span className="cal-block-line">{when} · {rep.label}</span>
      {detailed ? (
        <span className="cal-block-line">
          {visit.last4 ? `••${visit.last4} · ` : ''}{visit.language === 'ES' ? 'Spanish' : 'English'}
        </span>
      ) : null}
      <span className="cal-chip">{look.label}</span>
      {detailed && visit.note ? <span className="cal-block-note">{visit.note}</span> : null}
    </button>
  )
}
