/**
 * What one finished carrier call does to a Call Center lead. Pure, so the
 * desk's write (`recordCarrierCallFor`) stays a thin transaction around it.
 *
 * - Result never arrived: say so, change nothing (a rep sets it).
 * - Answered for CONNECTED_SECONDS or more: the lead is reached. A cadence
 *   follow-up is cleared; an agreed callback stays.
 * - Anything else (no answer, busy, failed, or a pick-up shorter than that)
 *   is one unanswered attempt and advances the cadence, unless the rep's own
 *   result for this call already counted it, the lead is booked or on do not
 *   call, or it is out of tries.
 */

import { CONNECTED_SECONDS, cadenceExhausted, carrierVerdict, nextCadenceAt } from './cadence'
import { followUpOf, type CallLead, type TrailEvent } from './model'

export const CALL_RESULT_UNKNOWN = 'Call result unknown'

export type CarrierCall = {
  outcome: string | null
  status: string | null
  talkSeconds: number | null
  startedAt: Date | null
  endedAt: Date | null
}

export type CarrierLeadUpdate = {
  tries?: number
  nextAttemptAt?: Date | null
  status?: 'WAITING' | 'MISSED'
}

export type CarrierPlan = {
  /** The CALL trail line. */
  detail: string
  followUp?: TrailEvent['followUp']
  connected?: boolean
  /** Null: leave the lead row alone. */
  update: CarrierLeadUpdate | null
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function unansweredDetail(call: CarrierCall): string {
  switch (call.outcome) {
    case 'CONNECTED':
      return `Answered ${clock(call.talkSeconds ?? 0)} · under ${CONNECTED_SECONDS} s, counted as no answer`
    case 'BUSY':
      return 'Busy'
    case 'FAILED':
      return 'The call failed'
    case 'VOICEMAIL':
      return 'Voicemail'
    case 'DECLINED':
      return 'Declined'
    default:
      return 'No answer'
  }
}

/**
 * The rep already recorded a result for this call: any OUTCOME at or after the
 * moment the call started. The rep's word wins over the carrier's clock: a
 * 15-second call where they agreed "call me tomorrow at 3" keeps that
 * callback, and an unanswered result isn't counted twice.
 */
export function countedByRep(lead: CallLead, startedAt: Date | null): boolean {
  if (!startedAt) return false
  const since = startedAt.getTime()
  return lead.trail.some((event) => event.kind === 'outcome' && Date.parse(event.at) >= since)
}

export function planCarrierCall(
  lead: CallLead,
  row: { status: 'WAITING' | 'INBOUND' | 'MISSED' | 'BOOKED'; doNotCallAt: Date | null },
  call: CarrierCall,
  at: Date,
): CarrierPlan {
  const verdict = carrierVerdict(call)
  if (verdict === 'unknown') return { detail: CALL_RESULT_UNKNOWN, update: null }

  if (verdict === 'reached') {
    const detail = `Connected · ${clock(call.talkSeconds ?? 0)}`
    const clear = followUpOf(lead) === 'cadence'
    const update: CarrierLeadUpdate = {}
    if (clear) update.nextAttemptAt = null
    if (row.status === 'MISSED') update.status = 'WAITING'
    return {
      detail,
      connected: true,
      ...(clear ? { followUp: 'none' as const } : {}),
      update: Object.keys(update).length ? update : null,
    }
  }

  const detail = unansweredDetail(call)
  if (countedByRep(lead, call.startedAt) || row.doNotCallAt || row.status === 'BOOKED') return { detail, update: null }
  if (cadenceExhausted(lead.tries)) return { detail: `${detail} · no further tries`, update: null }
  const tries = lead.tries + 1
  const next = nextCadenceAt(tries, call.endedAt ?? at, lead.timeZone)
  return {
    detail,
    followUp: next ? 'cadence' : 'none',
    update: { tries, nextAttemptAt: next ? new Date(next) : null, status: 'MISSED' },
  }
}
