import { describe, expect, it } from 'vitest'
import { makeTextPdf } from './fixtures/pdf'
import { extractPdfText, hasReadablePdfText, hasSignedFormLayout } from '@/lib/extraction/pdf-text'
import { extractFieldsFromText } from '@/lib/extraction/parse'
import { canApproveDocument, computeMissingFieldKeys, specForType } from '@/lib/extraction/spec'

// No client files or personal data belong in these fixtures.
describe('physical PDF page coverage', () => {
  it('keeps blank inserts and the last page at their real page numbers', async () => {
    const pages = Array.from({ length: 36 }, (_, i) => `Synthetic contract page ${i + 1}. The text on this page is test-only evidence.`)
    pages[3] = ''
    pages[35] = 'Synthetic design appendix. System size: 4.250 kW. This page must never disappear.'
    const result = await extractPdfText(makeTextPdf(pages))
    expect(result.pageCount).toBe(36)
    expect(result.pages).toHaveLength(36)
    expect(result.pages[3]).toBe('')
    expect(result.pages[35]).toContain('4.250 kW')
    expect(result.needsVision).toBe(true)
    expect(result.warnings.join(' ')).toContain('pages 4 ')
  })

  it('recognizes print chrome as insufficient text for an image scan', () => {
    expect(hasReadablePdfText('9/19/26, 2:39 AM scan.jpg (1700×2338) https://example.test/long-storage-link.pdf 1/2')).toBe(false)
  })

  it('fails a damaged PDF explicitly rather than claiming it is a scan', async () => {
    await expect(extractPdfText(Buffer.from('%PDF-1.4\nnot a valid document'))).rejects.toThrow(/damaged or password-protected/)
  })
})

describe('literal PPA terms and review requirements', () => {
  const spec = specForType('solar_contract')
  it('does not convert first-year pricing into a current payment or years into literal months', () => {
    const byKey = Object.fromEntries(extractFieldsFromText(spec, ['First-year monthly payment: $61.25\nTerm: 20 years\nEscalator: 2.5%']).map((field) => [field.key, field]))
    expect(byKey.first_year_monthly_payment.value).toBe('$61.25')
    expect(byKey.monthly_payment.value).toBeNull()
    expect(byKey.term_years.value).toBe('20')
    expect(byKey.term_months.value).toBeNull()
    expect(byKey.escalator_pct.value).toBe('2.5')
  })

  it('requires reviewed payment and term alternatives, without requiring absent units', () => {
    const values = [
      { key: 'installer_name', value: 'Example Installer' },
      { key: 'contract_date', value: '2020-01-01' },
      { key: 'first_year_monthly_payment', value: '$61.25' },
      { key: 'term_years', value: '20' },
    ]
    expect(computeMissingFieldKeys(spec, values.map((field) => ({ ...field, confidence: 95 })))).toEqual([])
    const fields = values.map((field) => ({ ...field, label: field.key, correctedValue: null, verification: 'VERIFIED' as const }))
    expect(canApproveDocument(spec, fields).ok).toBe(true)
    expect(canApproveDocument(spec, fields.filter((field) => field.key !== 'term_years')).ok).toBe(false)
  })
})


describe('signed-form PDF routing', () => {
  it('requests original vision even when every page has a readable text layer', async () => {
    const pdf = makeTextPdf(['Synthetic contract with readable terms, effective date placeholder, and DocuSign Envelope ID: test-envelope.'])
    const result = await extractPdfText(pdf)
    expect(result.needsVision).toBe(true)
    expect(result.warnings.join(' ')).toContain('Signed-form layout')
  })

  it('keeps ordinary text PDFs on text extraction and recognizes signature placeholders', async () => {
    const result = await extractPdfText(makeTextPdf(['Synthetic contract with readable terms and no form overlays or scanned inserts.']))
    expect(result.needsVision).toBe(false)
    expect(hasSignedFormLayout(String.raw`Effective as of \od\____; customer signed \d1\___`)).toBe(true)
  })
})
