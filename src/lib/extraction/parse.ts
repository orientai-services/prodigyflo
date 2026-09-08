import type { DocTypeSpec } from './spec'

/**
 * Deterministic field extraction from already-extracted text. This is the mock
 * "model": it only ever restates values literally present in the text, with a
 * confidence that reflects how the value was found. Pure and unit-testable.
 */

export type ParsedField = {
  key: string
  label: string
  value: string | null
  confidence: number
  sourcePage: number | null
  sourceSnippet: string | null
}

type Pattern = { re: RegExp; confidence: number; transform?: (m: RegExpMatchArray) => string }

const MONEY = String.raw`\$?\s*([\d,]+(?:\.\d{1,2})?)`
const DATE = String.raw`(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})`

const PATTERNS: Record<string, Pattern[]> = {
  utility_name: [
    { re: /^([A-Z][A-Za-z&.,' -]*(?:power|electric|energy|utilit)[A-Za-z&.,' -]*)$/im, confidence: 82 },
    { re: /(?:utility|provider)\s*(?:name)?\s*[:\-]\s*(.+)$/im, confidence: 88 },
  ],
  account_number: [{ re: /account\s*(?:number|no\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,19})/i, confidence: 92 }],
  service_address: [{ re: /service\s*address\s*[:\-]?\s*(.+)$/im, confidence: 90 }],
  billing_period: [{ re: /(?:billing|service|statement)\s*period\s*[:\-]?\s*(.+)$/im, confidence: 88 }],
  amount_due: [
    { re: new RegExp(String.raw`(?:total\s+)?amount\s*due\s*[:\-]?\s*${MONEY}`, 'i'), confidence: 92, transform: (m) => `$${m[1]}` },
    { re: new RegExp(String.raw`please\s*pay\s*[:\-]?\s*${MONEY}`, 'i'), confidence: 85, transform: (m) => `$${m[1]}` },
  ],
  full_name: [
    { re: /(?:full\s*name|name)\s*[:\-]\s*([A-Za-z][A-Za-z ,.'-]{2,59})$/im, confidence: 88 },
  ],
  date_of_birth: [
    { re: new RegExp(String.raw`(?:dob|date\s*of\s*birth|birth\s*date)\s*[:\-]?\s*${DATE}`, 'i'), confidence: 90 },
  ],
  id_number: [
    { re: /(?:id|license|dl|document)\s*(?:number|no\.?|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9-]{3,19})/i, confidence: 90 },
  ],
  expiration_date: [
    { re: new RegExp(String.raw`(?:exp(?:ires|iration)?\.?|valid\s*(?:until|thru))\s*(?:date)?\s*[:\-]?\s*${DATE}`, 'i'), confidence: 88 },
  ],
  installer_name: [
    { re: /(?:installer|contractor|seller|provider)\s*(?:name)?\s*[:\-]\s*(.+)$/im, confidence: 90 },
  ],
  contract_date: [
    { re: new RegExp(String.raw`(?:agreement|contract|effective)\s*date\s*[:\-]?\s*${DATE}`, 'i'), confidence: 90 },
    { re: new RegExp(String.raw`dated\s*[:\-]?\s*${DATE}`, 'i'), confidence: 75 },
  ],
  system_size_kw: [{ re: /(\d{1,3}(?:\.\d{1,2})?)\s*kw/i, confidence: 85, transform: (m) => m[1] }],
  monthly_payment: [
    { re: new RegExp(String.raw`monthly\s*(?:payment|amount|rate)\s*[:\-]?\s*${MONEY}`, 'i'), confidence: 92, transform: (m) => `$${m[1]}` },
  ],
  term_months: [
    {
      re: /(?:term|duration)\s*[:\-]?\s*(\d{1,3})\s*(months?|years?)/i,
      confidence: 90,
      transform: (m) => String(/year/i.test(m[2]) ? Number(m[1]) * 12 : Number(m[1])),
    },
  ],
  escalator_pct: [{ re: /escalator\s*(?:rate)?\s*[:\-]?\s*(\d{1,2}(?:\.\d{1,2})?)\s*%/i, confidence: 90, transform: (m) => m[1] }],
}

function snippetAround(page: string, match: RegExpMatchArray): string | null {
  if (match.index === undefined) return null
  const lineStart = page.lastIndexOf('\n', match.index) + 1
  let lineEnd = page.indexOf('\n', match.index + match[0].length)
  if (lineEnd === -1) lineEnd = page.length
  return page.slice(lineStart, lineEnd).trim().slice(0, 160) || null
}

/**
 * Runs every field spec against every page. Fields not found are still emitted
 * with a null value and zero confidence, so a reviewer can supply them via the
 * Correct action instead of them silently not existing.
 */
export function extractFieldsFromText(spec: DocTypeSpec, pages: string[]): ParsedField[] {
  return spec.fields.map((field) => {
    for (const pattern of PATTERNS[field.key] ?? []) {
      for (let p = 0; p < pages.length; p++) {
        const match = pages[p].match(pattern.re)
        if (match?.[1]) {
          const raw = (pattern.transform ? pattern.transform(match) : match[1]).trim()
          if (!raw) continue
          return {
            key: field.key,
            label: field.label,
            value: raw.slice(0, 200),
            confidence: pattern.confidence,
            sourcePage: p + 1,
            sourceSnippet: snippetAround(pages[p], match),
          }
        }
      }
    }
    return { key: field.key, label: field.label, value: null, confidence: 0, sourcePage: null, sourceSnippet: null }
  })
}
