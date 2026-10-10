import type { PDFDocumentProxy } from 'pdfjs-dist'

/** Where scripts/copy-pdfjs-assets.mjs publishes the installed pdfjs-dist assets. */
export const PDFJS_ASSET_BASE = '/pdfjs/'

/** iOS Safari blanks canvases above ~16.7 MP; county scans arrive as 2550x3300 pt pages. */
export const MAX_CANVAS_PIXELS = 12_000_000
export const MAX_CANVAS_SIDE = 2400

/** Largest render scale <= preferred that keeps the canvas inside the pixel and side caps. */
export function previewScale(width: number, height: number, preferred = 1.5): number {
  if (!(width > 0) || !(height > 0)) return preferred
  const byArea = Math.sqrt(MAX_CANVAS_PIXELS / (width * height))
  const bySide = MAX_CANVAS_SIDE / Math.max(width, height)
  return Math.max(0.1, Math.min(preferred, byArea, bySide))
}

/** Options that let PDF.js decode fax (CCITT), JBIG2 and JPEG 2000 scans and draw standard-font overlays. */
export function pdfjsDocumentOptions(base = PDFJS_ASSET_BASE) {
  return {
    wasmUrl: `${base}wasm/`,
    standardFontDataUrl: `${base}standard_fonts/`,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    iccUrl: `${base}iccs/`,
  }
}

/**
 * Open a PDF with the installed pdfjs-dist build and its matching worker.
 * unpdf's bundled serverless PDF.js routes fax scans through a JBIG2 decoder
 * that fails to initialize in the browser, leaving only text overlays visible.
 */
export async function openPdfForPreview(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await import('pdfjs-dist')
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_ASSET_BASE}pdf.worker.min.mjs`
  return pdfjs.getDocument({ data: bytes, ...pdfjsDocumentOptions() }).promise
}
