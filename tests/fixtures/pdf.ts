import { deflateSync } from 'node:zlib'

/** Valid, synthetic PDFs with hex text, compressed streams and a real page tree. */
export function makeTextPdf(pages: string[]): Buffer {
  const objects: Buffer[] = []
  const object = (body: string | Buffer) => objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body))
  object('<< /Type /Catalog /Pages 2 0 R >>')
  object(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`)
  object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  for (const [i, text] of pages.entries()) {
    object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
    const content = text ? `BT /F1 12 Tf 72 700 Td <${Buffer.from(text).toString('hex')}> Tj ET` : ''
    const stream = deflateSync(Buffer.from(content))
    object(Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')]))
  }
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets = [0]
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.concat(chunks).length)
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n'))
  }
  const xref = Buffer.concat(chunks).length
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`))
  return Buffer.concat(chunks)
}
