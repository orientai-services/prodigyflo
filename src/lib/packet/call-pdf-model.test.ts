import { describe, expect, it } from 'vitest'
import type { CloserWinInput } from './closer-win'
import { clientReviewPacket, closerPitchPacket, reviewLeaksCloserScript } from './call-pdf-model'
import { renderCallPacket } from './call-pdf-render'

const florida: CloserWinInput = {
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
  painType: '',
  painNarrative: '',
  saleOrRefi: 'no',
  flags: ['tax_credit_drop'],
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

describe('case review and closer pitch', () => {
  it('keeps the closer script off the case review and names Florida FDUTPA on a Florida file', () => {
    const review = clientReviewPacket(florida)
    expect(review.pages).toHaveLength(8)
    expect(review.pages[0]).toMatch(/Your Case Review/)
    expect(review.pages[5]).toMatch(/Three Facts Counsel Will Use/)
    expect(review.pages[5]).toMatch(/FDUTPA/)
    expect(review.pages.join('\n')).toMatch(/What You Signed/)
    expect(review.pages.join('\n')).toMatch(/Documents We Still Need/)
    expect(reviewLeaksCloserScript(review)).toEqual([])
    expect(review.pages.join('\n')).not.toMatch(/66,812|1,288/)
    const assigned = clientReviewPacket({ ...florida, closerName: 'Alex Rivera', closerTitle: 'Closer' })
    expect(assigned.pages.join('\n')).toMatch(/Alex Rivera/)
    expect(assigned.pages.join('\n')).not.toMatch(/Gatsby/)
    const pitch = closerPitchPacket({ ...florida, closerName: 'Alex Rivera' })
    expect(pitch.pages.join('\n')).toMatch(/Alex Rivera/)
    expect(pitch.pages.join('\n')).not.toMatch(/Gatsby/)
  })

  it('names Nevada on a Nevada pitch and does not cite FDUTPA', () => {
    const pitch = closerPitchPacket({ ...florida, state: 'NV', city: 'Las Vegas', firstName: 'Eric', lastName: 'Strange', flags: [] })
    const text = pitch.pages.join('\n')
    expect(text).toMatch(/This sheet stays on your screen/)
    expect(text).toMatch(/Nevada/)
    expect(text).not.toMatch(/FDUTPA/)
    expect(text).toMatch(/STOP after the ask/)
  })

  it('renders both packets as PDFs', async () => {
    const review = await renderCallPacket(clientReviewPacket(florida))
    const pitch = await renderCallPacket(closerPitchPacket(florida))
    expect(Buffer.from(review).subarray(0, 4).toString()).toBe('%PDF')
    expect(Buffer.from(pitch).subarray(0, 4).toString()).toBe('%PDF')
  })
})
