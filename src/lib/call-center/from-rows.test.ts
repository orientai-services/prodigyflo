import { describe, expect, it } from 'vitest'
import { phoneLabel, seedLeads } from './model'
import { callLeadsForDesk, type StoredCallCenterLead } from './from-rows'
import { facebookFormEventBody } from './meta-route'

function row(overrides: Partial<StoredCallCenterLead> = {}): StoredCallCenterLead {
  return {
    id: 'meta:org:lg-1',
    pageId: '1333173556539688',
    source: 'FORM',
    language: 'EN',
    status: 'WAITING',
    tries: 0,
    nextAttemptAt: null,
    lockedBy: null,
    doNotCallAt: null,
    phoneLast4: '0199',
    createdAt: new Date('2026-10-03T18:00:00.000Z'),
    events: [
      {
        type: 'FORM',
        body: facebookFormEventBody({ leadgenId: 'lg-1', name: 'Pat Example', zip: '89117' }),
        createdAt: new Date('2026-10-03T18:00:00.000Z'),
      },
    ],
    ...overrides,
  }
}

describe('call center rows on the desk', () => {
  it('keeps the dummy seed only when the table is empty', () => {
    const seeded = callLeadsForDesk([])
    expect(seeded.map((lead) => lead.name)).toEqual(seedLeads().map((lead) => lead.name))
    expect(seeded.some((lead) => lead.name === 'Mara Ellison')).toBe(true)
  })

  it('shows a real Facebook lead and only the last four digits', () => {
    const [lead] = callLeadsForDesk([row({ phoneLast4: '7025550199' })])
    expect(lead.name).toBe('Pat Example')
    expect(lead.zip).toBe('89117')
    expect(lead.page).toBe('Solar Contract Services')
    expect(lead.last4).toBeNull()
    expect(phoneLabel(lead)).toBe('—')
    expect(lead.trail[0]).toMatchObject({ kind: 'form', label: 'Facebook form' })
    expect(JSON.stringify(lead)).not.toContain('7025550199')
    expect(JSON.stringify(lead)).not.toContain('Mara Ellison')
  })

  it('reads the follow-up kind and the reached flag from the trail', () => {
    const at = new Date('2026-10-03T18:10:00.000Z')
    const call = (body: Record<string, unknown>) => ({ type: 'CALL', body: JSON.stringify({ label: 'Call', ...body }), createdAt: at })
    // A carrier no-answer counted a try: not reached, cadence follow-up.
    const [cadence] = callLeadsForDesk([
      row({ tries: 1, nextAttemptAt: new Date('2026-10-03T18:15:00.000Z'), events: [call({ detail: 'No answer', voiceCallId: 'vc1', followUp: 'cadence' })] }),
    ])
    expect(cadence.followUp).toBe('cadence')
    expect(cadence.trail.at(-1)?.followUp).toBe('cadence')
    // A callback the rep set.
    const [callback] = callLeadsForDesk([
      row({
        nextAttemptAt: new Date('2026-10-05T18:00:00.000Z'),
        events: [{ type: 'OUTCOME', body: JSON.stringify({ label: 'Callback', detail: 'Call back', followUp: 'callback' }), createdAt: at }],
      }),
    ])
    expect(callback.followUp).toBe('callback')
    expect(callback.contacted).toBe(true)
    // A result that never arrived is not contact.
    const [unknown] = callLeadsForDesk([row({ events: [call({ detail: 'Call result unknown', voiceCallId: 'vc2' })] })])
    expect(unknown.contacted).toBe(false)
    // An answered call of 20 s or more is.
    const [reached] = callLeadsForDesk([row({ events: [call({ detail: 'Connected · 0:45', voiceCallId: 'vc3', connected: true })] })])
    expect(reached.contacted).toBe(true)
    expect(reached.trail.at(-1)?.connected).toBe(true)
    // A short pick-up counted as a no-answer is not.
    const [short] = callLeadsForDesk([row({ events: [call({ detail: 'Connected · 0:05', voiceCallId: 'vc4', followUp: 'cadence' })] })])
    expect(short.contacted).toBe(false)
    // Rows from before the marker: a "Connected" carrier line still counts.
    const [legacy] = callLeadsForDesk([row({ events: [call({ detail: 'Connected · 1:10', voiceCallId: 'vc5' })] })])
    expect(legacy.contacted).toBe(true)
  })

  it('carries the missed call time with its id', () => {
    const [lead] = callLeadsForDesk([row()], null, undefined, {
      missedByLead: new Map([['meta:org:lg-1', 'vc9']]),
      missedAtByLead: new Map([['meta:org:lg-1', '2026-10-03T18:20:00.000Z']]),
    })
    expect(lead.missedCallId).toBe('vc9')
    expect(lead.missedCallAt).toBe('2026-10-03T18:20:00.000Z')
  })

  it('shows a stored last-4 as four masked digits', () => {
    const [lead] = callLeadsForDesk([row()])
    expect(lead.last4).toBe('0199')
    expect(phoneLabel(lead)).toBe('···· 0199')
    expect(lead.channel).toBe('form')
    expect(lead.language).toBe('en')
  })
})
