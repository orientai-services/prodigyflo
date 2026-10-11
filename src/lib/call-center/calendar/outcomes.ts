import { NO_SHOW_CALLBACK_MINUTES } from './config'

export type CalendarOutcome = 'sat' | 'no-show' | 'rescheduled' | 'cancelled'
export type SlotStatus = 'HOLD' | 'CONFIRMED' | 'SAT' | 'NO_SHOW' | 'RESCHEDULED' | 'CANCELLED'

const TO_STATUS: Record<CalendarOutcome, SlotStatus> = {
  sat: 'SAT',
  'no-show': 'NO_SHOW',
  rescheduled: 'RESCHEDULED',
  cancelled: 'CANCELLED',
}

export function isOutcome(v: string): v is CalendarOutcome {
  return v in TO_STATUS
}

export type OutcomePlan = {
  status: SlotStatus
  /** No-show: put the lead back on the desk for a call-back this many ms from now. */
  callbackAt: Date | null
  /** Rescheduled / cancelled frees the BOOKED status back to WAITING unless another visit stands. */
  releasesLead: boolean
}

/** Outcomes are only recorded on a CONFIRMED visit (or a HOLD being cancelled/rescheduled). */
export function planOutcome(current: SlotStatus, outcome: CalendarOutcome, now: Date): OutcomePlan | { error: string } {
  if (current === 'HOLD' && (outcome === 'sat' || outcome === 'no-show')) return { error: 'visit was never confirmed' }
  if (current !== 'HOLD' && current !== 'CONFIRMED') return { error: 'visit already closed' }
  return {
    status: TO_STATUS[outcome],
    callbackAt: outcome === 'no-show' ? new Date(now.getTime() + NO_SHOW_CALLBACK_MINUTES * 60_000) : null,
    releasesLead: outcome === 'rescheduled' || outcome === 'cancelled',
  }
}

/** A HOLD becomes CONFIRMED only by a rep on the call. Never automatic. */
export function canConfirm(current: SlotStatus, by: 'rep' | 'autobook' | 'system'): boolean {
  return current === 'HOLD' && by === 'rep'
}
