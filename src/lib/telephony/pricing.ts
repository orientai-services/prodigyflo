import type { PhoneNumberKind } from '@prisma/client'
import { currency } from '@/lib/format'

/**
 * Retail pricing for phone numbers and usage, in whole cents.
 *
 * These are the prices a CLIENT account pays out of its prepaid wallet. They
 * sit above the wholesale carrier rate (Twilio, at the time of writing: $1.15
 * a month for a US local number, $2.15 for toll-free, ~$0.0079 an outbound
 * SMS segment, ~$0.014 a voice minute) — the spread covers the carrier's own
 * usage charges, which are metered per message and per minute rather than
 * billed up front.
 *
 * INTERNAL accounts (see internalBillingSlugs in ./billing) are never charged
 * against a wallet — their numbers go on the agency card — but they are still
 * quoted the same numbers so the console shows what the line actually costs.
 *
 * One place, one table: the buy dialog, the wallet gate and the monthly
 * renewal job all read from here, so a price change is a one-line edit.
 */
export type NumberQuote = {
  kind: PhoneNumberKind
  setupCents: number
  monthlyCents: number
  /** What the purchase debits today: setup + the first month. */
  dueTodayCents: number
}

export const NUMBER_PRICING: Record<PhoneNumberKind, { setupCents: number; monthlyCents: number }> = {
  LOCAL: { setupCents: 0, monthlyCents: 300 },
  TOLL_FREE: { setupCents: 0, monthlyCents: 600 },
}

/** Metered rates, quoted in the console so nobody is surprised by a usage debit. */
export const USAGE_PRICING = {
  /** Per outbound SMS segment. */
  smsOutCents: 2,
  /** Per inbound SMS segment. */
  smsInCents: 1,
  /** Per voice minute, either direction, rounded up to the minute. */
  voicePerMinuteCents: 3,
} as const

export function quoteNumber(kind: PhoneNumberKind): NumberQuote {
  const price = NUMBER_PRICING[kind]
  return {
    kind,
    setupCents: price.setupCents,
    monthlyCents: price.monthlyCents,
    dueTodayCents: price.setupCents + price.monthlyCents,
  }
}

/** "$3.00" — cents in, display string out. Always two decimals; money is money. */
export function money(cents: number): string {
  return currency(cents / 100, { cents: true })
}

/** Suggested top-up amounts on the Add funds dialog, in cents. */
export const TOPUP_PRESETS_CENTS = [2500, 5000, 10_000, 25_000]

export const MIN_TOPUP_CENTS = 500
export const MAX_TOPUP_CENTS = 500_000
