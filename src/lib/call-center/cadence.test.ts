import { describe, expect, it } from 'vitest'
import {
  CADENCE_STEPS,
  CONNECTED_SECONDS,
  TRY_LIMIT,
  cadenceExhausted,
  cadenceStepLabel,
  callbackChips,
  carrierVerdict,
  clampToDeskWindow,
  dayKey,
  daySlots,
  instantOf,
  nextCadenceAt,
  safeZone,
  slotDays,
  validateCallbackAt,
  wallTime,
  zonedLabel,
} from './cadence'

const LA = 'America/Los_Angeles'

describe('the no-answer cadence', () => {
  it('has six steps and a seventh try that exhausts the lead', () => {
    expect(CADENCE_STEPS).toHaveLength(6)
    expect(TRY_LIMIT).toBe(7)
    expect(cadenceExhausted(6)).toBe(false)
    expect(cadenceExhausted(7)).toBe(true)
    expect(cadenceStepLabel(1)).toBe('Step 1 of 6 · In 5 minutes')
    expect(cadenceStepLabel(7)).toBeNull()
  })

  it('walks +5 min, tomorrow 10:00, day after 17:00, +2, +3, +3 days in the lead zone', () => {
    // Fri Oct 9 2026, 10:00 PDT.
    let at = '2026-10-09T17:00:00.000Z'
    const seen: string[] = []
    for (let tries = 1; tries <= 6; tries += 1) {
      const next = nextCadenceAt(tries, at, LA)
      expect(next).not.toBeNull()
      seen.push(next as string)
      at = next as string
    }
    expect(seen).toEqual([
      '2026-10-09T17:05:00.000Z', // 10:05 PDT
      '2026-10-10T17:00:00.000Z', // Sat 10:00 PDT
      '2026-10-13T00:00:00.000Z', // Mon 17:00 PDT (day after tomorrow from Sat)
      '2026-10-15T00:00:00.000Z', // Wed 17:00 PDT (+2 days)
      '2026-10-18T00:00:00.000Z', // Sat 17:00 PDT (+3 days)
      '2026-10-21T00:00:00.000Z', // Tue 17:00 PDT (+3 days)
    ])
    expect(nextCadenceAt(7, at, LA)).toBeNull()
  })

  it('ignores impossible tries', () => {
    expect(nextCadenceAt(0, '2026-10-09T17:00:00.000Z', LA)).toBeNull()
    expect(nextCadenceAt(-1, '2026-10-09T17:00:00.000Z', LA)).toBeNull()
    expect(nextCadenceAt(1.5, '2026-10-09T17:00:00.000Z', LA)).toBeNull()
    expect(nextCadenceAt(8, '2026-10-09T17:00:00.000Z', LA)).toBeNull()
    expect(nextCadenceAt(1, 'not a date', LA)).toBeNull()
  })

  it('clamps: +5 min past 20:00 moves to 10:00 the next day', () => {
    // 19:58 PDT on Oct 9.
    expect(nextCadenceAt(1, '2026-10-10T02:58:00.000Z', LA)).toBe('2026-10-10T17:00:00.000Z')
    // 19:50 PDT stays (19:55 is inside the window).
    expect(nextCadenceAt(1, '2026-10-10T02:50:00.000Z', LA)).toBe('2026-10-10T02:55:00.000Z')
  })

  it('clamps: too early moves to 10:00 the same day', () => {
    // 6:00 PDT → 6:05 → 10:00 the same day.
    expect(nextCadenceAt(1, '2026-10-09T13:00:00.000Z', LA)).toBe('2026-10-09T17:00:00.000Z')
    // +2 days from 7:30 PDT lands at 7:30 → 10:00 that day.
    expect(nextCadenceAt(4, '2026-10-09T14:30:00.000Z', LA)).toBe('2026-10-11T17:00:00.000Z')
  })

  it('keeps wall time across the fall-back change (Nov 1 2026, Los Angeles)', () => {
    // Sat Oct 31 18:00 PDT, +2 days → Mon Nov 2 18:00 PST (UTC-8).
    expect(nextCadenceAt(4, '2026-11-01T01:00:00.000Z', LA)).toBe('2026-11-03T02:00:00.000Z')
    // Sat Oct 31 15:00 PDT, tomorrow 10:00 → Sun Nov 1 10:00 PST.
    expect(nextCadenceAt(2, '2026-10-31T22:00:00.000Z', LA)).toBe('2026-11-01T18:00:00.000Z')
  })

  it('keeps wall time across the spring-forward change (Mar 8 2026, Los Angeles)', () => {
    // Sat Mar 7 15:00 PST, tomorrow 10:00 → Sun Mar 8 10:00 PDT (UTC-7).
    expect(nextCadenceAt(2, '2026-03-07T23:00:00.000Z', LA)).toBe('2026-03-08T17:00:00.000Z')
    // Fri Mar 6 12:00 PST, +3 days → Mon Mar 9 12:00 PDT.
    expect(nextCadenceAt(5, '2026-03-06T20:00:00.000Z', LA)).toBe('2026-03-09T19:00:00.000Z')
  })

  it("works in the lead's zone, not the desk's", () => {
    // 11:00 EDT on Oct 9 → tomorrow 10:00 EDT.
    expect(nextCadenceAt(2, '2026-10-09T15:00:00.000Z', 'America/New_York')).toBe('2026-10-10T14:00:00.000Z')
    // Phoenix has no DST: day after tomorrow 17:00 MST is 00:00Z.
    expect(nextCadenceAt(3, '2026-10-09T17:00:00.000Z', 'America/Phoenix')).toBe('2026-10-12T00:00:00.000Z')
    // 21:00 in New York is already too late, even though it's 18:00 in Los Angeles.
    expect(nextCadenceAt(1, '2026-10-10T01:00:00.000Z', 'America/New_York')).toBe('2026-10-10T14:00:00.000Z')
  })

  it('falls back to Los Angeles for a bad stored zone', () => {
    expect(safeZone('Not/AZone')).toBe(LA)
    expect(safeZone(null)).toBe(LA)
    expect(nextCadenceAt(2, '2026-10-09T17:00:00.000Z', 'Not/AZone')).toBe('2026-10-10T17:00:00.000Z')
  })
})

describe('desk window clamp', () => {
  const at = (iso: string) => clampToDeskWindow(new Date(iso), LA).toISOString()
  it('keeps 9:00 through 19:59 and moves the rest', () => {
    expect(at('2026-10-09T15:59:00.000Z')).toBe('2026-10-09T17:00:00.000Z') // 8:59 → 10:00
    expect(at('2026-10-09T16:00:00.000Z')).toBe('2026-10-09T16:00:00.000Z') // 9:00 stays
    expect(at('2026-10-10T02:59:00.000Z')).toBe('2026-10-10T02:59:00.000Z') // 19:59 stays
    expect(at('2026-10-10T03:00:00.000Z')).toBe('2026-10-10T17:00:00.000Z') // 20:00 → next day 10:00
    expect(at('2026-10-10T06:30:00.000Z')).toBe('2026-10-10T17:00:00.000Z') // 23:30 → next day 10:00
    expect(at('2026-10-10T07:30:00.000Z')).toBe('2026-10-10T17:00:00.000Z') // 0:30 → same day 10:00
  })

  it('round-trips wall times', () => {
    const wall = { year: 2026, month: 11, day: 1, hour: 10, minute: 30 }
    expect(wallTime(instantOf(wall, LA), LA)).toEqual(wall)
    expect(dayKey(new Date('2026-10-10T06:59:00.000Z'), LA)).toBe('2026-10-09')
    expect(dayKey(new Date('2026-10-10T07:00:00.000Z'), LA)).toBe('2026-10-10')
  })
})

describe('carrier verdicts', () => {
  it('reads a finished call', () => {
    expect(carrierVerdict({ outcome: null, status: 'completed', talkSeconds: null })).toBe('unknown')
    expect(carrierVerdict({ outcome: 'NO_ANSWER', status: 'unknown', talkSeconds: null })).toBe('unknown')
    expect(carrierVerdict({ outcome: 'CONNECTED', status: 'unknown', talkSeconds: 40 })).toBe('reached')
    expect(carrierVerdict({ outcome: 'CONNECTED', status: 'completed', talkSeconds: CONNECTED_SECONDS })).toBe('reached')
    expect(carrierVerdict({ outcome: 'CONNECTED', status: 'completed', talkSeconds: CONNECTED_SECONDS - 1 })).toBe('unanswered')
    expect(carrierVerdict({ outcome: 'CONNECTED', status: 'completed', talkSeconds: null })).toBe('unanswered')
    for (const outcome of ['NO_ANSWER', 'BUSY', 'FAILED', 'VOICEMAIL', 'DECLINED']) {
      expect(carrierVerdict({ outcome, status: 'completed', talkSeconds: 0 })).toBe('unanswered')
    }
  })
})

describe('callbacks', () => {
  const now = new Date('2026-10-09T19:30:00.000Z') // 12:30 PDT

  it('accepts a future time within 60 days, and nothing else', () => {
    expect(validateCallbackAt('2026-10-09T20:30:00.000Z', now)).toMatchObject({ ok: true })
    expect(validateCallbackAt('2026-10-09T19:30:00.000Z', now)).toMatchObject({ ok: false })
    expect(validateCallbackAt('2026-10-09T18:00:00.000Z', now)).toMatchObject({ ok: false, error: 'The call back time has already passed.' })
    expect(validateCallbackAt('2026-12-08T19:30:00.000Z', now)).toMatchObject({ ok: true })
    expect(validateCallbackAt('2026-12-08T19:31:00.000Z', now)).toMatchObject({ ok: false, error: 'Pick a time within 60 days.' })
    expect(validateCallbackAt('soon', now)).toMatchObject({ ok: false })
    expect(validateCallbackAt(12, now)).toMatchObject({ ok: false })
    expect(validateCallbackAt('x'.repeat(41), now)).toMatchObject({ ok: false })
  })

  it('offers the four quick picks in the lead zone, clamped into the window', () => {
    const chips = callbackChips(now, LA)
    expect(chips.map((c) => c.label)).toEqual(['In 1 hour', 'Tomorrow 10:00', 'Tomorrow 17:00', 'In 3 days'])
    expect(chips.map((c) => c.at)).toEqual([
      '2026-10-09T20:30:00.000Z',
      '2026-10-10T17:00:00.000Z',
      '2026-10-11T00:00:00.000Z',
      '2026-10-12T19:30:00.000Z',
    ])
    // 19:30 PDT: "in 1 hour" would be 20:30, so it moves to 10:00 tomorrow.
    const late = callbackChips(new Date('2026-10-10T02:30:00.000Z'), LA)
    expect(late[0].at).toBe('2026-10-10T17:00:00.000Z')
  })

  it('lists 30-minute slots from 9:00 to 19:30 that are still ahead', () => {
    const days = slotDays(now, LA)
    expect(days).toHaveLength(14)
    expect(days[0].key).toBe('2026-10-09')
    expect(days[1].key).toBe('2026-10-10')
    const today = daySlots(days[0], LA, now)
    expect(today[0]).toBe('2026-10-09T20:00:00.000Z') // 13:00 PDT
    expect(today.at(-1)).toBe('2026-10-10T02:30:00.000Z') // 19:30 PDT
    expect(daySlots(days[1], LA, now)).toHaveLength(22)
    expect(daySlots(days[1], 'America/New_York', now)[0]).toBe('2026-10-10T13:00:00.000Z')
  })

  it('labels a time in a zone', () => {
    expect(zonedLabel('2026-10-09T21:30:00.000Z', LA)).toBe('Fri, Oct 9, 2:30 pm')
    expect(zonedLabel('2026-10-09T21:30:00.000Z', 'America/New_York', false)).toBe('5:30 pm')
  })
})
