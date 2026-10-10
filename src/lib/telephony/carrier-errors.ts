/**
 * Plain-English meanings for the carrier error codes staff actually meet.
 *
 * No `server-only`: the UI labels messages and calls with these too. Every
 * entry links Twilio's own page for the code, and nothing here invents a
 * meaning — a code that is not listed shows as "Carrier error <code>" with a
 * link, never a guess.
 */

export type CarrierErrorInfo = {
  code: string
  /** Short, plain words, shown as-is. */
  meaning: string
  /** True when the carrier refused before the message or call went anywhere. */
  blocked: boolean
  docsUrl: string
}

const DOCS = (code: string) => `https://www.twilio.com/docs/api/errors/${code}`

const KNOWN: Record<string, { meaning: string; blocked: boolean }> = {
  // https://www.twilio.com/docs/api/errors/30034 — US A2P 10DLC: message from an unregistered number.
  '30034': { meaning: 'texting registration (A2P) pending', blocked: true },
  // https://www.twilio.com/docs/api/errors/21408 — permission to send SMS not enabled for the region.
  '21408': { meaning: "texting to that country isn't enabled", blocked: true },
  // https://www.twilio.com/docs/api/errors/21610 — attempt to send to an unsubscribed recipient.
  '21610': { meaning: 'they opted out at the carrier', blocked: true },
  // https://www.twilio.com/docs/api/errors/21211 — invalid 'To' phone number.
  '21211': { meaning: 'not a valid number', blocked: true },
  // https://www.twilio.com/docs/api/errors/21614 — 'To' number is not a valid mobile number.
  '21614': { meaning: 'not a mobile number', blocked: true },
  // https://www.twilio.com/docs/api/errors/30003 — unreachable destination handset.
  '30003': { meaning: 'phone unreachable', blocked: false },
  // https://www.twilio.com/docs/api/errors/30005 — unknown destination handset.
  '30005': { meaning: 'unknown number', blocked: false },
  // https://www.twilio.com/docs/api/errors/30006 — landline or unreachable carrier.
  '30006': { meaning: "landline or carrier can't take texts", blocked: false },
  // https://www.twilio.com/docs/api/errors/30007 — message filtered by the carrier.
  '30007': { meaning: 'carrier filtered it', blocked: false },
  // https://www.twilio.com/docs/api/errors/30008 — unknown error from the carrier.
  '30008': { meaning: 'carrier error, unknown', blocked: false },
  // https://www.twilio.com/docs/api/errors/10004 — call concurrency limit reached on the account.
  '10004': { meaning: 'account allows one call at a time', blocked: true },
  // https://www.twilio.com/docs/api/errors/13227 — geo permissions do not allow calling that country.
  '13227': { meaning: 'no permission to call that country', blocked: true },
}

/** Pulls a numeric carrier code out of "30034", "30034: …" or "… [code 30034]". */
export function carrierCodeFrom(text: string | null | undefined): string | null {
  if (!text) return null
  const tagged = /\[code (\d{4,6})\]/.exec(text)
  if (tagged) return tagged[1]
  const lead = /^\s*(\d{4,6})\b/.exec(text)
  return lead ? lead[1] : null
}

export function explainCarrierError(code: string | number | null | undefined): CarrierErrorInfo {
  const key = String(code ?? '').trim()
  const hit = KNOWN[key]
  if (hit) return { code: key, meaning: hit.meaning, blocked: hit.blocked, docsUrl: DOCS(key) }
  return { code: key, meaning: key ? `Carrier error ${key}` : 'Carrier error', blocked: false, docsUrl: DOCS(key || '') }
}

/** The stored failure text for a code: "30034: texting registration (A2P) pending". */
export function failureCodeText(code: string | number): string {
  const info = explainCarrierError(code)
  return KNOWN[info.code] ? `${info.code}: ${info.meaning}` : `${info.code}: Carrier error ${info.code}`
}

/**
 * The label an SMS row shows. SENT means "the carrier accepted it", never
 * "delivered" — only the delivery callback earns that word.
 */
export function smsStatusLabel(status: string, failureCode: string | null | undefined): string {
  switch (status) {
    case 'DELIVERED':
    case 'READ':
      return 'Delivered'
    case 'SENT':
      return 'Accepted by carrier'
    case 'QUEUED':
      return 'Sending'
    case 'RECEIVED':
      return 'Received'
    case 'FAILED': {
      const code = carrierCodeFrom(failureCode)
      if (!code) return failureCode ? `Failed: ${failureCode.replace(/^\s*\d{4,6}:\s*/, '')}` : 'Failed'
      const info = explainCarrierError(code)
      return info.blocked ? `Blocked: ${info.meaning}` : `Failed: ${info.meaning}`
    }
    default:
      return status.charAt(0) + status.slice(1).toLowerCase()
  }
}
