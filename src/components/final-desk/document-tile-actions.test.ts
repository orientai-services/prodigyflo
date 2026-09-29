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
  it('places a download under upload for every stored file', () => {
    const html = markup({
      key: 'permit_records',
      documentId: 'a',
      fileUrl: '/api/documents/a/file?t=1',
      files: [file('a', 2, '/api/documents/a/file?t=1'), file('b', 1, '/api/documents/b/file?t=2')],
    })
    const quick = html.indexOf('Quick look')
    const upload = html.indexOf('>Upload<')
    const newer = html.indexOf('Download v2')
    const older = html.indexOf('Download v1')
    expect(quick).toBeGreaterThanOrEqual(0)
    expect(quick).toBeLessThan(upload)
    expect(upload).toBeLessThan(newer)
    expect(newer).toBeLessThan(older)
    expect(html).toContain('/api/documents/a/file?t=1&amp;download=1')
    expect(html).toContain('/api/documents/b/file?t=2&amp;download=1')
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
