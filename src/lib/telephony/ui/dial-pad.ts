/**
 * The Call Center dial pad's number rules (docs/DIAL_PAD.md). Pure and
 * client-safe; the server's `number:` target uses the same US check, so the
 * pad never enables Call for a number the server would refuse as malformed.
 */

/** Longest thing the pad holds: 11 digits plus room for `*`/`#` codes. */
export const PAD_MAX = 15

/** A dialable US number: +1, area code and exchange starting 2–9. */
const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/

export function isUsE164(value: string): boolean {
  return US_E164.test(value)
}

/** Keeps what the pad accepts (digits, `*`, `#`), so a paste of "+1 (725) 555-1234" becomes "17255551234". */
export function cleanTyped(raw: string): string {
  return raw.replace(/[^0-9*#]/g, '').slice(0, PAD_MAX)
}

/** Digits only, without the leading country 1: "17255551234" → "7255551234". */
export function normalizeTyped(typed: string): string {
  return typed.replace(/\D/g, '').replace(/^1/, '')
}

/** The E.164 the server dials, or null while the number is incomplete or has `*`/`#`. */
export function dialableE164(typed: string): string | null {
  if (/[*#]/.test(typed)) return null
  const digits = typed.replace(/\D/g, '')
  if (digits.length !== 10 && !(digits.length === 11 && digits.startsWith('1'))) return null
  const e164 = `+1${normalizeTyped(digits)}`
  return isUsE164(e164) ? e164 : null
}

export function isDialable(typed: string): boolean {
  return dialableE164(typed) !== null
}

/**
 * The display as the rep types, the way a desk phone shows it:
 * "725" → "725", "7255" → "(725) 5", "7255551234" → "(725) 555-1234",
 * "17255551234" → "1 (725) 555-1234". Codes with `*`/`#`, or more digits than
 * a US number has, are shown as typed.
 */
export function formatAsTyped(typed: string): string {
  if (/[*#]/.test(typed)) return typed
  const digits = typed.replace(/\D/g, '')
  const country = digits.startsWith('1') ? '1' : ''
  const n = digits.slice(country.length)
  if (n.length > 10) return digits
  let out: string
  if (n.length <= 3) out = n
  else if (n.length <= 6) out = `(${n.slice(0, 3)}) ${n.slice(3)}`
  else out = `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`
  return country ? `${country}${out ? ` ${out}` : ''}` : out
}

/** "+17255551234" → "(725) 555-1234". */
export function formatDialed(e164: string): string {
  return formatAsTyped(e164.replace(/^\+1/, ''))
}

/** "+17255551234" → "(725) •••-1234": how the recent list shows a number. */
export function maskDialed(e164: string): string {
  const m = /^\+1(\d{3})\d{3}(\d{4})$/.exec(e164)
  return m ? `(${m[1]}) •••-${m[2]}` : '•••'
}

export const RECENT_MAX = 5

/** Newest first, no repeats, at most five; anything that isn't a US E.164 is dropped. */
export function pushRecent(list: readonly string[], e164: string): string[] {
  return [e164, ...list.filter((n) => n !== e164)].filter(isUsE164).slice(0, RECENT_MAX)
}

/** Recent numbers read back from storage: junk in, an empty or clean list out. */
export function readRecent(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((n): n is string => typeof n === 'string' && isUsE164(n)).slice(0, RECENT_MAX)
  } catch {
    return []
  }
}
