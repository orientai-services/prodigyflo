import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE, pdfjsDocumentOptions, previewScale } from './pdf-loader'

describe('Quick look canvas cap', () => {
  it('keeps a 2550x3300 pt county scan inside iOS canvas limits', () => {
    const s = previewScale(2550, 3300)
    expect(3300 * s).toBeLessThanOrEqual(MAX_CANVAS_SIDE + 0.5)
    expect(2550 * s * 3300 * s).toBeLessThanOrEqual(MAX_CANVAS_PIXELS)
  })
  it('leaves normal letter pages at the preferred 1.5x', () => {
    expect(previewScale(612, 792)).toBe(1.5)
    expect(previewScale(0, 0)).toBe(1.5)
  })
  it('points PDF.js at the published decoder, font and cmap assets', () => {
    expect(pdfjsDocumentOptions()).toMatchObject({ wasmUrl: '/pdfjs/wasm/', standardFontDataUrl: '/pdfjs/standard_fonts/', cMapUrl: '/pdfjs/cmaps/' })
  })
})

describe('fax-compressed (CCITT) scan decoding', () => {
  it('the installed pdfjs-dist decodes the CCITT image instead of drawing only overlays', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const base = join(process.cwd(), 'node_modules/pdfjs-dist/')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync('tests/fixtures/ccitt-scan.pdf')), verbosity: 0, ...pdfjsDocumentOptions(base) }).promise
    const page = await doc.getPage(1)
    const ops = await page.getOperatorList()
    const ids = ops.argsArray.filter((_, i) => ops.fnArray[i] === pdfjs.OPS.paintImageXObject).map(a => a[0] as string)
    expect(ids).toHaveLength(1)
    const img = page.objs.get(ids[0]) as { width: number; height: number; data?: Uint8ClampedArray; bitmap?: unknown }
    expect(img.width).toBe(850)
    expect(img.height).toBe(1100)
    expect(Boolean(img.data || img.bitmap)).toBe(true)
    await doc.destroy()
  })
  it('Quick look no longer opens PDFs through unpdf', () => {
    const src = readFileSync('src/components/client/pdf-preview.tsx', 'utf8')
    expect(src).not.toMatch(/unpdf/)
    expect(src).toMatch(/openPdfForPreview/)
  })
  it('publishes worker and decoder assets to public/pdfjs', () => {
    execFileSync('node', ['scripts/copy-pdfjs-assets.mjs'])
    for (const f of ['pdf.worker.min.mjs', 'wasm/jbig2.wasm', 'wasm/openjpeg.wasm', 'standard_fonts', 'cmaps']) expect(existsSync(join('public/pdfjs', f))).toBe(true)
  })
})
