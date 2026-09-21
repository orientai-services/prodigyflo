import { describe, expect, it } from 'vitest'
import { resolveCaseFacts, type CaseFactSource } from '@/lib/case-facts'
import { amortize } from '@/lib/daily-desk-finance'
import { extracted } from '@/lib/desk-extract'
import { profileCells } from '@/lib/final-desk/mapping'

const now = new Date('2026-09-20T12:00:00Z')

function field(key: string, value: string) {
  return { key, value, correctedValue: null as string | null, verification: 'CORRECTED' as const }
}

function source(docs: CaseFactSource['documents']): CaseFactSource {
  return {
    organization: { timezone: 'America/Los_Angeles' },
    surveyResponses: [{ answers: { credit_band: '740_plus', product_type_guess: 'loan' } }],
    addresses: [{ line1: '4416 Clear Brook Pl', city: 'Las Vegas', state: 'NV', postalCode: '89110' }],
    documents: docs,
    contracts: [{ productType: 'loan' }],
  }
}

const ric = {
  extractions: [{
    detectedTypeKey: 'loan_or_til',
    status: 'COMPLETED',
    fields: [
      field('total_financed', '62246.38'),
      field('interest_rate', '2.99'),
      field('monthly_solar_payment', '344.97'),
      field('payment_term_months', '240'),
      field('lender_servicer', 'Salal Credit Union'),
      field('installer', 'Solar Optimum, Inc.'),
      field('agreement_type', 'loan'),
    ],
  }],
}

const cert = {
  extractions: [{
    detectedTypeKey: 'completion_cert',
    status: 'COMPLETED',
    fields: [field('first_payment_date', '2024-09-19')],
  }],
}

const statement = {
  extractions: [{
    detectedTypeKey: 'lender_statement',
    status: 'COMPLETED',
    fields: [
      field('remaining_balance', '58410.22'),
      field('interest_paid_to_date', '3102.18'),
      field('months_remaining', '216'),
    ],
  }],
}

const proposal = {
  extractions: [{
    detectedTypeKey: 'proposal',
    status: 'COMPLETED',
    fields: [field('system_size_kw', '8.64')],
  }],
}

function cell(facts: ReturnType<typeof resolveCaseFacts>, label: string) {
  return profileCells(facts).finance.concat(profileCells(facts).solar).find(c => c.label === label)
}

describe('loan-map document authority on FinalDesk cells', () => {
  it('RIC only: first pay missing, remaining cluster cannot_compute, $1331 is not monthly, dealer fee is 30% benchmark', () => {
    const facts = resolveCaseFacts(source([ric]), null, { now })
    const cells = profileCells(facts)
    expect(cell(facts, 'Monthly payment')?.cell).toMatchObject({ kind: 'value' })
    expect(JSON.stringify(cell(facts, 'Monthly payment')?.cell)).not.toContain('1331')
    expect(cell(facts, 'First payment date')?.cell.kind).toBe('missing')
    expect(cell(facts, 'Remaining balance')?.cell.kind).toBe('cannot_compute')
    expect(cell(facts, 'Interest paid to date')?.cell.kind).toBe('cannot_compute')
    expect(cell(facts, 'Months remaining')?.cell.kind).toBe('cannot_compute')
    expect(cell(facts, 'Years remaining')?.cell.kind).toBe('cannot_compute')
    expect(cell(facts, '30% Dealer Fee')?.cell).toMatchObject({ kind: 'value' })
    expect(cell(facts, '30% Dealer Fee')?.hint).toMatch(/benchmark/i)
    expect(cell(facts, 'Credit score')?.cell).toMatchObject({ kind: 'value', display: '740_plus' })
    expect(cell(facts, 'System size')?.cell.kind).toBe('missing')
    expect(cells.finance).toHaveLength(13)
  })

  it('RIC + completion cert unlocks amortized remaining (Drew 2026-09-20)', () => {
    const facts = resolveCaseFacts(source([ric, cert]), null, { now })
    expect(cell(facts, 'First payment date')?.cell).toMatchObject({ kind: 'value', display: '2024-09-19' })
    const remaining = amortize({
      firstPayDate: '2024-09-19', termMonths: 240, aprPercent: 2.99, monthlyPayment: 344.97,
      principal: 62246.38, now,
    })
    expect(remaining.remaining).toMatchObject({ kind: 'value', amount: 57556.44 })
    expect(cell(facts, 'Remaining balance')?.cell).toMatchObject({ kind: 'value', amount: 57556.44 })
    expect(cell(facts, 'Months remaining')?.cell).toMatchObject({ kind: 'value', display: '216' })
  })

  it('statement actuals beat amortized estimates; first pay stays from the certificate', () => {
    const facts = resolveCaseFacts(source([ric, cert, statement]), null, { now })
    expect(cell(facts, 'Remaining balance')?.cell).toMatchObject({ kind: 'value', amount: 58410.22 })
    expect(cell(facts, 'Interest paid to date')?.cell).toMatchObject({ kind: 'value', amount: 3102.18 })
    expect(cell(facts, 'Months remaining')?.cell).toMatchObject({ kind: 'value', display: '216' })
    expect(cell(facts, 'First payment date')?.cell).toMatchObject({ kind: 'value', display: '2024-09-19' })
    expect(cell(facts, 'Remaining balance')?.hint).toMatch(/statement/i)
  })

  it('uses a first-year / install-agreement payment when the loan monthly field is empty', () => {
    const docs = [{
      extractions: [{
        detectedTypeKey: 'finance_agreement',
        status: 'COMPLETED',
        fields: [
          field('total_financed', '58927.5'),
          field('interest_rate', '6'),
          field('term_years', '25'),
          field('first_year_monthly_payment', '263.22'),
        ],
      }],
    }]
    const facts = resolveCaseFacts(source(docs), null, { now })
    expect(JSON.stringify(cell(facts, 'Monthly payment')?.cell)).toMatch(/263\.22/)
  })

  it('proposal writes system size; RIC never does', () => {
    expect(extracted(source([ric]).documents, 'finance_agreement', 'system_size_kw')).toBe('')
    const facts = resolveCaseFacts(source([ric, proposal]), null, { now })
    expect(cell(facts, 'System size')?.cell).toMatchObject({ kind: 'value' })
    expect(JSON.stringify(cell(facts, 'System size')?.cell)).toMatch(/8\.64/)
  })
})
