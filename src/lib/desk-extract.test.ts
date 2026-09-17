import { describe, expect, it } from 'vitest'
import { extracted } from '@/lib/desk-extract'

describe('extracted aliases', () => {
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
})
