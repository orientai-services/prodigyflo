import type { PhoneNumberKind } from '@prisma/client'

/**
 * Telephony provider boundary — the same shape as the messaging adapters in
 * src/lib/messaging/provider.ts. Nothing above this line ever talks to a
 * carrier SDK, so the mock adapter and Twilio are interchangeable and the
 * console behaves identically against either.
 *
 * A provider does four things: find numbers for sale, buy one, point it back
 * at this app's webhooks, and give it back.
 */

export type NumberCapabilities = {
  sms: boolean
  mms: boolean
  voice: boolean
}

/** One number offered for sale. `e164` is not reserved until purchase(). */
export type AvailableNumber = {
  e164: string
  /** Pretty form for the UI, e.g. "(702) 555-0142". */
  friendly: string
  kind: PhoneNumberKind
  areaCode: string | null
  region: string | null
  locality: string | null
  capabilities: NumberCapabilities
}

export type SearchNumbersInput = {
  kind: PhoneNumberKind
  /** US area code, 3 digits. Ignored for toll-free. */
  areaCode?: string | null
  /** Two-letter state, an alternative to an area code. */
  region?: string | null
  /** Digits or letters the number should contain, e.g. "SOLAR". */
  contains?: string | null
  limit?: number
}

/** Where the carrier should send this number's traffic. Absolute URLs. */
export type NumberWebhooks = {
  voiceUrl: string
  voiceStatusUrl: string
  smsUrl: string
}

export type PurchaseInput = {
  e164: string
  friendlyName: string
  webhooks: NumberWebhooks
}

export type PurchasedNumber = {
  e164: string
  providerSid: string
  capabilities: NumberCapabilities
  areaCode: string | null
  region: string | null
  locality: string | null
}

/**
 * Adapters never throw a bare vendor error at a caller: `purchase` and
 * `release` resolve to a tagged result so the wallet transaction can be rolled
 * back cleanly and the operator sees the carrier's own words.
 */
export type PurchaseResult =
  | { ok: true; number: PurchasedNumber }
  | { ok: false; error: string }

export type ReleaseResult = { ok: true } | { ok: false; error: string }

export interface TelephonyProvider {
  readonly name: string
  /** True when this adapter cannot reach a real carrier — the UI must say so. */
  readonly isMock: boolean
  searchNumbers(input: SearchNumbersInput, org: TelephonyCredentials): Promise<AvailableNumber[]>
  purchase(input: PurchaseInput, org: TelephonyCredentials): Promise<PurchaseResult>
  release(providerSid: string, org: TelephonyCredentials): Promise<ReleaseResult>
}

/**
 * Carrier credentials for ONE account. Resolved per call rather than cached,
 * because an agency user switches accounts mid-session and each account may
 * hold its own Twilio subaccount.
 */
export type TelephonyCredentials = {
  accountSid: string
  authToken: string
}

/** Digits-only E.164 normaliser: "(702) 555-0142" -> "+17025550142". */
export function toE164(input: string): string | null {
  const trimmed = input.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (trimmed.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

/** "+17025550142" -> "(702) 555-0142"; anything non-US falls back to the E.164. */
export function formatE164(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164
}

/** Area code of a US number, or null. */
export function areaCodeOf(e164: string): string | null {
  const m = /^\+1(\d{3})\d{7}$/.exec(e164)
  return m ? m[1] : null
}
