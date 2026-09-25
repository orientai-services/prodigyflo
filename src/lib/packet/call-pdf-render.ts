import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { CallPacket } from './call-pdf-model'

const CREAM = rgb(0.953, 0.933, 0.894)
const INK = rgb(0.082, 0.125, 0.169)
const TEAL = rgb(0.055, 0.42, 0.4)
const WHITE = rgb(1, 1, 1)

function winAnsi(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, '-')
    .replace(/[·•]/g, '-')
    .replace(/[^\x00-\xFF]/g, '')
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = winAnsi(text).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

function drawPage(doc: PDFDocument, font: PDFFont, bold: PDFFont, packet: CallPacket, index: number, body: string): void {
  const width = 612
  const height = 792
  const margin = 48
  const header = packet.audience === 'review' ? 'CANCEL YOUR SOLAR  -  CASE REVIEW' : 'CANCEL YOUR SOLAR  -  CLOSER PITCH'
  let page = startSheet(doc, font, bold, header, width, height, margin, `${index + 1}`)
  let y = height - 64
  for (const paragraph of body.split('\n')) {
    const heading = paragraph.length > 0 && paragraph.length < 48 && !paragraph.includes(': ') && !paragraph.startsWith('If ')
    const size = heading ? 16 : 11
    const face = heading ? bold : font
    for (const line of wrap(paragraph || ' ', face, size, width - margin * 2)) {
      if (y < 48) {
        page = startSheet(doc, font, bold, header, width, height, margin, `${index + 1}`)
        y = height - 64
      }
      page.drawText(line, { x: margin, y, size, font: face, color: INK })
      y -= size + 5
    }
    y -= 8
  }
}

function startSheet(doc: PDFDocument, font: PDFFont, bold: PDFFont, header: string, width: number, height: number, margin: number, pageNo: string): PDFPage {
  const page = doc.addPage([width, height])
  page.drawRectangle({ x: 0, y: 0, width, height, color: CREAM })
  page.drawRectangle({ x: 0, y: height - 36, width, height: 36, color: TEAL })
  page.drawText(header, { x: margin, y: height - 23, size: 10, font: bold, color: WHITE })
  page.drawText(pageNo, { x: width - margin - 16, y: height - 23, size: 10, font, color: WHITE })
  return page
}

export async function renderCallPacket(packet: CallPacket): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  packet.pages.forEach((body, index) => drawPage(doc, font, bold, packet, index, body))
  doc.setTitle(packet.title)
  return doc.save()
}
