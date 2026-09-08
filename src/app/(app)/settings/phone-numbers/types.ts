import type { CallRouting, PhoneNumberKind, PhoneNumberStatus, TelephonyBilling, WalletEntryKind } from '@prisma/client'

/**
 * The serialized shapes the phone-numbers console renders. Everything here
 * crosses the RSC boundary, so it is plain strings, numbers and booleans —
 * money and dates arrive preformatted from the server.
 */

export type NumberVM = {
  id: string
  e164: string
  /** "(702) 555-0142" */
  display: string
  friendlyName: string
  kind: PhoneNumberKind
  status: PhoneNumberStatus
  isPrimary: boolean
  place: string | null
  routing: CallRouting
  forwardTo: string | null
  forwardToDisplay: string | null
  teamUserIds: string[]
  voicemailGreeting: string | null
  recordCalls: boolean
  assignedUserId: string | null
  assignedUserName: string | null
  monthlyLabel: string
  renewsLabel: string | null
  provider: string
}

export type LedgerRowVM = {
  id: string
  kind: WalletEntryKind
  /** "+$25.00" / "−$3.00" */
  amountLabel: string
  isCredit: boolean
  balanceLabel: string
  description: string
  when: string
  numberDisplay: string | null
  actorName: string | null
}

export type MemberVM = { id: string; name: string; hasPhone: boolean }

/** Preformatted prices, straight from src/lib/telephony/pricing.ts. */
export type QuoteVM = {
  monthlyLabel: string
  dueTodayLabel: string
  dueTodayCents: number
}

export type ConsoleVM = {
  organizationId: string
  organizationName: string
  canManage: boolean
  /** The caller's HOME org is the agency — only they may record funds. */
  isAgencyOperator: boolean
  /** Numbers are being minted by the deterministic mock carrier. */
  mockCarrier: boolean
  /** A real carrier is reachable (or the mock is in use). */
  carrierConfigured: boolean
  billingMode: TelephonyBilling
  balanceLabel: string
  balanceCents: number
  agencyChargedLabel: string
  monthlyTotalLabel: string
  /** The server can check the agency provisioning passphrase. */
  passphraseConfigured: boolean
  /** 'app' = set by the owner here; 'env' = a server variable; null = not set. */
  passphraseSource: 'app' | 'env' | null
  /** The true owner — only they may set or rotate the passphrase. */
  isOwner: boolean
  pricing: Record<PhoneNumberKind, QuoteVM>
  numbers: NumberVM[]
  ledger: LedgerRowVM[]
  members: MemberVM[]
}
