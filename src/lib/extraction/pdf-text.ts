import { inflateSync } from 'node:zlib'

/**
 * Minimal PDF text extraction with no external dependency: decompresses
 * FlateDecode content streams and reads the text-showing operators (Tj, TJ, ').
 * Handles the digitally-produced PDFs this product actually receives; a
 * scanned image-only PDF honestly yields no text plus a warning — it is never
 * pretended into OCR.
 */

export type PdfText = { pages: string[]; pageCount: number; warnings: string[] }

/** Decode a PDF literal string body: escape sequences and octal codes. */
function decodePdfString(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const next = raw[++i]
    if (next === undefined) break
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === 'b' || next === 'f') out += ''
    else if (next >= '0' && next <= '7') {
      let oct = next
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i]
      out += String.fromCharCode(parseInt(oct, 8) & 0xff)
    } else out += next // \( \) \\ and line continuations
  }
  return out
}

const printable = (s: string) => {
  if (!s) return false
  let ok = 0
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127)) ok++
  }
  return ok / s.length > 0.8
}

/** Pull text out of one decoded content stream. */
function textFromContent(content: string): string {
  const parts: string[] = []
  // (…) Tj  |  (…) '  — single-string show operators
  const tjRe = /\(((?:\\.|[^\\)])*)\)\s*(?:Tj|')/g
  // [ … ] TJ — array show operator; strings interleaved with kerning numbers
  const tjArrRe = /\[((?:\\.|[^\]])*)\]\s*TJ/g
  // Line-advance operators — approximate as newlines so labeled rows survive
  const ops: { index: number; text: string }[] = []

  for (const m of content.matchAll(tjRe)) {
    const decoded = decodePdfString(m[1])
    if (printable(decoded)) ops.push({ index: m.index ?? 0, text: decoded })
  }
  for (const m of content.matchAll(tjArrRe)) {
    const inner = m[1]
    let s = ''
    for (const sm of inner.matchAll(/\(((?:\\.|[^\\)])*)\)/g)) s += decodePdfString(sm[1])
    if (printable(s)) ops.push({ index: m.index ?? 0, text: s })
  }
  ops.sort((a, b) => a.index - b.index)

  // Insert newlines where the content stream moves to a new text line.
  const breaks = new Set<number>()
  for (const m of content.matchAll(/(?:Td|TD|T\*)\s/g)) breaks.add(m.index ?? 0)
  const sortedBreaks = [...breaks].sort((a, b) => a - b)

  let bi = 0
  for (const op of ops) {
    while (bi < sortedBreaks.length && sortedBreaks[bi] < op.index) {
      parts.push('\n')
      bi++
    }
    parts.push(op.text)
  }
  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extractPdfText(buf: Buffer): PdfText {
  const warnings: string[] = []
  const raw = buf.toString('latin1')
  if (!raw.startsWith('%PDF-')) {
    return { pages: [], pageCount: 0, warnings: ['Not a PDF file.'] }
  }

  const pageCount = Math.max(1, (raw.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length)

  // Walk every stream…endstream block; try inflate first, then raw bytes.
  const pages: string[] = []
  const streamRe = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = streamRe.exec(raw)) !== null) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end === -1) break
    streamRe.lastIndex = end

    const bytes = buf.subarray(start, end)
    let content: string | null = null
    try {
      content = inflateSync(bytes).toString('latin1')
    } catch {
      const asText = bytes.toString('latin1')
      if (/\b(Tj|TJ|BT)\b/.test(asText)) content = asText
    }
    if (!content) continue

    const text = textFromContent(content)
    if (text) pages.push(text)
  }

  if (pages.length === 0) {
    warnings.push('This PDF has no extractable text layer (likely a scanned image). OCR is not available in mock mode — a reviewer must enter field values manually.')
  } else if (pages.length !== pageCount) {
    // Content streams do not always map one-to-one onto pages; positions are approximate.
    warnings.push('Source page numbers are approximate for this PDF.')
  }

  return { pages, pageCount, warnings }
}
