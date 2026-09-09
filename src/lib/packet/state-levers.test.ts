import { describe, expect, it } from 'vitest'
import { federalLevers, leverFor, STATE_LEVERS } from './state-levers'

const CODES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM',
  'NY','NC','ND','OH','OK','OR','PA','PR','RI','SC','SD','TN','TX','UT','VT','VA',
  'WA','WV','WI','WY',
]

describe('STATE_LEVERS', () => {
  it('covers all 50 states plus DC and PR', () => {
    expect(Object.keys(STATE_LEVERS).sort()).toEqual([...CODES].sort())
  })

  it('gives every state a contractor desk, AG, UDAP, and a cooling-off window', () => {
    for (const code of CODES) {
      const s = leverFor(code)
      expect(s.coolingOffBusinessDays).toBeGreaterThanOrEqual(3)
      expect(s.contractorBoard.length).toBeGreaterThan(8)
      expect(s.ag.length).toBeGreaterThan(8)
      expect(s.udap.length).toBeGreaterThan(8)
    }
  })

  it('does not fall back to Nevada when the state is unknown — it labels unknown', () => {
    const s = leverFor('')
    expect(s.contractorBoard).not.toMatch(/Nevada State Contractors Board/)
    expect(s.name).toMatch(/Unknown|State/)
  })
})

describe('federalLevers', () => {
  it('always stacks FTC cooling-off, and TILA + Holder on financed files', () => {
    const lines = federalLevers({
      product: 'loan',
      hasFinance: true,
      inHomeOrTablet: true,
      coolingOffExpired: true,
      saleOrRefi: false,
    }).join('\n')
    expect(lines).toMatch(/16 CFR 429/)
    expect(lines).toMatch(/TILA/)
    expect(lines).toMatch(/1635/)
    expect(lines).toMatch(/Holder/)
    expect(lines).toMatch(/dwelling/)
  })
})
