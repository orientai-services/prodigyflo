import { describe, expect, it } from 'vitest'
import { composeCloserWinBrief } from './closer-win'

/** Fixture from grok-chat (3).json — Powur / Sunlight / Eric Strange. Only fields a packet could actually hold. */
const strange = {
  firstName: 'Eric',
  lastName: 'Strange',
  city: 'Las Vegas',
  state: 'NV',
  product: 'loan',
  lender: 'Sunlight Financial',
  installer: 'Powur',
  monthly: '227.54',
  termMonths: '300',
  apr: '3.99',
  contractValue: '59823',
  payoff: '',
  signedDate: '2023-05-17',
  painType: 'bills-didnt-drop',
  painNarrative: '',
  saleOrRefi: 'no',
  flags: ['promised_offset'] as string[],
  hasContract: true,
  hasFinance: false,
  hasStatement: false,
  hasPayoff: false,
  hasUtility: false,
  hasProposal: false,
  closeability: 'B' as const,
  path: 'tradebloc_dc_capital' as const,
  trench: '40_59' as const,
  ready: false,
  missing: ['lender_confirmed'],
}

describe('composeCloserWinBrief', () => {
  it('opens from packet facts and treats the 3-day as gone on a 2023 signing', () => {
    const b = composeCloserWinBrief(strange)
    expect(b.situation).toMatch(/Eric Strange/)
    expect(b.situation).toMatch(/Sunlight/)
    expect(b.situation).toMatch(/\$227\.54/)
    expect(b.closeTalk).toMatch(/cooling-off is gone/)
    expect(b.redline.some((l) => /cooling-off/i.test(l) && /gone/i.test(l))).toBe(true)
    expect(b.redline.some((l) => /Nevada State Contractors Board/i.test(l))).toBe(true)
    expect(b.redline.some((l) => /TILA/i.test(l))).toBe(true)
    expect(b.redline.some((l) => /Holder Rule/i.test(l))).toBe(true)
  })

  it('routes Sunlight to the distressed-lender path, not a cooling-off story', () => {
    const b = composeCloserWinBrief(strange)
    expect(b.cancelPath[0]).toMatch(/Tradebloc/)
    expect(b.whyThisFile.some((l) => /Sunlight/i.test(l))).toBe(true)
  })

  it('never invents payoff, remaining principal, or six-figure cash', () => {
    const b = composeCloserWinBrief(strange)
    const blob = `${b.situation}\n${b.closeTalk}\n${b.outcomeCeiling}\n${b.fileFacts.join('\n')}`
    expect(blob).toMatch(/payoff: MISSING/i)
    expect(blob).toMatch(/Do not quote remaining principal/)
    expect(blob).not.toMatch(/mid-to-high \$50/)
    expect(blob).not.toMatch(/264/)
    expect(blob).not.toMatch(/sometimes six figures/i)
    expect(b.missingForCeiling.some((m) => /payoff/i.test(m))).toBe(true)
  })

  it('labels best-case as a target, not a promise', () => {
    const b = composeCloserWinBrief(strange)
    expect(b.outcomeCeiling).toMatch(/not a promise/)
    expect(b.talkingPoints.join(' ')).toMatch(/Do not Dashboard/)
  })

  it('blocks cancel talk on a C file with no instrument', () => {
    const b = composeCloserWinBrief({
      ...strange,
      hasContract: false,
      hasFinance: false,
      closeability: 'C',
      path: 'collection',
      ready: false,
      missing: ['signed_agreement'],
    })
    expect(b.closeTalk).toMatch(/signed agreement/)
    expect(b.recommendedNextStep).toMatch(/signed agreement/)
    expect(b.redline[0]).toMatch(/C file/)
  })

  it('does not invent APR when the finance page is missing', () => {
    const b = composeCloserWinBrief({ ...strange, apr: '' })
    expect(b.fileFacts.join('\n')).toMatch(/APR: MISSING/)
    expect(b.missingForCeiling.some((m) => /APR/i.test(m))).toBe(true)
  })

  it('tailors the state desk to California, not Nevada', () => {
    const b = composeCloserWinBrief({ ...strange, state: 'CA', city: 'Fresno' })
    const red = b.redline.join('\n')
    expect(red).toMatch(/CSLB/)
    expect(red).not.toMatch(/Nevada State Contractors Board/)
    expect(red).toMatch(/TILA/)
    expect(b.cancelPath.join('\n')).toMatch(/California/)
  })

  it('uses Texas DTPA / TDLR for a TX file', () => {
    const b = composeCloserWinBrief({ ...strange, state: 'TX', city: 'Houston', path: 'scs_closer' })
    const blob = `${b.redline.join('\n')}\n${b.cancelPath.join('\n')}`
    expect(blob).toMatch(/DTPA/)
    expect(blob).toMatch(/TDLR|Texas AG/)
    expect(blob).not.toMatch(/Nevada State Contractors Board/)
  })

  it('does not treat TILA rescission as automatic on an equipment loan', () => {
    const b = composeCloserWinBrief(strange)
    expect(b.redline.join('\n')).toMatch(/dwelling-secured/)
    expect(b.redline.join('\n')).toMatch(/do not assume Holder/i)
  })
})
