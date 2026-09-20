import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ parse: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { parse: mocks.parse } } }))
import { getFieldExtractor, MAX_DOCUMENT_TEXT_CHARS, numberDocumentPages } from '@/lib/ai/extraction-provider'
import { specForType } from '@/lib/extraction/spec'
import type { DocTypeSpec } from '@/lib/extraction/spec'

const spec: DocTypeSpec = { key: 'solar_contract', label: 'Solar contract', requirementKeys: [], keywords: [], fields: [{ key: 'product_type', label: 'Product', required: false, kind: 'text' }] }
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('live document extraction boundary', () => {
  it('does not downgrade a selected live provider with missing credentials to mock', async () => {
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const provider = getFieldExtractor()
    expect(provider.name).toBe('anthropic')
    await expect(provider.extractFields({ docType: spec, pages: ['a readable contract'], fileName: null })).rejects.toThrow(/not configured/)
    expect(mocks.parse).not.toHaveBeenCalled()
  })

  it('rejects unavailable configured providers', async () => {
    vi.stubEnv('AI_PROVIDER', 'unavailable-provider')
    await expect(getFieldExtractor().extractFields({ docType: spec, pages: ['contract'], fileName: null })).rejects.toThrow(/unavailable/)
  })

  it('sends late pages beyond 60k characters and retains grounded evidence', async () => {
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-no-network')
    const pages = Array.from({ length: 36 }, () => 'Synthetic test-only contract text. '.repeat(110))
    pages[35] = 'Late amendment: Power Purchase Agreement (PPA).'
    mocks.parse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: { summary: 'Test response', fields: [{ key: 'product_type', value: 'PPA', confidence: 96, sourcePage: 36, sourceSnippet: pages[35] }] }, usage: { input_tokens: 1, output_tokens: 1 } })
    const result = await getFieldExtractor().extractFields({ docType: spec, pages, fileName: null })
    expect(mocks.parse.mock.calls[0][0].messages[0].content[0].text).toContain(`--- page 36 ---\n${pages[35]}`)
    expect(result.fields[0]).toMatchObject({ value: 'PPA', sourcePage: 36 })
  })

  it('withholds fields when the cited page does not contain the model quote', async () => {
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-no-network')
    mocks.parse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: { summary: 'Test response', fields: [{ key: 'product_type', value: 'PPA', confidence: 96, sourcePage: 1, sourceSnippet: 'Invented PPA quote' }] }, usage: { input_tokens: 1, output_tokens: 1 } })
    const result = await getFieldExtractor().extractFields({ docType: spec, pages: ['No agreement type is stated.'], fileName: null })
    expect(result.fields[0]).toMatchObject({ value: null, confidence: 0 })
    expect(result.warnings).toHaveLength(1)
  })

  it('rejects oversized text without silently losing the last pages', () => {
    expect(() => numberDocumentPages(['x'.repeat(MAX_DOCUMENT_TEXT_CHARS)])).toThrow(/no pages were silently omitted/)
  })
})


describe('signed contract evidence and party identity', () => {
  const solar = specForType('solar_contract')
  async function extract(pages: string[], fields: unknown[], pdf?: { mediaType: 'application/pdf'; base64: string }) {
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-no-network')
    mocks.parse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: { summary: 'Synthetic fixture', fields }, usage: { input_tokens: 1, output_tokens: 1 } })
    return getFieldExtractor().extractFields({ docType: solar, pages, fileName: 'fixture.pdf', pdf })
  }

  it('keeps the legal counterparty separate from a conditional subcontractor', async () => {
    const pages = ['This agreement is between Sample Customer and Example Energy LLC.', 'If not installed by Example Energy LLC, the subcontractor will be Other Installer LLC.']
    const result = await extract(pages, [
      { key: 'contract_counterparty', value: 'Example Energy LLC', confidence: 95, sourcePage: 1, sourceSnippet: pages[0] },
      { key: 'installer_name', value: 'Other Installer LLC', confidence: 95, sourcePage: 2, sourceSnippet: pages[1] },
    ])
    expect(result.fields.find(field => field.key === 'contract_counterparty')?.value).toBe('Example Energy LLC')
    expect(result.fields.find(field => field.key === 'installer_name')?.value).toBeNull()
    expect(result.warnings?.join(' ')).toContain('conditional installation')
  })

  it('grounds literal year numerals and wrapped hyphens without converting units', async () => {
    const pages = ['Term is twenty-five (25) years from the “In-\nService Date”.']
    const result = await extract(pages, [
      { key: 'term_years', value: '25', confidence: 95, sourcePage: 1, sourceSnippet: 'twenty-five (25) years' },
      { key: 'term_start_basis', value: 'In-Service Date', confidence: 95, sourcePage: 1, sourceSnippet: 'the "In-Service Date".' },
    ])
    expect(result.fields.find(field => field.key === 'term_years')?.value).toBe('25')
    expect(result.fields.find(field => field.key === 'term_start_basis')?.value).toBe('In-Service Date')
    expect(result.fields.find(field => field.key === 'term_months')?.value).toBeNull()
  })

  it('rejects stitched text quotes and nonexistent pages', async () => {
    const result = await extract(['Customer signature date: 6/14/2020. Other text intervenes.'], [
      { key: 'customer_signed_date', value: '6/14/2020', confidence: 95, sourcePage: 1, sourceSnippet: 'Customer ... 6/14/2020' },
      { key: 'contract_date', value: '6/14/2020', confidence: 95, sourcePage: 2, sourceSnippet: '6/14/2020' },
    ])
    expect(result.fields.find(field => field.key === 'customer_signed_date')?.value).toBeNull()
    expect(result.fields.find(field => field.key === 'contract_date')?.value).toBeNull()
  })

  it('sends the whole original plus all numbered pages for detached filled dates', async () => {
    const pages = ['Effective date: template placeholder; filled value is positioned separately.']
    const result = await extract(pages, [{ key: 'contract_date', value: '6/16/2020', confidence: 92, sourcePage: 1, sourceSnippet: '6/16/2020' }], { mediaType: 'application/pdf', base64: 'synthetic-pdf-no-network' })
    const request = mocks.parse.mock.calls[0][0]
    expect(request.messages[0].content[0]).toMatchObject({ type: 'document', source: { data: 'synthetic-pdf-no-network' } })
    expect(request.messages[0].content[1].text).toContain('--- page 1 ---')
    expect(request.messages[0].content[1].text).toContain('original layout')
    expect(result.fields.find(field => field.key === 'contract_date')).toMatchObject({ value: '6/16/2020', sourcePage: 1 })
  })
})
