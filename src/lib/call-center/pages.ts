import type { ApproachLanguage } from './types'

const EN = process.env.CALL_CENTER_PAGE_EN ?? 'SES-EN'
const ES = process.env.CALL_CENTER_PAGE_ES ?? 'SES-ES'

const NAMES: Record<string, string> = {
  [EN]: 'SES English',
  [ES]: 'SES Spanish',
}

export function languageForPageId(pageId: string | undefined | null): ApproachLanguage | null {
  if (!pageId) return null
  if (pageId === EN) return 'en'
  if (pageId === ES) return 'es'
  return null
}

export function pageName(pageId: string): string {
  return NAMES[pageId] ?? pageId
}

export function inboundNumberLanguage(toNumber: string | undefined | null): ApproachLanguage | null {
  const en = process.env.CALL_CENTER_INBOUND_EN
  const es = process.env.CALL_CENTER_INBOUND_ES
  if (!toNumber) return null
  const digits = toNumber.replace(/\D/g, '').slice(-10)
  if (en && digits === en.replace(/\D/g, '').slice(-10)) return 'en'
  if (es && digits === es.replace(/\D/g, '').slice(-10)) return 'es'
  return null
}

export const DEMO_PAGE_IDS = { en: EN, es: ES }
