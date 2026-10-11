import { describe, expect, it } from 'vitest'
import { autobookEnabled, calendarEnabled, calendarReps, clientTextEnabled } from './config'
import { bookingSkipReason } from './eligibility'
import { canConfirm, planOutcome } from './outcomes'
import { dueReminders, reminderMessage } from './reminders'
import { openSlots, slotProblem } from './slots'
import { minuteOfDay, zonedToUtc } from './time'

// Wednesday 2026-10-14 08:00 PT (UTC-7)
const NOW = new Date('2026-10-14T15:00:00Z')
const at = (y: number, m: number, d: number, hh: number, mm = 0) => zonedToUtc(y, m, d, hh * 60 + mm)
const REPS = ['rep-a', 'rep-b']

describe('flags default off', () => {
  it('calendar, autobook and A2P are off with no env', () => {
    expect(calendarEnabled({})).toBe(false)
    expect(autobookEnabled({})).toBe(false)
    expect(autobookEnabled({ CALL_CENTER_AUTOBOOK: 'true' })).toBe(false)
    expect(autobookEnabled({ CALL_CENTER_CALENDAR: 'true', CALL_CENTER_AUTOBOOK: 'true' })).toBe(true)
    expect(clientTextEnabled({})).toBe(false)
  })
  it('rep list comes from config and can be overridden', () => {
    expect(calendarReps({}).length).toBeGreaterThan(0)
    expect(calendarReps({ CALL_CENTER_CALENDAR_REPS: 'rep-a:A,rep-b:B' }).map((r) => r.key)).toEqual(REPS)
  })
})

describe('time zone', () => {
  it('stores UTC for a Pacific wall time, DST aware', () => {
    expect(at(2026, 10, 14, 9).toISOString()).toBe('2026-10-14T16:00:00.000Z')
    expect(at(2026, 12, 1, 9).toISOString()).toBe('2026-12-01T17:00:00.000Z')
    expect(minuteOfDay(at(2026, 12, 1, 17, 30))).toBe(17 * 60 + 30)
  })
})

describe('slot rules', () => {
  const ok = (startsAt: Date, busy: { repKey: string; startsAt: Date }[] = []) => slotProblem({ repKey: 'rep-a', startsAt, now: NOW, busy })
  it('allows 9:00 AM to 5:30 PM PT on 30-minute steps', () => {
    expect(ok(at(2026, 10, 15, 9))).toBeNull()
    expect(ok(at(2026, 10, 15, 17, 30))).toBeNull()
    expect(ok(at(2026, 10, 15, 8, 30))).toMatch(/outside/)
    expect(ok(at(2026, 10, 15, 18))).toMatch(/outside/)
    expect(ok(at(2026, 10, 15, 10, 15))).toMatch(/step/)
  })
  it('needs 2h lead time and at most 5 days ahead', () => {
    expect(ok(at(2026, 10, 14, 9, 30))).toMatch(/2 hours/)
    expect(ok(at(2026, 10, 14, 10))).toBeNull()
    expect(ok(at(2026, 10, 19, 17, 30))).toBeNull()
    expect(ok(at(2026, 10, 20, 9))).toMatch(/5 days/)
  })
  it('keeps 90 minutes between one rep’s visits, other reps unaffected', () => {
    const busy = [{ repKey: 'rep-a', startsAt: at(2026, 10, 15, 12) }]
    expect(ok(at(2026, 10, 15, 13), busy)).toMatch(/already/)
    expect(ok(at(2026, 10, 15, 10, 30), busy)).toBeNull()
    expect(ok(at(2026, 10, 15, 13, 30), busy)).toBeNull()
    expect(slotProblem({ repKey: 'rep-b', startsAt: at(2026, 10, 15, 12), now: NOW, busy })).toBeNull()
  })
  it('respects a rep day off', () => {
    const hours = { 'rep-a': { 4: { startMinute: 540, endMinute: 1050, active: false } } }
    expect(slotProblem({ repKey: 'rep-a', startsAt: at(2026, 10, 15, 9), now: NOW, busy: [], hours })).toMatch(/off/)
  })
  it('lists open slots with no per-day cap, sorted, all valid', () => {
    const slots = openSlots({ reps: REPS, now: NOW, busy: [] })
    expect(slots.length).toBeGreaterThan(50)
    for (let i = 1; i < slots.length; i++) expect(slots[i].startsAt.getTime()).toBeGreaterThanOrEqual(slots[i - 1].startsAt.getTime())
    for (const s of slots) {
      expect(slotProblem({ repKey: s.repKey, startsAt: s.startsAt, now: NOW, busy: [] })).toBeNull()
      expect(s.endsAt.getTime() - s.startsAt.getTime()).toBe(90 * 60_000)
    }
  })
})

describe('eligibility', () => {
  const base = { outOfArea: false, doNotCallAt: null, consentRevokedAt: null }
  it('skips out-of-state, DNC and opted-out leads', () => {
    expect(bookingSkipReason(base)).toBeNull()
    expect(bookingSkipReason({ ...base, outOfArea: true })).toBe('out_of_state')
    expect(bookingSkipReason({ ...base, doNotCallAt: NOW })).toBe('dnc')
    expect(bookingSkipReason({ ...base, suppressed: true })).toBe('dnc')
    expect(bookingSkipReason({ ...base, consentRevokedAt: NOW })).toBe('opted_out')
  })
})

describe('hold and outcomes', () => {
  it('never auto-confirms', () => {
    expect(canConfirm('HOLD', 'autobook')).toBe(false)
    expect(canConfirm('HOLD', 'system')).toBe(false)
    expect(canConfirm('HOLD', 'rep')).toBe(true)
    expect(canConfirm('CONFIRMED', 'rep')).toBe(false)
  })
  it('no-show schedules a call back 2h later', () => {
    const plan = planOutcome('CONFIRMED', 'no-show', NOW)
    expect('error' in plan).toBe(false)
    if (!('error' in plan)) expect(plan.callbackAt?.getTime()).toBe(NOW.getTime() + 2 * 3_600_000)
  })
  it('sat needs a confirmed visit; closed visits stay closed', () => {
    expect(planOutcome('HOLD', 'sat', NOW)).toEqual({ error: 'visit was never confirmed' })
    expect(planOutcome('SAT', 'cancelled', NOW)).toEqual({ error: 'visit already closed' })
    const c = planOutcome('HOLD', 'cancelled', NOW)
    expect(!('error' in c) && c.releasesLead).toBe(true)
  })
})

describe('reminders (planned only, never sent in tests)', () => {
  const slot = (hoursOut: number, over = {}) => ({
    id: 's1',
    status: 'CONFIRMED',
    startsAt: new Date(NOW.getTime() + hoursOut * 3_600_000),
    language: 'EN' as const,
    reminder24RepAt: null,
    reminder24ClientAt: null,
    reminder3RepAt: null,
    reminder3ClientAt: null,
    ...over,
  })
  it('24h window: rep and client, client by email until A2P', () => {
    const jobs = dueReminders([slot(20)], NOW, {})
    expect(jobs.map((j) => `${j.kind}:${j.channel}`)).toEqual(['reminder24RepAt:EMAIL', 'reminder24ClientAt:EMAIL'])
  })
  it('3h window switches the client to text once A2P is approved', () => {
    const jobs = dueReminders([slot(2)], NOW, { CALL_CENTER_A2P_APPROVED: 'true' })
    expect(jobs.map((j) => `${j.kind}:${j.channel}`)).toEqual(['reminder3RepAt:EMAIL', 'reminder3ClientAt:SMS'])
  })
  it('skips sent, far, past and closed visits', () => {
    expect(dueReminders([slot(30)], NOW, {})).toEqual([])
    expect(dueReminders([slot(-1)], NOW, {})).toEqual([])
    expect(dueReminders([slot(2, { status: 'CANCELLED' })], NOW, {})).toEqual([])
    expect(dueReminders([slot(2, { reminder3RepAt: NOW, reminder3ClientAt: NOW })], NOW, {})).toEqual([])
  })
  it('has an ES path and no guarantee language', () => {
    const job = { slotId: 's1', kind: 'reminder24ClientAt' as const, to: 'client' as const, channel: 'EMAIL' as const }
    const en = reminderMessage(job, slot(20), 'Rep', 'lead-1')
    const es = reminderMessage(job, { ...slot(20), language: 'ES' }, 'Rep', 'lead-1')
    expect(es.body).toMatch(/visita/)
    for (const m of [en, es]) expect(`${m.subject} ${m.body}`).not.toMatch(/guarant|garant/i)
  })
})
