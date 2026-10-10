import { describe, expect, it } from 'vitest'
import { CALL_RESULT_UNKNOWN, countedByRep, planCarrierCall, type CarrierCall } from './carrier'
import type { CallLead } from './model'

// Fri Oct 9 2026, 10:00 PDT.
const ENDED = new Date('2026-10-09T17:00:00.000Z')
const STARTED = new Date('2026-10-09T16:59:00.000Z')

function lead(over: Partial<CallLead> = {}): CallLead {
  return {
    id: 'lead-1',
    name: 'Pat Example',
    language: 'en',
    channel: 'form',
    contacted: false,
    status: 'waiting',
    last4: '0199',
    zip: null,
    page: 'Solar Contract Services',
    arrivedAt: '2026-10-09T15:00:00.000Z',
    disabled: false,
    recording: null,
    trail: [],
    lockedBy: 'rep',
    persisted: true,
    tries: 0,
    nextAttemptAt: null,
    dnc: false,
    timeZone: 'America/Los_Angeles',
    ...over,
  }
}

const row = (over: Partial<{ status: 'WAITING' | 'INBOUND' | 'MISSED' | 'BOOKED'; doNotCallAt: Date | null }> = {}) => ({
  status: 'WAITING' as const,
  doNotCallAt: null,
  ...over,
})

const call = (over: Partial<CarrierCall> = {}): CarrierCall => ({
  outcome: 'NO_ANSWER',
  status: 'completed',
  talkSeconds: 0,
  startedAt: STARTED,
  endedAt: ENDED,
  ...over,
})

describe('a finished carrier call on a lead', () => {
  it('leaves the lead alone when the result never arrived', () => {
    expect(planCarrierCall(lead(), row(), call({ outcome: null }), ENDED)).toEqual({ detail: CALL_RESULT_UNKNOWN, update: null })
    expect(planCarrierCall(lead(), row(), call({ status: 'unknown' }), ENDED).update).toBeNull()
  })

  it('advances the cadence one step for no answer, busy, or failed', () => {
    const plan = planCarrierCall(lead(), row(), call(), ENDED)
    expect(plan).toMatchObject({ detail: 'No answer', followUp: 'cadence' })
    expect(plan.update).toEqual({ tries: 1, nextAttemptAt: new Date('2026-10-09T17:05:00.000Z'), status: 'MISSED' })
    expect(planCarrierCall(lead({ tries: 1 }), row(), call({ outcome: 'BUSY' }), ENDED)).toMatchObject({
      detail: 'Busy',
      update: { tries: 2, nextAttemptAt: new Date('2026-10-10T17:00:00.000Z') },
    })
    expect(planCarrierCall(lead(), row(), call({ outcome: 'FAILED' }), ENDED).detail).toBe('The call failed')
  })

  it('counts a pick-up under 20 seconds as no answer', () => {
    const plan = planCarrierCall(lead(), row(), call({ outcome: 'CONNECTED', talkSeconds: 12 }), ENDED)
    expect(plan.detail).toBe('Answered 0:12 · under 20 s, counted as no answer')
    expect(plan.connected).toBeUndefined()
    expect(plan.update?.tries).toBe(1)
  })

  it('uses the end of the call, in the lead zone, for the next step', () => {
    const plan = planCarrierCall(lead({ tries: 1, timeZone: 'America/New_York' }), row(), call(), new Date('2026-10-10T00:00:00.000Z'))
    // Tomorrow 10:00 EDT after a call that ended at 13:00 EDT.
    expect(plan.update?.nextAttemptAt).toEqual(new Date('2026-10-10T14:00:00.000Z'))
  })

  it('reaches the lead at 20 seconds and clears only a cadence follow-up', () => {
    const cadence = lead({ tries: 2, followUp: 'cadence', nextAttemptAt: '2026-10-09T17:05:00.000Z', status: 'retry' })
    expect(planCarrierCall(cadence, row({ status: 'MISSED' }), call({ outcome: 'CONNECTED', talkSeconds: 20 }), ENDED)).toEqual({
      detail: 'Connected · 0:20',
      connected: true,
      followUp: 'none',
      update: { nextAttemptAt: null, status: 'WAITING' },
    })
    const callback = lead({ followUp: 'callback', nextAttemptAt: '2026-10-12T17:00:00.000Z' })
    expect(planCarrierCall(callback, row(), call({ outcome: 'CONNECTED', talkSeconds: 95 }), ENDED)).toEqual({
      detail: 'Connected · 1:35',
      connected: true,
      update: null,
    })
  })

  it('does not count a call the rep already counted with a result', () => {
    const counted = lead({
      tries: 1,
      trail: [{ kind: 'outcome', at: '2026-10-09T16:59:30.000Z', label: 'No answer', detail: 'Next try', followUp: 'cadence' }],
    })
    expect(countedByRep(counted, STARTED)).toBe(true)
    expect(planCarrierCall(counted, row(), call(), ENDED)).toEqual({ detail: 'No answer', update: null })
    // A result from before this call started is a different attempt.
    const earlier = lead({
      tries: 1,
      trail: [{ kind: 'outcome', at: '2026-10-09T16:00:00.000Z', label: 'No answer', detail: 'Next try', followUp: 'cadence' }],
    })
    expect(countedByRep(earlier, STARTED)).toBe(false)
    expect(planCarrierCall(earlier, row(), call(), ENDED).update?.tries).toBe(2)
    expect(countedByRep(counted, null)).toBe(false)
  })

  it("keeps a callback the rep set during a short call (the rep's result wins)", () => {
    const agreed = lead({
      followUp: 'callback',
      nextAttemptAt: '2026-10-10T22:00:00.000Z',
      trail: [{ kind: 'outcome', at: '2026-10-09T16:59:40.000Z', label: 'Callback', detail: 'Callback set', followUp: 'callback' }],
    })
    // Answered for 15 s: the carrier alone would call it unanswered and add a cadence step.
    expect(planCarrierCall(agreed, row(), call({ status: 'completed', talkSeconds: 15 }), ENDED).update).toBeNull()
  })

  it('never schedules a booked or do-not-call lead', () => {
    expect(planCarrierCall(lead(), row({ status: 'BOOKED' }), call(), ENDED).update).toBeNull()
    expect(planCarrierCall(lead(), row({ doNotCallAt: ENDED }), call(), ENDED).update).toBeNull()
  })

  it('exhausts the lead on the seventh try and stops counting after', () => {
    expect(planCarrierCall(lead({ tries: 6 }), row(), call(), ENDED)).toEqual({
      detail: 'No answer',
      followUp: 'none',
      update: { tries: 7, nextAttemptAt: null, status: 'MISSED' },
    })
    expect(planCarrierCall(lead({ tries: 7 }), row(), call(), ENDED)).toEqual({ detail: 'No answer · no further tries', update: null })
  })
})
