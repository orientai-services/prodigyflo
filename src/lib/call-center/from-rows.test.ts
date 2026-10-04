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

  it('shows a stored last-4 as four masked digits', () => {
    const [lead] = callLeadsForDesk([row()])
    expect(lead.last4).toBe('0199')
    expect(phoneLabel(lead)).toBe('···· 0199')
    expect(lead.channel).toBe('form')
    expect(lead.language).toBe('en')
  })
})
