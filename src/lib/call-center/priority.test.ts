import { describe, expect, it } from 'vitest'
import { BOOKED_DETAIL, type CallLead, type TrailEvent } from './model'
import {
  CALLBACK_SOON_MS,
  COLD_AFTER_MS,
  HOT_AFTER_MS,
  callFirst,
  lastTouchAt,
  nextPowerLead,
  rankLead,
  rankLeads,
  span,
  todayBoard,
  todayKpis,
} from './priority'

// Fri Oct 9 2026, 11:00 PDT.
const NOW = new Date('2026-10-09T18:00:00.000Z')
const ME = 'rep-me'
const min = (n: number) => n * 60_000
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString()

function lead(id: string, over: Partial<CallLead> = {}): CallLead {
  return {
    id,
    name: id.toUpperCase(),
    language: 'en',
    channel: 'form',
    contacted: false,
    status: 'waiting',
    last4: '0199',
    zip: null,
    page: 'Solar Contract Services',
    arrivedAt: iso(-min(60)),
    disabled: false,
    recording: null,
    trail: [],
    lockedBy: null,
    persisted: true,
    tries: 0,
    nextAttemptAt: null,
    dnc: false,
    timeZone: 'America/Los_Angeles',
    ...over,
  }
}

const touched = (offsetMs: number): TrailEvent[] => [{ kind: 'outcome', at: iso(offsetMs), label: 'Talked', detail: 'Result recorded' }]

const LEADS: CallLead[] = [
  lead('a-new-fresh', { arrivedAt: iso(-min(2)) }),
  lead('b-new-hot', { arrivedAt: iso(-min(30)) }),
  lead('c-callback-soon', { contacted: true, followUp: 'callback', nextAttemptAt: iso(min(30)), trail: touched(-min(600)) }),
  lead('d-overdue-2h', { contacted: true, tries: 2, status: 'retry', followUp: 'cadence', nextAttemptAt: iso(-min(120)) }),
  lead('e-overdue-10m', { contacted: true, tries: 1, status: 'retry', followUp: 'cadence', nextAttemptAt: iso(-min(10)) }),
  lead('f-cold', { contacted: true, trail: touched(-COLD_AFTER_MS - min(60)), arrivedAt: iso(-COLD_AFTER_MS * 2) }),
  lead('g-warm', { contacted: true, trail: touched(-min(60 * 24)) }),
  lead('h-missed-today', { channel: 'inbound', status: 'missed', missedCallId: 'vc1', missedCallAt: iso(-min(60)) }),
  lead('i-dnc', { dnc: true, status: 'dnc' }),
  lead('j-disabled', { disabled: true }),
  lead('k-booked', { contacted: true, status: 'booked' }),
  lead('k2-booked-callback', { contacted: true, status: 'booked', followUp: 'callback', nextAttemptAt: iso(-min(5)) }),
  lead('l-held-by-other', { arrivedAt: iso(-min(90)), lockedBy: 'rep-other' }),
  lead('m-exhausted', { contacted: true, tries: 7, trail: touched(-COLD_AFTER_MS * 2) }),
  lead('n-callback-later', { contacted: true, followUp: 'callback', nextAttemptAt: iso(min(180)), trail: touched(-min(30)) }),
  lead('o-missed-yesterday', { channel: 'inbound', contacted: true, missedCallId: 'vc2', missedCallAt: iso(-min(60 * 26)), trail: touched(-min(60 * 26)) }),
  lead('p-cadence-not-due', { contacted: true, tries: 1, status: 'retry', followUp: 'cadence', nextAttemptAt: iso(min(4)) }),
]

const byId = (id: string) => LEADS.find((row) => row.id === id) as CallLead

describe('Today ranking', () => {
  it('puts callbacks due within the hour and today’s missed calls first, then new, overdue, cold', () => {
    const ranked = rankLeads(LEADS, NOW, ME)
    expect(ranked.map((row) => [row.lead.id, row.tier])).toEqual([
      ['h-missed-today', 0], // key: missed 1 h ago
      ['k2-booked-callback', 0], // due 5 min ago
      ['c-callback-soon', 0], // due in 30 min
      ['l-held-by-other', 1], // oldest new first
      ['b-new-hot', 1],
      ['a-new-fresh', 1],
      ['d-overdue-2h', 2], // most overdue first
      ['e-overdue-10m', 2],
      ['f-cold', 3],
    ])
  })

  it('leaves out do not call, disabled, booked, warm, exhausted, and not-yet-due leads', () => {
    for (const id of ['i-dnc', 'j-disabled', 'k-booked', 'g-warm', 'm-exhausted', 'n-callback-later', 'o-missed-yesterday', 'p-cadence-not-due']) {
      expect(rankLead(byId(id), NOW, ME)).toBeNull()
    }
  })

  it('says why in one line', () => {
    const why = Object.fromEntries(rankLeads(LEADS, NOW, ME).map((row) => [row.lead.id, row.why]))
    expect(why['h-missed-today']).toBe('Called us at Oct 9, 10:00 AM and we missed it')
    expect(why['c-callback-soon']).toBe('Callback due in 30 min · 11:30 am their time')
    expect(why['k2-booked-callback']).toBe('Callback overdue by 5 min · they asked for 10:55 am their time')
    expect(why['b-new-hot']).toBe('New form, waiting 30 min · hot')
    expect(why['a-new-fresh']).toBe('New form, waiting 2 min')
    expect(why['d-overdue-2h']).toBe('Follow-up overdue by 2 h · try 3 of 7')
    expect(why['f-cold']).toBe('Reached before, nothing for 3 days, no follow-up set')
  })

  it('is hot after five minutes', () => {
    expect(rankLead(lead('x', { arrivedAt: iso(-HOT_AFTER_MS + 1000) }), NOW, ME)?.hot).toBe(false)
    expect(rankLead(lead('x', { arrivedAt: iso(-HOT_AFTER_MS) }), NOW, ME)?.hot).toBe(true)
  })

  it('treats a callback exactly an hour out as due, and one past that as not yet', () => {
    expect(rankLead(lead('x', { contacted: true, followUp: 'callback', nextAttemptAt: iso(CALLBACK_SOON_MS) }), NOW, ME)?.tier).toBe(0)
    expect(rankLead(lead('x', { contacted: true, followUp: 'callback', nextAttemptAt: iso(CALLBACK_SOON_MS + 1000) }), NOW, ME)).toBeNull()
  })

  it('reads an old row with no follow-up marker by its tries', () => {
    // tries 0 + a next attempt = a callback someone set; tries > 0 = the cadence.
    expect(rankLead(lead('x', { contacted: true, nextAttemptAt: iso(min(20)) }), NOW, ME)?.tier).toBe(0)
    expect(rankLead(lead('x', { contacted: true, tries: 2, nextAttemptAt: iso(-min(20)) }), NOW, ME)?.tier).toBe(2)
  })

  it('marks a lead someone else holds as not available, and Call first skips it', () => {
    const ranked = rankLeads(LEADS, NOW, ME)
    expect(ranked.find((row) => row.lead.id === 'l-held-by-other')?.available).toBe(false)
    expect(callFirst(ranked).map((row) => row.lead.id)).toEqual(['h-missed-today', 'k2-booked-callback', 'c-callback-soon'])
    // The same lead is available to the rep who holds it.
    expect(rankLead(byId('l-held-by-other'), NOW, 'rep-other')?.available).toBe(true)
  })

  it('is stable for equal keys', () => {
    const twins = [lead('z2', { arrivedAt: iso(-min(10)) }), lead('z1', { arrivedAt: iso(-min(10)) })]
    expect(rankLeads(twins, NOW, ME).map((row) => row.lead.id)).toEqual(['z1', 'z2'])
  })
})

describe('power mode next lead', () => {
  const ranked = rankLeads(LEADS, NOW, ME)

  it('takes the best available saved lead, minus skips and the one just called', () => {
    const t = NOW.getTime()
    expect(nextPowerLead(ranked, new Set(), null, t)?.lead.id).toBe('h-missed-today')
    expect(nextPowerLead(ranked, new Set(), 'h-missed-today', t)?.lead.id).toBe('k2-booked-callback')
    expect(nextPowerLead(ranked, new Set(['h-missed-today', 'k2-booked-callback']), null, t)?.lead.id).toBe('b-new-hot')
  })

  it('never auto-dials a promised callback early, though Today shows it', () => {
    const t = NOW.getTime()
    // c-callback-soon is due in 30 min: ranked tier 0, but power mode passes it over.
    expect(ranked.find((row) => row.lead.id === 'c-callback-soon')?.tier).toBe(0)
    const skip = new Set(['h-missed-today', 'k2-booked-callback'])
    expect(nextPowerLead(ranked, skip, null, t)?.lead.id).not.toBe('c-callback-soon')
    // Two minutes before its time it is fair game.
    expect(nextPowerLead(ranked.filter((row) => row.lead.id === 'c-callback-soon'), new Set(), null, t + min(28))?.lead.id).toBe('c-callback-soon')
    expect(nextPowerLead(ranked.filter((row) => row.lead.id === 'c-callback-soon'), new Set(), null, t + min(27))).toBeNull()
  })

  it('never auto-dials a seed row and returns null when nothing is left', () => {
    const seeds = rankLeads([lead('s', { persisted: false })], NOW, ME)
    expect(seeds).toHaveLength(1)
    expect(nextPowerLead(seeds, new Set())).toBeNull()
    expect(nextPowerLead([], new Set())).toBeNull()
  })
})

describe('Today queues and numbers', () => {
  it('fills the four queues', () => {
    const board = todayBoard(LEADS, NOW, ME)
    expect(board.queues.callbacks.map((item) => item.lead.id)).toEqual([
      'h-missed-today',
      'k2-booked-callback',
      'c-callback-soon',
      'o-missed-yesterday',
      'n-callback-later',
    ])
    expect(board.queues.callbacks.find((item) => item.lead.id === 'n-callback-later')?.why).toBe('Callback Fri, Oct 9, 2:00 pm their time')
    expect(board.queues.due.map((item) => item.lead.id)).toEqual(['d-overdue-2h', 'e-overdue-10m', 'k2-booked-callback'])
    expect(board.queues.due[0].why).toBe('Due since Oct 9, 9:00 AM · try 3 of 7')
    expect(board.queues.fresh.map((item) => item.lead.id)).toEqual(['l-held-by-other', 'b-new-hot', 'a-new-fresh'])
    expect(board.queues.fresh.map((item) => item.hot)).toEqual([true, true, false])
    expect(board.queues.cold.map((item) => item.lead.id)).toEqual(['f-cold', 'm-exhausted'])
    expect(board.queues.cold[1].why).toMatch(/^No further tries/)
  })

  it('counts new, due, booked today, and calls today', () => {
    const today = '2026-10-09T17:30:00.000Z'
    const yesterday = '2026-10-08T17:30:00.000Z'
    const rows = [
      ...LEADS,
      lead('q-booked-today', {
        contacted: true,
        status: 'booked',
        trail: [
          { kind: 'call', at: today, label: 'Call', detail: 'Connected · 2:00' },
          { kind: 'outcome', at: today, label: 'Appointment', detail: BOOKED_DETAIL },
        ],
      }),
      lead('r-booked-yesterday', {
        contacted: true,
        status: 'booked',
        trail: [
          { kind: 'call', at: yesterday, label: 'Call', detail: 'Connected · 2:00' },
          { kind: 'inbound', at: today, label: 'Inbound call', detail: 'Called the ad number' },
          { kind: 'outcome', at: yesterday, label: 'Talked', detail: BOOKED_DETAIL },
        ],
      }),
    ]
    expect(todayKpis(rows, NOW)).toEqual({
      // a, b, h, l (do-not-call, disabled and booked are left out)
      newNotContacted: 4,
      // d, e, k2
      followUpsDue: 3,
      bookedToday: 1,
      callsToday: 2,
    })
  })

  it('uses the desk day (Los Angeles) for "today"', () => {
    // 23:30 PDT on Oct 9 is Oct 10 in UTC, still today on the desk.
    const late = new Date('2026-10-10T06:30:00.000Z')
    const row = lead('late', { trail: [{ kind: 'call', at: '2026-10-09T16:00:00.000Z', label: 'Call', detail: 'No answer' }] })
    expect(todayKpis([row], late).callsToday).toBe(1)
  })
})

describe('helpers', () => {
  it('words a span of time', () => {
    expect(span(30_000)).toBe('under a minute')
    expect(span(min(59))).toBe('59 min')
    expect(span(min(60 * 47))).toBe('47 h')
    expect(span(min(60 * 72))).toBe('3 days')
  })

  it('takes the newest real touch, not locks or the form', () => {
    const row = lead('t', {
      arrivedAt: '2026-10-01T00:00:00.000Z',
      trail: [
        { kind: 'form', at: '2026-10-01T00:00:00.000Z', label: 'Facebook form', detail: '' },
        { kind: 'sms', at: '2026-10-03T00:00:00.000Z', label: 'Text', detail: '' },
        { kind: 'lock', at: '2026-10-08T00:00:00.000Z', label: 'Lock', detail: '' },
      ],
    })
    expect(new Date(lastTouchAt(row)).toISOString()).toBe('2026-10-03T00:00:00.000Z')
  })
})
