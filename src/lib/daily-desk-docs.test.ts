import { describe, expect, it } from 'vitest'
import { CASE_DOC_KINDS, classifyDeskKind, matchDocKind, tileState } from '@/lib/daily-desk-docs'

describe('CASE_DOC_KINDS', () => {
  it('is the 13-kind case-file strip', () => {
    expect(CASE_DOC_KINDS).toHaveLength(13)
    expect(CASE_DOC_KINDS.map((k) => k.key)).toEqual(expect.arrayContaining([
      'finance_agreement', 'signed_contract', 'utility_bill', 'gov_id', 'comm_evidence',
      'ucc_lien', 'home_deed', 'county_permit', 'production_report', 'proposal', 'lender_statement', 'payoff_letter', 'other',
    ]))
  })
})

describe('matchDocKind', () => {
  it('maps existing package keys onto the 12 tiles', () => {
    expect(matchDocKind('photo_id')?.key).toBe('gov_id')
    expect(classifyDeskKind({ requirementKey: 'proof_income' })?.key).toBe('other')
    expect(classifyDeskKind({ requirementKey: 'attorney_poa' })?.key).toBe('other')
    expect(matchDocKind('lien_filing')?.key).toBe('ucc_lien')
    expect(matchDocKind('ownership')?.key).toBe('home_deed')
    expect(matchDocKind('loan_or_til')?.key).toBe('finance_agreement')
    expect(matchDocKind('agreement')?.key).toBe('signed_contract')
  })
})

describe('classifyDeskKind', () => {
  it('never counts generated lookup summaries as original records', () => {
    expect(classifyDeskKind({detectedType: 'public_record_summary', fileName: 'County-Permit-Record.pdf'})?.key).toBe('other')
    expect(classifyDeskKind({fileName: 'UCC-Fixture-Search-Summary.pdf'})?.key).toBe('other')
    expect(classifyDeskKind({fileName: 'County-Permit-Search-Summary.pdf'})?.key).toBe('other')
  })
  it('puts a lender PDF on finance and a Steele install PDF on solar', () => {
    expect(classifyDeskKind({ fileName: 'GoodLeap_TIL.pdf' })?.key).toBe('finance_agreement')
    expect(classifyDeskKind({ fileName: 'Steele_Solar_Agreement.pdf' })?.key).toBe('signed_contract')
  })

  it('keeps unknown files accessible in Other without inventing a contract classification', () => {
    expect(classifyDeskKind({ fileName: 'scan-page-3.jpg', label: 'other' })?.key).toBe('other')
  })
})

describe('tileState', () => {
  it('is missing when there is no file — not a fake preview', () => {
    expect(tileState({ hasFile: false, extractionStatus: null, fieldCount: 0, verifiedCount: 0 })).toBe('missing')
  })

  it('is unverified when extract exists but nobody confirmed', () => {
    expect(
      tileState({ hasFile: true, extractionStatus: 'COMPLETED', fieldCount: 6, verifiedCount: 0 }),
    ).toBe('unverified')
  })
})
