import { describe, expect, it } from 'vitest'
import { composeCloserWinBrief } from './closer-win'
import { composeMasterCallSheet } from './call-sheet'
import { clientReviewPacket } from './call-pdf-model'

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
    expect(sheet.sections[3]!.facts.find(fact => fact.label === 'Before')?.value).toBe('Not on file')
    expect(sheet.sections[3]!.say).not.toMatch(/\$1,288|Duke/)
    expect(JSON.stringify(sheet)).not.toMatch(/1,288|66,812|Duke|Anderson_Master/)
    expect(sheet.sections.find(section => section.title === 'The money')?.facts.find(fact => fact.label === 'Working figure')?.value).toBe('MISSING')
    expect(sheet.sections.find(section => section.title === 'Where we go' || section.title === 'Two options')?.facts.find(fact => fact.label === 'File')?.value).toMatch(/remaining balance is on this file/)
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

  it('uses the remaining balance as the working figure and 30% as the fee, and fills before and after from intake when no bill was uploaded', () => {
    const input = {
      ...base,
      firstName: 'Aletha',
      lastName: 'Boykins',
      city: 'North Las Vegas',
      state: 'NV',
      product: 'loan',
      lender: '',
      installer: 'Titan Solar Power NV, Inc.',
      monthly: '350',
      payoff: '24537.52',
      payoffEstimated: true,
      utilityMonthly: '136.69',
      utilityFromDocument: false,
      payingBoth: true,
      financierOnInstall: 'GoodLeap',
      hasUtility: false,
      flags: [],
      painType: '',
    }
    const sheet = composeMasterCallSheet(input)
    const moneyFacts = sheet.sections.find(section => section.title === 'The money')?.facts
    expect(moneyFacts?.find(fact => fact.label === 'Working figure')?.value).toBe('$24,537.52')
    expect(moneyFacts?.find(fact => fact.label === 'Agreed processing fee')?.value).toBe('$7,361.26')
    const bills = sheet.sections.find(section => section.title === 'Reality check')
    expect(bills?.facts.find(fact => fact.label === 'Before')?.value).toMatch(/entered in intake: \$136\.69/)
    expect(bills?.facts.find(fact => fact.label === 'After')?.value).toMatch(/Solar payment: \$350\.00/)
    expect(bills?.facts.find(fact => fact.label === 'After')?.value).toMatch(/\$136\.69/)
    const next = sheet.sections.find(section => section.title === 'Two options')
    expect(next?.facts.find(fact => fact.label === 'Stay')?.value).toMatch(/\$24,537\.52/)
    expect(next?.facts.find(fact => fact.label === 'File')?.value).toMatch(/\$7,361\.26/)
    const review = clientReviewPacket(input)
    expect(review.pages[4]).toMatch(/Before:/)
    expect(review.pages[6]).toMatch(/Where We Go From Here/)
    expect(review.pages[6]).toMatch(/\$7,361\.26/)
    expect(review.pages.join('\n')).not.toMatch(/66,812|20,043/)
  })

  it('leaves the before card empty when no bill was uploaded and none was typed', () => {
    const sheet = composeMasterCallSheet({ ...base, product: 'loan', monthly: '350', payoff: '1000', utilityMonthly: '', payingBoth: false, flags: [], painType: '' })
    expect(sheet.sections.find(section => section.title === 'Reality check')?.facts.find(fact => fact.label === 'Before')?.value).toBe('Not on file')
    expect(sheet.sections.find(section => section.title === 'The money')?.facts.find(fact => fact.label === 'Agreed processing fee')?.value).toBe('$300.00')
  })

  it('does not cite a state statute when the property state is missing', () => {
    const rights = composeCloserWinBrief({ ...base, state: '', flags: ['tax_credit_drop'] }).rights
    expect(rights.state.join(' ')).toMatch(/missing/i)
    expect(rights.state.join(' ')).not.toMatch(/FDUTPA|Nevada/)
    expect(rights.federal.join(' ')).toMatch(/FTC Cooling-Off/)
  })
})
