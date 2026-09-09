import { describe, expect, it } from 'vitest'
import { evaluateFloorAudit, hasCloserWinBrief } from './floor-audit'
import { composeCloserWinBrief, formatCloserWinBrief } from './closer-win'

const brief = formatCloserWinBrief(
  composeCloserWinBrief({
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
    flags: [],
    hasContract: true,
    hasFinance: true,
    hasStatement: false,
    hasPayoff: false,
    hasUtility: false,
    hasProposal: false,
    closeability: 'A',
    path: 'tradebloc_dc_capital',
    trench: '40_59',
    ready: true,
    missing: [],
  }),
)

describe('floor manager audit', () => {
  it('requires the closer-win brief in the audit packet before READY', () => {
    expect(hasCloserWinBrief('short note')).toBe(false)
    expect(hasCloserWinBrief(brief)).toBe(true)
    const r = evaluateFloorAudit({
      dataReady: true,
      closeability: 'A',
      brief: 'not a brief',
      closerApproved: false,
    })
    expect(r.floorStampedReady).toBe(false)
    expect(r.strawberryMayRun).toBe(false)
    expect(r.holdReason).toMatch(/brief/)
  })

  it('stamps READY for the closer but holds Strawberry until the closer says YES', () => {
    const r = evaluateFloorAudit({
      dataReady: true,
      closeability: 'A',
      brief,
      closerApproved: false,
    })
    expect(r.floorStampedReady).toBe(true)
    expect(r.packet_status).toBe('PAYLOAD_READY')
    expect(r.strawberry_status).toBe('HELD FOR CLOSER')
    expect(r.strawberryMayRun).toBe(false)
  })

  it('releases Strawberry only after closer YES', () => {
    const r = evaluateFloorAudit({
      dataReady: true,
      closeability: 'A',
      brief,
      closerApproved: true,
    })
    expect(r.strawberryMayRun).toBe(true)
    expect(r.packet_status).toBe('STRAWBERRY_QUEUED')
    expect(r.holdReason).toMatch(/WAIT FOR HUMAN/)
  })

  it('never stamps READY on a C file even with a brief', () => {
    const r = evaluateFloorAudit({
      dataReady: false,
      closeability: 'C',
      brief,
      closerApproved: true,
    })
    expect(r.floorStampedReady).toBe(false)
    expect(r.strawberryMayRun).toBe(false)
  })
})
