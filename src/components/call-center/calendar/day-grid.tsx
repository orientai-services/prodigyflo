import type { RepVM, VisitVM } from '@/lib/call-center/calendar/planner'
import { TimeGrid } from './week-grid'

/** Day view: one wide column, every block with the last four, language and note. */
export function DayGrid({
  day,
  visits,
  reps,
  now,
  selectedId,
  onOpen,
}: {
  day: string
  visits: VisitVM[]
  reps: RepVM[]
  now: Date
  selectedId: string | null
  onOpen: (visit: VisitVM) => void
}) {
  return <TimeGrid days={[day]} visits={visits} reps={reps} now={now} selectedId={selectedId} detailed onOpen={onOpen} />
}
