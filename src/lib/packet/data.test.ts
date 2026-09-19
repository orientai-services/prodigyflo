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
        product_type: 'Power Purchase Agreement', installer_name: 'Example Energy LLC', first_year_monthly_payment: '57.97',
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

  it('does not turn automatic extraction into a confirmed or ready closing packet', async () => {
    mock.findClient.mockResolvedValue(client())
    const packet = await assemblePacket('client-test')
    expect(packet?.ready.ready).toBe(false)
    expect(packet?.ready.missing).toEqual(expect.arrayContaining(['product_confirmed', 'lender_confirmed', 'monthly']))
    expect(packet?.payload).toContain('First-year monthly payment: MISSING')
    expect(packet?.payload).not.toContain('57.97')
    expect(packet?.brief).not.toContain('full or near-full debt exit')
  })

  it('maps reviewed PPA fields without borrowing loan APR, principal, or a start date', async () => {
    mock.findClient.mockResolvedValue(client('VERIFIED'))
    const packet = await assemblePacket('client-test')
    expect(packet?.ready.ready).toBe(true)
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
