import type { TelephonyBilling } from '@prisma/client'

/**
 * Which accounts bill to the agency card.
 *
 * Deliberately free of `server-only` and of any database import: the seed and
 * bootstrap scripts run under tsx with no Next runtime and need this same
 * answer when they create an account's wallet. src/lib/telephony/billing.ts
 * re-exports it so application code has one place to import from.
 */

/**
 * Internal account slugs, comma-separated, overridable per install. The
 * default is the three houses ProdigyFlo runs itself. An AGENCY-kind org is
 * always internal regardless of the list.
 */
export function internalBillingSlugs(): Set<string> {
  const raw = process.env.TELEPHONY_INTERNAL_SLUGS ?? 'prodigyflo,cys,scs'
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

export function defaultBillingMode(org: { slug: string; kind: string }): TelephonyBilling {
  if (org.kind === 'AGENCY') return 'AGENCY_CARD'
  return internalBillingSlugs().has(org.slug.toLowerCase()) ? 'AGENCY_CARD' : 'WALLET'
}
