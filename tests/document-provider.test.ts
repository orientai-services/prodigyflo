import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ parse: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { parse: mocks.parse } } }))
import { getFieldExtractor, MAX_DOCUMENT_TEXT_CHARS, numberDocumentPages } from '@/lib/ai/extraction-provider'
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
