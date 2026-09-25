import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { CloserWinInput } from './closer-win'
import { composeMasterCallSheet } from './call-sheet'
import { leverFor, STATE_LEVERS } from './state-levers'
import { str } from './schema'
import type { CallPacket } from './call-pdf-model'

const NAVY = rgb(11 / 255, 31 / 255, 58 / 255)
const TEAL = rgb(46 / 255, 196 / 255, 182 / 255)
const GOLD = rgb(231 / 255, 158 / 255, 36 / 255)
const CARD = rgb(244 / 255, 246 / 255, 248 / 255)
const WHITE = rgb(1, 1, 1)
const MUTED = rgb(90 / 255, 102 / 255, 114 / 255)
const LOCK = rgb(255 / 255, 244 / 255, 214 / 255)
const RED = rgb(214 / 255, 69 / 255, 69 / 255)
const BLUE = rgb(47 / 255, 111 / 255, 196 / 255)
const W = 612
const H = 792

function ascii(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, '-')
    .replace(/[·•]/g, '|')
    .replace(/[^\x00-\xFF]/g, '')
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = ascii(text).split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function shown(value: string | undefined, fallback = 'Not on file'): string {
  const s = str(value)
  return s && s.toUpperCase() !== 'MISSING' ? s : fallback
}

function money(value: string | undefined): string {
  const raw = shown(value, '')
  if (!raw) return 'Not on file'
  const n = Number(raw.replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(n)) return raw
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function statute(input: CloserWinInput): string {
  const code = str(input.state).trim().toUpperCase()
  if (code.length !== 2 || !STATE_LEVERS[code]) return 'state statute not confirmed'
  const name = leverFor(code).udap
  const hit = name.match(/\(([^)]+)\)/)
  return hit?.[1] ?? leverFor(code).name
}

function stateName(input: CloserWinInput): string {
  const code = str(input.state).trim().toUpperCase()
  return code.length === 2 && STATE_LEVERS[code] ? leverFor(code).name : 'Unconfirmed state'
}

function chrome(page: PDFPage, font: PDFFont, bold: PDFFont, left: string, right: string, pageNo: string) {
  page.drawRectangle({ x: 0, y: H - 36, width: W, height: 36, color: NAVY })
  page.drawRectangle({ x: 0, y: H - 40, width: W, height: 4, color: TEAL })
  page.drawText(ascii(left), { x: 36, y: H - 24, size: 8, font: bold, color: WHITE })
  page.drawText(ascii(right), { x: W - 36 - font.widthOfTextAtSize(ascii(right), 8), y: H - 24, size: 8, font, color: WHITE })
  page.drawRectangle({ x: 0, y: 0, width: W, height: 28, color: NAVY })
  page.drawText(ascii(pageNo), { x: W - 90, y: 10, size: 8, font, color: WHITE })
}

function text(page: PDFPage, value: string, x: number, y: number, size: number, font: PDFFont, color = NAVY) {
  page.drawText(ascii(value), { x, y, size, font, color })
}

function paragraph(page: PDFPage, value: string, x: number, y: number, width: number, size: number, font: PDFFont, color = NAVY, leading = 4): number {
  for (const line of wrap(value, font, size, width)) {
    text(page, line, x, y, size, font, color)
    y -= size + leading
  }
  return y
}

function card(page: PDFPage, x: number, y: number, w: number, h: number) {
  page.drawRectangle({ x, y: y - h, width: w, height: h, color: CARD })
}

export async function renderCallPacket(packet: CallPacket): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  if (packet.audience === 'review') drawReview(doc, font, bold, packet.input)
  else drawPitch(doc, font, bold, packet.input)
  doc.setTitle(packet.title)
  return doc.save()
}

function drawReview(doc: PDFDocument, font: PDFFont, bold: PDFFont, input: CloserWinInput) {
  const sheet = composeMasterCallSheet(input)
  const name = `${shown(input.firstName, 'Client')} ${shown(input.lastName, '')}`.trim()
  const place = [shown(input.city, ''), stateName(input)].filter(Boolean).join(', ')
  const product = shown(input.product, 'contract')
  const lessor = shown(input.lender)
  const installer = shown(input.installer)
  const payment = money(input.firstYearMonthly || input.monthly)
  const escalator = shown(input.escalation)
  const term = shown(input.termMonths)
  const signed = shown(input.signedDate)
  const law = statute(input)
  const right = `Prepared for ${name}`
  const headerLeft = 'CANCEL YOUR SOLAR'

  const cover = doc.addPage([W, H])
  cover.drawRectangle({ x: 0, y: 0, width: W, height: H, color: NAVY })
  cover.drawRectangle({ x: 0, y: 0, width: 10, height: H, color: TEAL })
  text(cover, 'Your Case Review', 48, 640, 28, bold, WHITE)
  text(cover, `Prepared for ${name}`, 48, 612, 12, font, WHITE)
  cover.drawRectangle({ x: 48, y: 598, width: 150, height: 2, color: TEAL })
  let y = 560
  y = paragraph(cover, `${lessor} ${product}`, 48, y, 500, 12, font, WHITE)
  y = paragraph(cover, place || 'Location not on file', 48, y - 4, 500, 11, font, WHITE)
  paragraph(cover, `Signed ${signed}  |  Term ${term} months  |  Escalator ${escalator === 'Not on file' ? escalator : escalator + '%'}`, 48, y - 8, 500, 11, font, WHITE)
  text(cover, 'File authorized  |  Processing fee on the engagement', 48, 150, 11, bold, GOLD)
  text(cover, 'Working figure and fee print only when they are on this file', 48, 132, 10, font, WHITE)
  text(cover, 'Closer  |  Director of Finance  |  Cancel Your Solar', 48, 96, 11, bold, GOLD)
  text(cover, 'This review is not legal advice. Counsel evaluates independently.', 48, 78, 8, font, rgb(0.75, 0.8, 0.84))

  const signedPage = doc.addPage([W, H])
  chrome(signedPage, font, bold, headerLeft, right, 'Page 2 of 8')
  text(signedPage, 'What You Signed', 36, 720, 22, bold)
  card(signedPage, 32, 700, 260, 520)
  card(signedPage, 308, 700, 272, 520)
  text(signedPage, 'THE CONTRACT', 46, 672, 9, bold)
  const rows: [string, string][] = [
    ['Lessor', lessor],
    ['Installer', installer],
    ['System', 'Not on file'],
    ['Signed', signed],
    ['Term', term === 'Not on file' ? term : `${term} months`],
    ['Escalator', escalator === 'Not on file' ? escalator : `${escalator}% per year`],
    ['Year 1 payment', payment],
    ['Production guarantee', 'Only if stated in the contract'],
    ['Incentives listed', 'Only if stated in the contract'],
  ]
  let ry = 648
  for (const [label, value] of rows) {
    text(signedPage, label, 46, ry, 9, font, MUTED)
    const valueLines = wrap(value, bold, 8, 100)
    valueLines.forEach((line, index) => text(signedPage, line, 156, ry - index * 10, 8, bold))
    ry -= Math.max(22, valueLines.length * 10 + 8)
  }
  text(signedPage, 'WHAT THIS MEANS', 324, 672, 9, bold)
  let by = 646
  for (const bullet of [
    `This is a ${product}, not a purchase. ${lessor} is the counterparty on the paper.`,
    `The payment on file is ${payment}. Escalator: ${escalator === 'Not on file' ? escalator : escalator + '%'}.`,
    `Credits and rebates belong where this contract assigns them.`,
    `${stateName(input)} consumer protection on this file is ${law}.`,
    'A promise that is not in the contract is not in the contract.',
  ]) {
    if (by < 210) break
    signedPage.drawCircle({ x: 332, y: by + 2, size: 3, color: TEAL })
    by = paragraph(signedPage, bullet, 344, by, 210, 9, font, NAVY, 2) - 8
  }
  text(signedPage, 'Confidential case review  |  Not legal advice', 36, 10, 7, font, WHITE)

  const changed = doc.addPage([W, H])
  chrome(changed, font, bold, headerLeft, right, 'Page 3 of 8')
  text(changed, 'What Changed', 36, 720, 22, bold)
  changed.drawLine({ start: { x: 70, y: 640 }, end: { x: 542, y: 640 }, thickness: 2, color: rgb(0.85, 0.88, 0.9) })
  const nodes: [typeof RED, string, string][] = [
    [RED, 'Event 1', 'Not on file'],
    [BLUE, 'Event 2', 'Not on file'],
    [GOLD, 'Event 3', 'Not on file'],
    [TEAL, 'Today', 'Billing party on this file'],
  ]
  nodes.forEach(([color, when, body], index) => {
    const x = 80 + index * 130
    changed.drawCircle({ x, y: 640, size: 7, color })
    text(changed, when, x - 24, 658, 8, bold, MUTED)
    paragraph(changed, body, x - 36, 618, 100, 8, font, NAVY, 2)
  })
  card(changed, 32, 520, 548, 220)
  text(changed, 'THE RECORD ON THIS FILE', 48, 490, 10, bold)
  paragraph(changed, sheet.sections[1]?.say ?? '', 48, 466, 510, 11, font, NAVY, 4)

  const numbers = doc.addPage([W, H])
  chrome(numbers, font, bold, headerLeft, right, 'Page 4 of 8')
  text(numbers, 'The Numbers', 36, 720, 22, bold)
  text(numbers, 'Figure', 48, 680, 9, bold, MUTED)
  text(numbers, 'Amount', 430, 680, 9, bold, MUTED)
  numbers.drawLine({ start: { x: 40, y: 672 }, end: { x: 572, y: 672 }, thickness: 0.6, color: TEAL })
  const figureRows: [string, string][] = [
    ['Payment on file', payment],
    ['Escalator', escalator === 'Not on file' ? escalator : `${escalator}%`],
    ['Term', term === 'Not on file' ? term : `${term} months`],
    ['Payoff / buyout', money(input.payoff)],
    ['Working figure', 'Not on file'],
    ['Agreed processing fee', 'The fee written on this engagement'],
  ]
  let ny = 650
  for (const [label, value] of figureRows) {
    text(numbers, label, 48, ny, 11, font)
    const lines = wrap(value, bold, 11, 160)
    text(numbers, lines[0] ?? '', 400, ny, 11, bold)
    ny -= 28
  }
  card(numbers, 32, ny - 10, 548, 180)
  text(numbers, 'HOW TO READ THESE NUMBERS', 48, ny - 36, 10, bold)
  paragraph(numbers, sheet.sections[2]?.say ?? '', 48, ny - 58, 510, 10, font, NAVY, 3)

  const bills = doc.addPage([W, H])
  chrome(bills, font, bold, headerLeft, right, 'Page 5 of 8')
  text(bills, 'What Your Bills Actually Show', 36, 720, 20, bold)
  card(bills, 32, 690, 260, 180)
  card(bills, 308, 690, 272, 180)
  text(bills, 'BEFORE', 48, 658, 9, bold, MUTED)
  paragraph(bills, input.hasUtility ? 'A utility bill is on this file. Compare it with the contract. Do not add an average that is not on the bill.' : 'Utility before and after is not on file. Do not invent a bill amount.', 48, 634, 220, 10, font)
  text(bills, 'AFTER', 324, 658, 9, bold, MUTED)
  paragraph(bills, sheet.sections[3]?.say ?? '', 324, 634, 230, 10, font)

  const facts = doc.addPage([W, H])
  chrome(facts, font, bold, headerLeft, right, 'Page 6 of 8')
  text(facts, 'Three Facts Counsel Will Use', 36, 720, 20, bold)
  const factRows = [
    [`Tax-credit promise vs. the paper`, `${law}: credits and rebates belong where this contract assigns them. A promise that is not in the contract is not in the contract.`],
    [`The savings pitch vs. this file`, `${stateName(input)} is the property state. Quote only a utility rate or bill amount that is on the file.`],
    [`The payment terms`, `Read the escalator and any production guarantee from this agreement. Do not add a term that is not on the page.`],
  ]
  let fy = 670
  factRows.forEach(([title, body], index) => {
    facts.drawCircle({ x: 52, y: fy - 4, size: 11, color: index === 2 ? GOLD : TEAL })
    text(facts, String(index + 1), 48, fy - 8, 11, bold, WHITE)
    text(facts, title, 76, fy - 4, 12, bold)
    fy = paragraph(facts, body, 76, fy - 24, 480, 11, font, NAVY, 3) - 18
  })

  const options = doc.addPage([W, H])
  chrome(options, font, bold, headerLeft, right, 'Page 7 of 8')
  text(options, 'Where We Go From Here', 36, 720, 20, bold)
  card(options, 32, 690, 260, 280)
  card(options, 308, 690, 272, 280)
  text(options, 'IF YOU STAY', 48, 658, 10, bold)
  paragraph(options, 'Keep the contract that is on this file. Do not invent the remaining rent.', 48, 634, 220, 11, font)
  text(options, 'FILE OPENED WITH COUNSEL', 324, 658, 10, bold)
  paragraph(options, 'Counsel evaluates independently. The fee is only the fee written on the engagement.', 324, 634, 230, 11, font)
  card(options, 32, 380, 548, 160)
  text(options, 'LIEN STATUS', 48, 350, 10, bold)
  paragraph(options, `Quote only the lien language in this contract. Counsel pulls the county record and the ${stateName(input)} UCC registry. Do not invent a filing number.`, 48, 326, 510, 11, font)

  const docs = doc.addPage([W, H])
  chrome(docs, font, bold, headerLeft, right, 'Page 8 of 8')
  text(docs, 'Documents We Still Need', 36, 720, 22, bold)
  let dy = 680
  sheet.documents.forEach((docRow, index) => {
    const note = index === 1 || index === 2 ? `Priority - ${law}` : docRow.note
    docs.drawCircle({ x: 50, y: dy - 2, size: 10, color: NAVY })
    text(docs, String(index + 1), 46, dy - 6, 9, bold, WHITE)
    text(docs, docRow.item, 72, dy - 2, 11, bold)
    dy = paragraph(docs, note, 72, dy - 16, 470, 9, font, MUTED, 2) - 12
  })
  text(docs, 'Reply with items 2 and 3 first.', 36, 70, 11, bold)
}

function drawPitch(doc: PDFDocument, font: PDFFont, bold: PDFFont, input: CloserWinInput) {
  const sheet = composeMasterCallSheet(input)
  const name = `${shown(input.firstName, 'Client')} ${shown(input.lastName, '')}`.trim()
  const law = statute(input)
  const page1 = doc.addPage([W, H])
  chrome(page1, font, bold, 'CANCEL YOUR SOLAR  |  MASTER CALL SHEET / CLOSER', `${name}  |  1/3`, '')
  text(page1, `${name} - Closer Script`, 36, 720, 18, bold)
  text(page1, 'Share the case review PDF. This sheet stays on YOUR screen.', 36, 702, 9, font, MUTED)
  page1.drawRectangle({ x: 32, y: 630, width: 548, height: 62, color: LOCK })
  text(page1, 'NUMBERS LOCK (do not improvise)', 44, 674, 8, bold, GOLD)
  paragraph(page1, `${sheet.sections[2]?.say ?? ''} Do not drop the fee. Do not invent a number that is not on this engagement.`, 44, 658, 520, 8, font, NAVY, 2)
  let y = 610
  const sections = [
    ['1  |  OPEN  |  20 SEC', sheet.opening],
    ['2  |  WHAT YOU SIGNED', sheet.sections[0]?.say ?? ''],
    ['3  |  WHAT CHANGED', sheet.sections[1]?.say ?? ''],
    ['4  |  THE MONEY', sheet.sections[2]?.say ?? ''],
    ['5  |  THE REALITY CHECK', sheet.sections[3]?.say ?? ''],
  ]
  for (const [title, body] of sections) {
    text(page1, title, 36, y, 9, bold, TEAL)
    y = paragraph(page1, body, 36, y - 14, 540, 8, font, NAVY, 2) - 8
    if (y < 50) break
  }
  text(page1, 'STOP after the ask', W - 130, 10, 8, bold, WHITE)

  const page2 = doc.addPage([W, H])
  chrome(page2, font, bold, 'CANCEL YOUR SOLAR  |  MASTER CALL SHEET / CLOSER', `${name}  |  2/3`, '')
  text(page2, `6  |  THREE FACTS  |  ${law}`, 36, 730, 9, bold, TEAL)
  let fy = 712
  for (const line of [
    `${law}: credits and rebates belong where this contract assigns them.`,
    `${stateName(input)} is the property state. Do not quote a bill that is not on the file.`,
    'Payments follow this contract. Do not add a production guarantee that is not on the page.',
  ]) {
    fy = paragraph(page2, line, 36, fy, 540, 9, font) - 6
  }
  text(page2, '7  |  TWO OPTIONS', 36, fy, 9, bold, TEAL)
  fy = paragraph(page2, sheet.sections[4]?.say ?? '', 36, fy - 14, 540, 9, font) - 8
  text(page2, '8  |  THE ASK  |  THEN STOP TALKING', 36, fy, 9, bold, GOLD)
  page2.drawRectangle({ x: 32, y: fy - 78, width: 548, height: 64, color: NAVY })
  text(page2, 'SAY THIS EXACTLY', 44, fy - 22, 8, bold, GOLD)
  paragraph(page2, sheet.ask, 44, fy - 38, 520, 9, font, WHITE, 2)
  text(page2, 'AFTER THE ASK', 36, fy - 100, 9, bold)
  paragraph(page2, 'Count to eight. Do not add another reason. Do not drop the fee. If he asks a real question, answer it in one sentence and re-ask.', 36, fy - 116, 540, 9, font)
  text(page2, 'STOP after the ask', W - 130, 10, 8, bold, WHITE)

  const page3 = doc.addPage([W, H])
  chrome(page3, font, bold, 'CANCEL YOUR SOLAR  |  MASTER CALL SHEET / CLOSER', `${name}  |  3/3`, '')
  text(page3, '9  |  IF YES - DOCUMENT LIST', 36, 730, 9, bold, TEAL)
  let dy = 710
  sheet.documents.forEach((docRow, index) => {
    const note = index === 1 || index === 2 ? `PRIORITY ${law}` : docRow.note
    dy = paragraph(page3, `${index + 1}  ${docRow.item} - ${note}`, 36, dy, 540, 9, font) - 4
  })
  text(page3, 'LIEN ONE-LINER IF HE ASKS', 36, dy - 8, 9, bold, TEAL)
  paragraph(page3, `Quote only the lien language in this contract. Counsel pulls the county record and the ${stateName(input)} UCC registry.`, 36, dy - 24, 540, 9, font)
  text(page3, 'STOP after the ask', W - 130, 10, 8, bold, WHITE)
}
