import { extractPdfText } from './pdf-text'
import { normalizeMime } from './sniff'

/**
 * Text extraction step of the pipeline. Real implementations exist for plain
 * text and digitally-produced PDFs. Images get an explicit non-reader: no OCR
 * engine is wired in, so the extractor says so instead of inventing text.
 */

export type ExtractedText = {
  pages: string[]
  pageCount: number
  warnings: string[]
  extractor: string
}

export interface TextExtractor {
  readonly name: string
  supports(mimeType: string): boolean
  extract(buf: Buffer): Promise<ExtractedText>
}

export const plainTextExtractor: TextExtractor = {
  name: 'plain-text',
  supports: (mime) => normalizeMime(mime) === 'text/plain',
  async extract(buf) {
    // Form-feed is the conventional page separator in exported text documents.
    const pages = buf
      .toString('utf8')
      .split('\f')
      .map((p) => p.trim())
      .filter(Boolean)
    return { pages, pageCount: Math.max(1, pages.length), warnings: [], extractor: 'plain-text' }
  },
}

export const pdfTextExtractor: TextExtractor = {
  name: 'pdf-text',
  supports: (mime) => normalizeMime(mime) === 'application/pdf',
  async extract(buf) {
    const { pages, pageCount, warnings } = extractPdfText(buf)
    return { pages, pageCount, warnings, extractor: 'pdf-text' }
  },
}

/**
 * Deterministic stand-in for OCR. It reads nothing — and says so — because
 * pretending to read an image would put fabricated values in front of a
 * reviewer as if they came from the document.
 */
export const imageNoOcrExtractor: TextExtractor = {
  name: 'image-no-ocr',
  supports: (mime) => normalizeMime(mime).startsWith('image/'),
  async extract() {
    return {
      pages: [],
      pageCount: 1,
      warnings: [
        'OCR is not available in mock mode, so this image was not read. Field values must be entered by a reviewer using the Correct action.',
      ],
      extractor: 'image-no-ocr',
    }
  },
}

const EXTRACTORS: TextExtractor[] = [plainTextExtractor, pdfTextExtractor, imageNoOcrExtractor]

export function getTextExtractor(mimeType: string): TextExtractor | null {
  return EXTRACTORS.find((e) => e.supports(mimeType)) ?? null
}
