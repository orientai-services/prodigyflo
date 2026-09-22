import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@/lib/rbac'

const mock = vi.hoisted(() => ({ client: vi.fn(), cys: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { client: { findFirst: mock.client }, documentRequirement: { findMany: async () => [] }, user: { findMany: async () => [] } } }))
vi.mock('@/lib/rbac', () => ({ can: () => true, clientScope: () => ({}) }))
vi.mock('@/lib/storage', () => ({ signedDocumentFileUrl: async () => '/api/documents/test/file' }))
vi.mock('@/lib/packet/data', () => ({ assemblePacket: async () => null }))
vi.mock('@/lib/cys/data', () => ({ resolveForClient: mock.cys }))
vi.mock('@/lib/ai/closeops-ai', () => ({ listBriefViews: async () => [] }))
import { loadCaseFile } from './daily-desk-case'

const user = { role: 'SUPER_ADMIN', organizationId: 'org-test' } as SessionUser
const fields = { product_type: 'PPA', contract_counterparty: 'Example Energy LLC', installer_name: 'Example Installation Team', first_year_monthly_payment: '57.97', escalator_pct: '1.9', term_years: '20 years', contract_date: '2018-05-30', customer_signed_date: '2018-05-28', term_start_basis: 'Actual utility in-service date', system_size_kw: '3.71' }
const fixture = () => ({
  id: 'client-test', firstName: 'Sample', lastName: 'Homeowner', organization: { timezone: 'America/Los_Angeles' },
  currentStage: { name: 'New client' }, owner: null, leadSource: { name: 'SCS' }, addresses: [], appointments: [], contracts: [],
  surveyResponses: [{ answers: { first_name: 'Sample', active_bankruptcy: 'No', _scs_answer_provenance: { first_name: { source: 'homeowner' } } }, survey: { schema: [] } }],
  documents: [{ id: 'document-test', status: 'RECEIVED', requirement: { id: 'req-test', key: 'signed_contract', name: 'Signed contract' },
    label: 'Contract', fileName: 'example.pdf', mimeType: 'application/pdf', storageKey: 'private-fixture', version: 1, receivedAt: new Date(), createdAt: new Date(),
    extractions: [{ status: 'COMPLETED', detectedTypeKey: 'solar_contract', fields: Object.entries(fields).map(([key, value]) => ({ key, label: key, value, correctedValue: null, verification: 'UNVERIFIED', sourcePage: 3 })) }],
  }],
})

describe('PPA client profile population', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.client.mockResolvedValue(fixture())
    mock.cys.mockResolvedValue({ values: [], readiness: {}, blockers: ['Review required'] })
  })

  it('shows sourced PPA suggestions, separate dates, and derived term without a loan balance', async () => {
    const profile = await loadCaseFile(user, 'client-test')
    expect(profile?.finance.find(cell => cell.label === 'Contract counterparty')?.cell).toMatchObject({ display: 'Example Energy LLC' })
    expect(profile?.solar.find(cell => cell.label === 'Actual installer')?.cell).toMatchObject({ display: 'Example Installation Team' })
    expect(profile?.finance.find(cell => cell.label === 'First-year monthly payment')).toMatchObject({ cell: { kind: 'value', amount: 57.97 }, unverified: true })
    expect(profile?.finance.find(cell => cell.label === 'Term months')).toMatchObject({ cell: { display: '240' }, unverified: true })
    expect(profile?.finance.find(cell => cell.label === 'Term months')?.hint).toContain('Derived months')
    expect(profile?.finance.find(cell => cell.label === 'Actual in-service date')?.cell.kind).toBe('missing')
    expect(profile?.finance.find(cell => cell.label === 'Contract effective date')?.cell).toMatchObject({ display: '2018-05-30' })
    expect(profile?.finance.find(cell => cell.label === 'Customer signature date')?.cell).toMatchObject({ display: '2018-05-28' })
    expect(profile?.finance.find(cell => cell.label === 'Interest rate')?.cell).toMatchObject({ display: 'None' })
    expect(profile?.finance.find(cell => cell.label === 'Annual payment escalation')?.cell).toMatchObject({ display: '1.9%' })
    expect(profile?.finance.find(cell => cell.label === 'Total / amount financed')?.cell.kind).toBe('value')
    expect(profile?.finance.find(cell => cell.label === 'Estimated remaining balance')?.cell.kind).toBe('value')
    expect(profile?.intake.some(row => row.question.includes('provenance'))).toBe(false)
  })

  it('uses a staff term correction ahead of the extraction without marking it unverified', async () => {
    mock.cys.mockResolvedValue({ values: [{ fieldKey: 'term_months', value: '252', status: 'VERIFIED' }], readiness: {}, blockers: [] })
    const profile = await loadCaseFile(user, 'client-test')
    expect(profile?.finance.find(cell => cell.label === 'Term months')).toMatchObject({ cell: { display: '252' }, unverified: false, hint: 'Reviewed CYS value' })
  })
})


describe('reviewed product Unknown blocks intake guesses',()=>{
 it.each(['REJECTED','CORRECTED'])('does not resurrect product_type_guess after %s',async verification=>{
  const client=fixture()
  client.surveyResponses[0].answers=({...client.surveyResponses[0].answers,product_type_guess:'loan'} as typeof client.surveyResponses[0]['answers'])
  const product=client.documents[0].extractions[0].fields.find(f=>f.key==='product_type')!
  product.verification=verification
  if(verification==='CORRECTED') product.correctedValue='' as unknown as null
  mock.client.mockResolvedValue(client);mock.cys.mockResolvedValue({values:[],readiness:{},blockers:[]})
  const profile=await loadCaseFile(user,'client-test')
  expect(profile?.solar.find(c=>c.label==='Agreement type')?.cell.kind).toBe('missing')
 })
})
