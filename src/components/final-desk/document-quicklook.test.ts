import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CaseDocFile, CaseDocTile } from '@/lib/daily-desk-case-types'
vi.mock('@/components/client/pdf-preview', () => ({ PdfPreview: ({ url }: { url: string }) => createElement('iframe', { src: url, title: 'Original PDF' }) }))
import { DocumentQuicklook, quicklookFiles } from './document-quicklook'

const files: CaseDocFile[] = Array.from({ length: 9 }, (_, index) => ({ id: `original-${index}`, label: index === 8 ? 'Other document' : 'agreement.pdf', version: index + 1, status: 'RECEIVED', fileUrl: `/private-original/${index}`, mimeType: 'application/pdf' }))
const tile: CaseDocTile = { key: 'finance_agreement', label: 'Lender Finance Agreement', state: 'unverified', requirementId: 'finance', documentId: files[0].id, fileUrl: files[0].fileUrl, mimeType: files[0].mimeType, files: [files[0]], extract: null }
const markup = (allFiles: CaseDocFile[]) => renderToStaticMarkup(createElement(DocumentQuicklook, { tile, allFiles, clientLabel: 'Example Person · Las Vegas, NV 89101', firstName: 'Example', onClose: () => {}, onRequest: () => {} }))

describe('baseline Quicklook with complete original access', () => {
  it('opens one original directly without adding file-selection controls', () => {
    const html = markup([files[0]])
    expect(html).toContain('src="/private-original/0"')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('Extracted information')
  })
  it('retains nine distinct originals/versions, including documents outside the eight profile modules', () => {
    const selected = quicklookFiles(tile, files)
    expect(selected.map(file => [file.id, file.fileUrl])).toEqual(files.map(file => [file.id, file.fileUrl]))
    const html = markup(files)
    expect(html.match(/<option /g)).toHaveLength(9)
    expect(html).toContain('Other document')
    expect(html).toContain('value="original-8"')
  })
})
