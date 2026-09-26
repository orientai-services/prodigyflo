import { describe, expect, it } from 'vitest'
import { composeMasterCallSheet } from './call-sheet'
import { partyStatus } from './party-status'
import type { CloserWinInput } from './closer-win'

const base: CloserWinInput = {
  firstName: 'Sample',
  lastName: 'Homeowner',
  city: 'Las Vegas',
  state: 'NV',
  product: 'loan',
  lender: '',
  installer: '',
  monthly: '350',
  termMonths: '300',
  apr: '2.99',
  contractValue: '36819.55',
  payoff: '',
  signedDate: '2022-12-12',
  painType: '',
  painNarrative: '',
  saleOrRefi: 'no',
  flags: [],
  hasContract: true,
  hasFinance: false,
  hasStatement: false,
  hasPayoff: false,
  hasUtility: false,
  hasProposal: false,
  closeability: 'B',
  path: 'scs_closer',
  trench: '40_59',
  ready: false,
  missing: [],
}

describe('party status registry', () => {
  it('puts Titan Solar Power NV in the Arizona Chapter 7 cases', () => {
    const found = partyStatus('Titan Solar Power NV, Inc.')
    expect(found?.standing).toBe('chapter7')
    expect(found?.record).toMatch(/2:24-bk-05025-MCW/)
    expect(found?.record).toMatch(/2:24-bk-04978-MCW/)
    expect(found?.record).toMatch(/does not by itself cancel/)
  })

  it('keeps GoodLeap as no filing, and does not treat Loanpal as a different company', () => {
    expect(partyStatus('GoodLeap')?.standing).toBe('operating')
    expect(partyStatus('Loanpal')?.record).toMatch(/earlier name/)
    expect(partyStatus('GoodLeap')?.record).not.toMatch(/Chapter 7/)
  })

  it('uses the SunPower Corporation case for a SunPower Capital lease', () => {
    const found = partyStatus('SunPower Capital, LLC')
    expect(found?.standing).toBe('chapter11_wound_down')
    expect(found?.record).toMatch(/24-11649/)
    expect(found?.record).toMatch(/not a finding that this client’s contract was assumed/)
  })

  it('does not invent a bankruptcy for an unknown installer', () => {
    expect(partyStatus('Evolution Power LLC')).toBeNull()
    expect(partyStatus('One Solar')).toBeNull()
  })

  it('prints Titan and GoodLeap on the case sheet without calling GoodLeap bankrupt', () => {
    const sheet = composeMasterCallSheet({
      ...base,
      installer: 'Titan Solar Power NV, Inc.',
      financierOnInstall: 'GoodLeap',
    })
    const changed = sheet.sections.find(section => section.title === 'What changed')
    expect(changed?.say).toMatch(/2:24-bk-05025-MCW/)
    expect(changed?.say).toMatch(/No bankruptcy of GoodLeap/)
    expect(changed?.facts.find(fact => fact.label === 'Installer status')?.value).toMatch(/Chapter 7/)
    expect(changed?.facts.find(fact => fact.label === 'Financier status')?.value).toMatch(/No filing/)
  })

  it('leaves an unknown pair unconfirmed', () => {
    const sheet = composeMasterCallSheet({ ...base, installer: 'Evolution Power LLC', lender: 'Example Credit Union' })
    const changed = sheet.sections.find(section => section.title === 'What changed')
    expect(changed?.say).toMatch(/Do not invent a bankruptcy/)
    expect(changed?.say).not.toMatch(/Chapter 7|Chapter 11/)
  })
})
