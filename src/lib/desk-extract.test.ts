import { describe, expect, it } from 'vitest'
import { extracted, extractedFromAnyContract, extractedFact, normalizeProduct, termMonthsFromYears } from '@/lib/desk-extract'

describe('extracted aliases', () => {
  it('keeps a reviewed correction ahead of a later automatic reading and excludes rejection', () => {
    const docs = [{ extractions: [
      { detectedTypeKey: 'solar_contract', fields: [{ key: 'installer_name', value: 'New wrong reading', correctedValue: null, verification: 'UNVERIFIED' }] },
      { detectedTypeKey: 'solar_contract', fields: [{ key: 'installer_name', value: 'Old reading', correctedValue: 'Reviewed provider', verification: 'CORRECTED', sourcePage: 3 }] },
    ] }]
    expect(extractedFact(docs, 'solar_contract', 'installer_name')).toEqual({ value: 'Reviewed provider', verified: true, note: 'Reviewed document · p. 3' })
    expect(extracted([{ extractions: [{ detectedTypeKey: 'solar_contract', fields: [{ key: 'installer_name', value: 'Rejected provider', correctedValue: null, verification: 'REJECTED' }] }] }], 'solar_contract', 'installer_name')).toBe('')
  })

  it('marks disagreeing reviewed versions for review', () => {
    const docs = [{ extractions: [{ detectedTypeKey: 'solar_contract', fields: [
      { key: 'installer_name', value: 'Provider A', correctedValue: null, verification: 'VERIFIED' },
      { key: 'installer_name', value: 'Provider B', correctedValue: null, verification: 'VERIFIED' },
    ] }] }]
    expect(extractedFact(docs, 'solar_contract', 'installer_name')?.verified).toBe(false)
  })

  it('normalizes product classification and converts only explicit year counts', () => {
    expect(normalizeProduct('Power Purchase Agreement')).toBe('ppa')
    expect(termMonthsFromYears('20 years')).toBe('240')
    expect(termMonthsFromYears('from 2018')).toBe('')
    expect(termMonthsFromYears('20 years from 2018')).toBe('')
  })
  it('reads SCS loan_or_til + total_financed as finance amount', () => {
    const docs = [{
      extractions: [{
        detectedTypeKey: 'loan_or_til',
        fields: [
          { key: 'total_financed', value: '24800', correctedValue: null },
          { key: 'monthly_solar_payment', value: '154.80', correctedValue: null },
          { key: 'payment_term_months', value: '300', correctedValue: null },
          { key: 'interest_rate', value: '5.99', correctedValue: null },
          { key: 'lender_servicer', value: 'GoodLeap', correctedValue: null },
        ],
      }],
    }]
    expect(extracted(docs, 'finance_agreement', 'amount_financed')).toBe('24800')
    expect(extracted(docs, 'finance_agreement', 'monthly_payment')).toBe('154.80')
    expect(extracted(docs, 'finance_agreement', 'term_months')).toBe('300')
    expect(extracted(docs, 'finance_agreement', 'apr')).toBe('5.99')
    expect(extracted(docs, 'finance_agreement', 'lender_name')).toBe('GoodLeap')
  })

  it('does not invent a missing amount', () => {
    const docs = [{
      extractions: [{
        detectedTypeKey: 'loan_or_til',
        fields: [{ key: 'lender_servicer', value: 'GoodLeap', correctedValue: null }],
      }],
    }]
    expect(extracted(docs, 'finance_agreement', 'amount_financed')).toBe('')
  })

  it('reads monthly and servicer from an agreement-typed PPA', () => {
    const docs = [{
      extractions: [{
        detectedTypeKey: 'agreement',
        fields: [
          { key: 'monthly_solar_payment', value: '189.40', correctedValue: null },
          { key: 'payment_term_months', value: '300', correctedValue: null },
          { key: 'lender_servicer', value: 'Sunnova', correctedValue: null },
          { key: 'escalator_rate', value: '2.9', correctedValue: null },
          { key: 'agreement_type', value: 'ppa', correctedValue: null },
        ],
      }],
    }]
    expect(extracted(docs, 'solar_contract', 'monthly_payment')).toBe('189.40')
    expect(extracted(docs, 'solar_contract', 'term_months')).toBe('300')
    expect(extracted(docs, 'solar_contract', 'lender_name')).toBe('Sunnova')
    expect(extracted(docs, 'solar_contract', 'escalator_rate')).toBe('2.9')
    expect(extractedFromAnyContract(docs, 'monthly_payment')).toBe('189.40')
    expect(extracted(docs, 'finance_agreement', 'amount_financed')).toBe('')
    expect(extracted(docs, 'finance_agreement', 'apr')).toBe('')
  })

  it('reads a lease typed as ppa/lease without treating it as a loan', () => {
    const docs = [{
      extractions: [{
        detectedTypeKey: 'lease',
        fields: [
          { key: 'monthly_solar_payment', value: '142.10', correctedValue: null },
          { key: 'lender_servicer', value: 'Sunrun', correctedValue: null },
        ],
      }],
    }]
    expect(extracted(docs, 'solar_contract', 'monthly_payment')).toBe('142.10')
    expect(extracted(docs, 'finance_agreement', 'monthly_payment')).toBe('')
    expect(extractedFromAnyContract(docs, 'lender_name')).toBe('Sunrun')
  })
})


describe('re-extraction clears unsupported suggestions', () => {
  it('does not resurrect an older installer after the new run explicitly leaves it unknown', () => {
    const docs = [{ extractions: [
      { detectedTypeKey: 'solar_contract', status: 'COMPLETED', fields: [{ key: 'installer_name', value: null, correctedValue: null, verification: 'UNVERIFIED' }] },
      { detectedTypeKey: 'solar_contract', status: 'COMPLETED', fields: [{ key: 'installer_name', value: 'Conditional subcontractor', correctedValue: null, verification: 'UNVERIFIED' }] },
    ] }]
    expect(extractedFact(docs, 'solar_contract', 'installer_name')).toBeNull()
    docs[0].extractions[1].fields[0].verification = 'VERIFIED'
    expect(extractedFact(docs, 'solar_contract', 'installer_name')?.verified).toBe(true)
  })
})
