import { describe, expect, it } from 'vitest'
import { composeCloserWinBrief } from './closer-win'

const base = {
  firstName: 'William',
  lastName: 'Anderson',
  city: 'Clearwater',
  state: 'FL',
  product: 'lease',
  lender: 'SunPower Capital, LLC',
  installer: 'Evolution Power LLC',
  monthly: '297.11',
  termMonths: '300',
  apr: '',
  contractValue: '',
  payoff: '',
  signedDate: '2024-05-18',
  painType: 'bills-didnt-drop',
  painNarrative: '',
  saleOrRefi: 'no',
  flags: ['tax_credit_drop', 'promised_offset'] as string[],
  hasContract: true,
  hasFinance: false,
  hasStatement: false,
  hasPayoff: false,
  hasUtility: false,
  hasProposal: false,
  closeability: 'B' as const,
  path: 'scs_closer' as const,
  trench: '40_59' as const,
  ready: false,
  missing: ['utility_bill'],
}

describe('master call sheet and rights poster', () => {
  it('builds a Florida lease sheet from the file and does not invent another client’s bills', () => {
    const sheet = composeCloserWinBrief(base).callSheet
    expect(sheet.opening).toMatch(/^William, thanks for the time/)
    expect(sheet.sections.map((s) => s.title)).toEqual([
      'What you signed',
      'What changed',
      'The money',
      'Reality check',
      'Two options',
    ])
    const signed = sheet.sections[0]!
    expect(signed.facts.find((f) => f.label === 'Counterparty')?.value).toBe('SunPower Capital, LLC')
    expect(signed.facts.find((f) => f.label === 'Payment on file')?.value).toBe('$297.11')
    expect(sheet.sections[3]!.say).toMatch(/MISSING/)
    expect(JSON.stringify(sheet)).not.toMatch(/1,288|66,812|Duke|Anderson_Master/)
    expect(sheet.disclaimer).toMatch(/Not legal advice/)
  })

  it('puts only this client’s state and federal consumer rights on the poster', () => {
    const florida = composeCloserWinBrief(base).rights
    const poster = [...florida.state, ...florida.federal].join('\n')
    expect(poster).toMatch(/FDUTPA/)
    expect(poster).toMatch(/Florida DBPR/)
    expect(poster).toMatch(/TILA/)
    expect(poster).toMatch(/Holder Rule/)
    expect(poster).not.toMatch(/Nevada|California CSLB/)

    const nevada = composeCloserWinBrief({
      ...base,
      firstName: 'Eric',
      lastName: 'Strange',
      city: 'Las Vegas',
      state: 'NV',
      product: 'loan',
      flags: [],
      painType: '',
    }).rights
    const nevadaPoster = [...nevada.state, ...nevada.federal].join('\n')
    expect(nevadaPoster).toMatch(/Nevada/)
    expect(nevadaPoster).not.toMatch(/FDUTPA|Florida DBPR/)
  })

  it('does not cite a state statute when the property state is missing', () => {
    const rights = composeCloserWinBrief({ ...base, state: '', flags: ['tax_credit_drop'] }).rights
    expect(rights.state.join(' ')).toMatch(/missing/i)
    expect(rights.state.join(' ')).not.toMatch(/FDUTPA|Nevada/)
    expect(rights.federal.join(' ')).toMatch(/FTC Cooling-Off/)
  })
})
