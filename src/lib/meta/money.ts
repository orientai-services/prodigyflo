/**
 * USD ↔ cents mapping for the Meta Marketing API. Pure functions — no server
 * imports — so both the graph adapter and the console parser (client bundle)
 * can share them, and they unit-test without a DB.
 *
 * Meta expresses every money field in the account's minor currency unit
 * (cents for USD): `daily_budget` is cents per day, `spend_cap` is LIFETIME
 * cents with a $100 floor. The two are different knobs — never conflate them.
 */

/** Meta rejects lifetime spend caps under $100 (10 000 cents). */
export const SPEND_CAP_MIN_USD = 100

export function usdToCents(usd: number): number {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
    throw new RangeError('Amount must be a non-negative number of dollars.')
  }
  return Math.round(usd * 100)
}

export function centsToUsd(cents: number | string): number {
  const n = typeof cents === 'string' ? Number(cents) : cents
  if (!Number.isFinite(n)) return 0
  return Math.round(n) / 100
}

/**
 * Lifetime spend cap in cents, enforcing Meta's $100 minimum. Throws a
 * RangeError with a user-facing message when the cap is too low.
 */
export function spendCapToCents(usd: number): number {
  const cents = usdToCents(usd)
  if (cents < SPEND_CAP_MIN_USD * 100) {
    throw new RangeError(`Meta requires a lifetime spend cap of at least $${SPEND_CAP_MIN_USD}.`)
  }
  return cents
}

/**
 * Parses a human-typed dollar amount ("25", "$1,250.50") into a number of
 * dollars rounded to cents. Returns null for anything that is not a positive
 * amount — the caller decides how to phrase the complaint.
 */
export function parseUsd(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const value = Number(cleaned)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * 100) / 100
}
