import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ findClient: vi.fn(), findReadiness: vi.fn(), saveReadiness: vi.fn(), execute: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: {
  client: { findUnique: mock.findClient },
  cysReadiness: { findUnique: mock.findReadiness, upsert: mock.saveReadiness },
  $executeRaw: mock.execute,
} }))
import { assemblePacket } from './data'

function client(verification = 'UNVERIFIED') {
  return {
    firstName: 'Sample', lastName: 'Homeowner', email: 'sample@example.test', phone: '2025550100',
    addresses: [{ line1: '1 Example Lane', city: 'Example City', state: 'NV', postalCode: '89031' }],
    surveyResponses: [{ answers: {} }], contracts: [],
    cysFieldValues: [] as { fieldKey: string; value: string }[],
    documents: [{ id: 'document-test', requirement: { key: 'signed_contract' }, label: 'Contract', fileName: 'example-ppa.pdf',
      extractions: [{ detectedTypeKey: 'solar_contract', fields: Object.entries({
        product_type: 'Power Purchase Agreement', contract_counterparty: 'Example Energy LLC', installer_name: 'Example Installation Team', first_year_monthly_payment: '57.97',
        term_years: '20 years', escalator_pct: '1.9', customer_signed_date: '2018-05-28', contract_date: '2018-05-30',
        term_start_basis: 'Utility in-service date', payment_basis: 'First year with automatic payments',
      }).map(([key, value]) => ({ key, value, correctedValue: null, verification, sourcePage: 3 })) }],
    }],
  }
}

describe('closing packet PPA provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.findReadiness.mockResolvedValue(null)
    mock.saveReadiness.mockResolvedValue({})
    mock.execute.mockResolvedValue(2)
  })

  it('uses unverified extract on the brief without stamping the file ready', async () => {
    mock.findClient.mockResolvedValue(client())
    const packet = await assemblePacket('client-test')
    expect(packet?.ready.ready).toBe(false)
    expect(packet?.ready.missing).toEqual(expect.arrayContaining(['product_confirmed', 'lender_confirmed', 'monthly']))
    expect(packet?.payload).toContain('57.97')
    expect(packet?.brief).toMatch(/Example Energy LLC|57\.97|2018-05-28/)
    expect(packet?.brief).not.toContain('full or near-full debt exit')
  })

  it('maps reviewed PPA fields without borrowing loan APR, principal, or a start date', async () => {
    mock.findClient.mockResolvedValue(client('VERIFIED'))
    const packet = await assemblePacket('client-test')
    expect(packet?.payload).toContain('Product: ppa')
    expect(packet?.payload).toContain('Lender: Example Energy LLC')
    expect(packet?.payload).toContain('First-year monthly payment: 57.97')
    expect(packet?.payload).toContain('Monthly payment: MISSING')
    expect(packet?.payload).toContain('Term months: 240')
    expect(packet?.payload).toContain('Term months derived from stated years × 12 (20 years).')
    expect(packet?.payload).toContain('APR: Not applicable to PPA / lease')
    expect(packet?.payload).toContain('Annual payment escalation: 1.9')
    expect(packet?.payload).toContain('Customer signature date: 2018-05-28')
    expect(packet?.payload).toContain('Contract effective date: 2018-05-30')
    expect(packet?.payload).toContain('Actual in-service date: MISSING')
    expect(packet?.payload).toContain('Current payoff: MISSING')
    expect(packet?.trench).toBe('unknown')
  })

  it('routes a loan install agreement and a typed monthly into the packet without a lender name', async () => {
    const fixture = client()
    fixture.documents = [{
      id: 'document-loan',
      requirement: { key: 'signed_contract' },
      label: 'Install agreement',
      fileName: 'install-agreement.pdf',
      extractions: [{
        detectedTypeKey: 'solar_contract',
        fields: Object.entries({
          product_type: 'loan',
          amount_financed: '36819.55',
          interest_rate: '2.99',
          term_months: '300',
          term_years: '25',
          first_payment_date: '2022-12-12',
          contract_counterparty: 'GoodLeap',
          installer_name: 'Example Installer',
        }).map(([key, value]) => ({ key, value, correctedValue: null, verification: 'UNVERIFIED', sourcePage: 2 })),
      }],
    }]
    fixture.surveyResponses = [{ answers: { monthly_guess: '350', product_type_guess: 'loan', lender_guess: 'GoodLeap' } }]
    mock.findClient.mockResolvedValue(fixture)
    const packet = await assemblePacket('client-test')
    expect(packet?.payload).toContain('APR: 2.99')
    expect(packet?.payload).toContain('Original contract value: 36819.55')
    expect(packet?.payload).toContain('Monthly payment: 350')
    expect(packet?.payload).toContain('Term months: 300')
    expect(packet?.payload).toContain('Lender: GoodLeap')
    expect(packet?.closerInput.apr).toBe('2.99')
    expect(packet?.closerInput.contractValue).toBe('36819.55')
    expect(packet?.closerInput.monthly).toBe('350')
    expect(packet?.closerInput.firstPayDate).toBe('2022-12-12')
    expect(packet?.closerInput.payoffEstimated).toBe(true)
    expect(packet?.closerInput.lender).toMatch(/GoodLeap/)
    expect(packet?.brief).toMatch(/\$36,819\.55/)
    expect(packet?.brief).toMatch(/2\.99%/)
    expect(packet?.brief).toMatch(/\$350\.00/)
    expect(packet?.brief).toMatch(/Estimated remaining/)
  })

  it('uses reviewed staff corrections ahead of imports and document readings', async () => {
    const fixture = client('VERIFIED')
    fixture.cysFieldValues = [{ fieldKey: 'first_name', value: 'Corrected' }, { fieldKey: 'lender_confirmed', value: 'Reviewed Counterparty' }, { fieldKey: 'term_months', value: '252' }]
    mock.findClient.mockResolvedValue(fixture)
    const packet = await assemblePacket('client-test')
    expect(packet?.payload).toContain('First name: Corrected')
    expect(packet?.brief).toContain('Corrected Homeowner')
    expect(packet?.payload).toContain('Lender: Reviewed Counterparty')
    expect(packet?.payload).toContain('Term months: 252')
  })
})
