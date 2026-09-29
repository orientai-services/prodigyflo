import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CaseDocFile } from '@/lib/daily-desk-case-types'
import { DocumentTileActions } from './document-tile-actions'

const file = (id: string, version: number, fileUrl: string | null): CaseDocFile => ({
  id, label: `${id}.pdf`, version, status: 'RECEIVED', fileUrl, mimeType: 'application/pdf',
})

const markup = (tile: { key: string; documentId: string | null; fileUrl: string | null; files: CaseDocFile[] }, canUpload = true) =>
  renderToStaticMarkup(createElement(DocumentTileActions, {
    tile,
    busy: false,
    canUpload,
    onLook: () => {},
    onUpload: () => {},
  }))

describe('document tile actions', () => {
  it('uses one download button when the card has several stored files', () => {
    const html = markup({
      key: 'permit_records',
      documentId: 'a',
      fileUrl: '/api/documents/a/file?t=1',
      files: [file('a', 2, '/api/documents/a/file?t=1'), file('b', 1, '/api/documents/b/file?t=2')],
    })
    const quick = html.indexOf('Quick look')
    const upload = html.indexOf('>Upload<')
    const download = html.indexOf('>Download<')
    expect(quick).toBeGreaterThanOrEqual(0)
    expect(quick).toBeLessThan(upload)
    expect(upload).toBeLessThan(download)
    expect(html.match(/>Download/g)).toHaveLength(1)
    expect(html).not.toContain('Download v')
  })

  it('links a single stored file directly', () => {
    const html = markup({
      key: 'utility_bill',
      documentId: 'c',
      fileUrl: '/api/documents/c/file?t=3',
      files: [file('c', 1, '/api/documents/c/file?t=3')],
    })
    expect(html).toContain('href="/api/documents/c/file?t=3&amp;download=1"')
    expect(html.match(/>Download</g)).toHaveLength(1)
  })

  it('keeps a disabled download in place when the tile has no file', () => {
    const html = markup({ key: 'id', documentId: null, fileUrl: null, files: [] })
    const upload = html.indexOf('>Upload<')
    const download = html.indexOf('>Download<')
    expect(upload).toBeGreaterThanOrEqual(0)
    expect(upload).toBeLessThan(download)
    expect(html).toContain('disabled')
    expect(html).not.toContain('href=')
  })
})
