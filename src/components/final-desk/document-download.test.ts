import { describe, expect, it } from 'vitest'
import { downloadHref, profileDownloads } from './document-download'
import type { CaseDocFile } from '@/lib/daily-desk-case-types'

const file = (id: string, version: number, fileUrl: string | null): CaseDocFile => ({
  id, label: `${id}.pdf`, version, status: 'RECEIVED', fileUrl, mimeType: 'application/pdf',
})

describe('profile document downloads', () => {
  it('forces attachment on a stored document url', () => {
    expect(downloadHref('/api/documents/doc-1/file?t=abc')).toBe('/api/documents/doc-1/file?t=abc&download=1')
  })

  it('refuses a url that is not the document file route', () => {
    expect(downloadHref('https://example.com/secret.pdf')).toBeNull()
    expect(downloadHref(null)).toBeNull()
  })

  it('lists every stored file on the tile once', () => {
    const rows = profileDownloads({
      key: 'utility_bill',
      documentId: 'a',
      fileUrl: '/api/documents/a/file?t=1',
      files: [file('a', 2, '/api/documents/a/file?t=1'), file('b', 1, '/api/documents/b/file?t=2')],
    })
    expect(rows.map((row) => row.id)).toEqual(['a', 'b'])
    expect(rows.every((row) => row.href.includes('download=1'))).toBe(true)
  })

  it('offers nothing when the tile has no file', () => {
    expect(profileDownloads({ key: 'id', documentId: null, fileUrl: null, files: [] })).toEqual([])
  })
})
