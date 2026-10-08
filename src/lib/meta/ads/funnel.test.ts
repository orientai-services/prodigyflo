import { describe, expect, it } from 'vitest'
import { attributionBroken, attributionDoubt, buildFunnelRows, cascade } from './funnel'
import { classifyTouch, parseStoredAttribution } from './touches'

describe('funnel', () => {
  it('stages cascade: sold ⇒ sat ⇒ booked ⇒ contacted', () => {
    expect(cascade({ contacted: false, booked: false, sat: false, sold: true, revenue: 100 })).toEqual({ contacted: true, booked: true, sat: true, sold: true, revenue: 100 })
    expect(cascade({ contacted: false, booked: true, sat: false, sold: false, revenue: 50 })).toEqual({ contacted: true, booked: true, sat: false, sold: false, revenue: 0 })
  })
  it('rows by ad with costs and ROAS (null on zero)', () => {
    const rows = buildFunnelRows({
      touches: [
        { adId: 'a1', outcomeKey: 'c:1' }, { adId: 'a1', outcomeKey: 'c:2' }, { adId: 'a1', outcomeKey: 'l:3' }, { adId: 'a2', outcomeKey: 'c:4' },
      ],
      outcomes: new Map([
        ['c:1', { contacted: true, booked: true, sat: true, sold: true, revenue: 5000 }],
        ['c:2', { contacted: true, booked: false, sat: false, sold: false, revenue: 0 }],
        ['l:3', { contacted: true, booked: true, sat: false, sold: false, revenue: 0 }],
      ]),
      ads: new Map([['a1', { name: 'Ad one', campaignName: 'C' }], ['a2', { name: 'Ad two', campaignName: 'C' }], ['a3', { name: 'Ad three', campaignName: 'C' }]]),
      spend: new Map([['a1', { spend: 300, metaLeads: 3 }], ['a2', { spend: 100, metaLeads: 6 }], ['a3', { spend: 50, metaLeads: 0 }]]),
    })
    const a1 = rows.find((r) => r.adExternalId === 'a1')!
    expect(a1).toMatchObject({ leads: 3, contacted: 3, booked: 2, sat: 1, sold: 1, revenue: 5000, costPerLead: 100, costPerBooked: 150, costPerSat: 300, costPerSale: 300 })
    expect(a1.roas).toBeCloseTo(16.667, 2)
    const a2 = rows.find((r) => r.adExternalId === 'a2')!
    expect(a2.costPerBooked).toBeNull()
    expect(a2.attributionDoubt).toBe(true) // 1 vs 6
    expect(rows.find((r) => r.adExternalId === 'a3')).toMatchObject({ leads: 0, costPerLead: null, roas: 0 })
    expect(rows.map((r) => r.adExternalId)).toEqual(['a1', 'a2', 'a3'])
  })
  it('attribution doubt threshold', () => {
    expect(attributionDoubt(10, 9)).toBe(false)
    expect(attributionDoubt(10, 7)).toBe(true)
    expect(attributionDoubt(1, 0)).toBe(false)
    expect(attributionDoubt(2, 0)).toBe(true)
  })
  it('broken fingerprint: one ad holds most CRM leads but few Meta leads', () => {
    expect(attributionBroken([{ leads: 9, metaLeads: 1 }, { leads: 1, metaLeads: 9 }])).toBe(true)
    expect(attributionBroken([{ leads: 5, metaLeads: 5 }, { leads: 5, metaLeads: 5 }])).toBe(false)
    expect(attributionBroken([{ leads: 3, metaLeads: 0 }, { leads: 0, metaLeads: 3 }])).toBe(false) // too few
  })
})

describe('lead touches (pure)', () => {
  const stored = (over: Record<string, unknown> = {}) => ({ provider: 'meta', leadgenId: 'lg1', adId: '6300000111', adsetId: '6200000011', campaignId: '6100000001', formId: 'f1', platform: 'fb', isOrganic: false, capturedAt: '2026-10-07T16:00:00Z', ...over })
  const ACC = ['act_1742876583597558']

  it('parses ids and ignores names', () => {
    const p = parseStoredAttribution(stored({ campaignName: 'secret' }))!
    expect(p).toMatchObject({ leadgenId: 'lg1', adId: '6300000111', platform: 'fb' })
    expect(JSON.stringify(p)).not.toContain('secret')
    expect(parseStoredAttribution({ provider: 'google' })).toBeNull()
    expect(parseStoredAttribution(stored({ leadgenId: '' }))).toBeNull()
  })
  it('matched / outside / unmatched / pending', () => {
    const a = parseStoredAttribution(stored())
    expect(classifyTouch(a, { local: ACC[0], cached: null, probe: null }, ACC).status).toBe('matched')
    expect(classifyTouch(a, { local: null, cached: { outside: false, adAccountId: ACC[0] }, probe: null }, ACC).status).toBe('matched')
    expect(classifyTouch(a, { local: null, cached: { outside: true, adAccountId: null }, probe: null }, ACC)).toEqual({ status: 'outside', adAccountId: null })
    expect(classifyTouch(a, { local: null, cached: null, probe: null }, ACC).status).toBe('pending')
    expect(classifyTouch(a, { local: null, cached: null, probe: 'allowed' }, ACC).status).toBe('matched')
  })
  it('permission, 100/33 and missing all count as outside (fail closed)', () => {
    const a = parseStoredAttribution(stored())
    for (const probe of ['no_access', 'not_found', 'other_account'] as const) {
      expect(classifyTouch(a, { local: null, cached: null, probe }, ACC).status).toBe('outside')
    }
    // A local ad of a different account is not a match either.
    expect(classifyTouch(a, { local: 'act_999000111222333', cached: null, probe: 'other_account' }, ACC).status).toBe('outside')
  })
  it('leads from before attribution was captured are unmatched', () => {
    expect(classifyTouch(null, { local: null, cached: null, probe: null }, ACC).status).toBe('unmatched')
    expect(classifyTouch(parseStoredAttribution(stored({ adId: null })), { local: null, cached: null, probe: null }, ACC).status).toBe('unmatched')
  })
})

describe('lead touches: tentative ownership answers', () => {
  const ACC = ['act_1742876583597558']
  const a = parseStoredAttribution({ provider: 'meta', leadgenId: 'lg2', adId: '6300000111', capturedAt: '2026-10-07T16:00:00Z' })
  it('a cached no_access / not_found that is not final keeps the touch pending (retried later)', () => {
    expect(classifyTouch(a, { local: null, cached: { outside: true, adAccountId: null, final: false }, probe: null }, ACC)).toEqual({ status: 'pending', adAccountId: null })
  })
  it('a final cached answer is outside, and a later allowed answer still matches', () => {
    expect(classifyTouch(a, { local: null, cached: { outside: true, adAccountId: null, final: true }, probe: null }, ACC).status).toBe('outside')
    expect(classifyTouch(a, { local: null, cached: { outside: false, adAccountId: ACC[0], final: false }, probe: null }, ACC).status).toBe('matched')
  })
})
