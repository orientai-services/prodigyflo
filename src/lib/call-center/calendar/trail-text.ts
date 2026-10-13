import { formatWhen } from '@/lib/call-center/model'
import { calendarReps, type CalendarRep } from './config'
import type { CalendarOutcome } from './outcomes'

const OUTCOME_WORDS: Record<CalendarOutcome, string> = {
  sat: 'Visit happened (sat)',
  'no-show': 'Visit: no-show',
  rescheduled: 'Visit rescheduled',
  cancelled: 'Visit cancelled',
}

/**
 * The calendar writes its trail lines for the record (`service.ts`): a rep
 * key, an ISO instant, an outcome id. This turns them into words for the lead
 * trail and Today ("Calendar hold placed with Dakota", "Call back due Oct 13,
 * 2:30 PM"). Anything else returns null and is shown as written.
 */
export function calendarTrailText(body: string, reps: readonly CalendarRep[] = calendarReps()): string | null {
  const hold = /^Calendar hold placed \(([^)]+)\)$/.exec(body)
  if (hold) {
    const key = hold[1].trim().toLowerCase()
    const label = reps.find((rep) => rep.key === key)?.label ?? key.charAt(0).toUpperCase() + key.slice(1)
    return `Calendar hold placed with ${label}`
  }
  const due = /^Call back due (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)$/.exec(body)
  if (due && !Number.isNaN(Date.parse(due[1]))) return `Call back due ${formatWhen(due[1])}`
  const visit = /^Calendar visit: ([a-z-]+)$/.exec(body)
  if (visit && Object.hasOwn(OUTCOME_WORDS, visit[1])) return OUTCOME_WORDS[visit[1] as CalendarOutcome]
  return null
}

