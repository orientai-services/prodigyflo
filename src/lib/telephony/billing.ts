import 'server-only'
import type { Prisma, TelephonyBilling, WalletEntryKind } from '@prisma/client'
import { db } from '@/lib/db'
import { money, type NumberQuote } from './pricing'
import { defaultBillingMode } from './billing-mode'

/**
 * The telephony wallet — who may buy a phone number, and what it costs them.
 *
 * Two billing modes, and every gate in the feature reduces to which one an
 * account is in:
 *
 *  - WALLET (default, every outside client): the account keeps a prepaid
 *    balance. A number can only be bought when the balance covers setup plus
 *    the first month, and the monthly renewal debits the same balance. Run it
 *    dry and the numbers suspend — they are never silently released.
 *
 *  - AGENCY_CARD (internal accounts only — ProdigyFlo itself, CYS, SCS): the
 *    charge lands on the agency's card at the carrier, so there is no balance
 *    to check. The money gate is replaced by the agency provisioning
 *    passphrase (see ./passphrase), because "no balance required" must not
 *    mean "anyone with an admin login can spend the owner's card".
 *
 * Every movement writes a WalletEntry inside the same transaction that moves
 * the balance, so the ledger always replays to the stored number.
 */

// Which accounts ride the agency card lives in its own runtime-free module so
// the seed/bootstrap scripts can share it.
export { defaultBillingMode, internalBillingSlugs } from './billing-mode'

export type WalletView = {
  organizationId: string
  billingMode: TelephonyBilling
  balanceCents: number
  reserveCents: number
  /** Total charged to the agency card, all time. AGENCY_CARD accounts only. */
  agencyChargedCents: number
}

/**
 * Reads (creating on first touch) the account's wallet.
 *
 * The billing mode is derived from the org's identity, and keeps being
 * re-derived for as long as the wallet has NO HISTORY — zero balance and not a
 * single ledger entry. A wallet in that state has never been used, so nothing
 * is lost by correcting it, and this is what makes the internal-account list a
 * live setting rather than a one-shot guess: an account added to
 * TELEPHONY_INTERNAL_SLUGS (or created before that list existed, or backfilled
 * by a migration that could not read env) lands on the agency card without a
 * data fix.
 *
 * The moment a wallet has any history the stored mode wins for good, so an
 * owner's deliberate change is never undone underneath them.
 */
export async function ensureWallet(organizationId: string): Promise<WalletView> {
  const org = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { slug: true, kind: true },
  })
  const derived = defaultBillingMode(org)

  let wallet = await db.telephonyWallet.upsert({
    where: { organizationId },
    update: {},
    create: { organizationId, billingMode: derived },
    select: { id: true, billingMode: true, balanceCents: true, reserveCents: true },
  })

  if (wallet.billingMode !== derived && wallet.balanceCents === 0) {
    const used = await db.walletEntry.count({ where: { walletId: wallet.id } })
    if (used === 0) {
      wallet = await db.telephonyWallet.update({
        where: { id: wallet.id },
        data: { billingMode: derived },
        select: { id: true, billingMode: true, balanceCents: true, reserveCents: true },
      })
    }
  }

  const charged =
    wallet.billingMode === 'AGENCY_CARD'
      ? await db.walletEntry.aggregate({
          where: { organizationId, amountCents: { lt: 0 } },
          _sum: { amountCents: true },
        })
      : null

  return {
    organizationId,
    billingMode: wallet.billingMode,
    balanceCents: wallet.balanceCents,
    reserveCents: wallet.reserveCents,
    agencyChargedCents: Math.abs(charged?._sum.amountCents ?? 0),
  }
}

// ── Gate ─────────────────────────────────────────────────────────────────────

export type FundingCheck =
  | { ok: true; mode: TelephonyBilling }
  | { ok: false; mode: TelephonyBilling; code: 'INSUFFICIENT_FUNDS'; error: string; shortfallCents: number }

/**
 * Can this account afford one more number right now? AGENCY_CARD always can —
 * its gate is the passphrase, checked separately by the caller, never here.
 */
export function checkFunding(wallet: WalletView, quote: NumberQuote): FundingCheck {
  if (wallet.billingMode === 'AGENCY_CARD') return { ok: true, mode: wallet.billingMode }

  const spendable = wallet.balanceCents - wallet.reserveCents
  if (spendable >= quote.dueTodayCents) return { ok: true, mode: wallet.billingMode }

  const shortfallCents = quote.dueTodayCents - spendable
  return {
    ok: false,
    mode: wallet.billingMode,
    code: 'INSUFFICIENT_FUNDS',
    error: `This number costs ${money(quote.dueTodayCents)} today and the account has ${money(Math.max(spendable, 0))} available. Add ${money(shortfallCents)} to continue.`,
    shortfallCents,
  }
}

// ── Movements ────────────────────────────────────────────────────────────────

export class InsufficientFundsError extends Error {
  readonly shortfallCents: number
  constructor(shortfallCents: number) {
    super(`Not enough funds — ${money(shortfallCents)} short.`)
    this.name = 'InsufficientFundsError'
    this.shortfallCents = shortfallCents
  }
}

export type MovementInput = {
  organizationId: string
  kind: WalletEntryKind
  /** Always positive; `debit` and `credit` apply the sign. */
  amountCents: number
  description: string
  phoneNumberId?: string | null
  externalRef?: string | null
  createdById?: string | null
}

type Tx = Prisma.TransactionClient

/**
 * Applies one signed movement inside an existing transaction. Callers that
 * need the movement and another write (buying a number) to be atomic pass
 * their own tx; `credit`/`debit` open one when they are the whole operation.
 *
 * AGENCY_CARD accounts do not carry a balance: the entry is still written (so
 * the owner can see everything the agency card is paying for) but the stored
 * balance is left alone and `balanceAfterCents` records it unchanged.
 */
export async function applyMovement(
  tx: Tx,
  input: MovementInput & { signedAmountCents: number },
): Promise<{ balanceAfterCents: number; entryId: string }> {
  const wallet = await tx.telephonyWallet.findUniqueOrThrow({
    where: { organizationId: input.organizationId },
    select: { id: true, balanceCents: true, reserveCents: true, billingMode: true },
  })

  const onAgencyCard = wallet.billingMode === 'AGENCY_CARD'
  let balanceAfterCents = wallet.balanceCents

  if (!onAgencyCard) {
    const next = wallet.balanceCents + input.signedAmountCents
    // Re-check inside the transaction: the pre-flight checkFunding() happened
    // before the carrier call, and two admins can buy at the same moment.
    if (input.signedAmountCents < 0 && next < wallet.reserveCents) {
      throw new InsufficientFundsError(wallet.reserveCents - next)
    }
    balanceAfterCents = next
    await tx.telephonyWallet.update({
      where: { id: wallet.id },
      data: { balanceCents: next },
    })
  }

  const entry = await tx.walletEntry.create({
    data: {
      organizationId: input.organizationId,
      walletId: wallet.id,
      kind: input.kind,
      amountCents: input.signedAmountCents,
      balanceAfterCents,
      description: input.description,
      phoneNumberId: input.phoneNumberId ?? null,
      externalRef: input.externalRef ?? null,
      createdById: input.createdById ?? null,
    },
    select: { id: true },
  })

  return { balanceAfterCents, entryId: entry.id }
}

/** Money in. Always increases the balance (WALLET) or logs a credit (AGENCY_CARD). */
export async function creditWallet(input: MovementInput): Promise<{ balanceAfterCents: number }> {
  await ensureWallet(input.organizationId)
  return db.$transaction((tx) =>
    applyMovement(tx, { ...input, signedAmountCents: Math.abs(input.amountCents) }),
  )
}

/** Money out. Throws InsufficientFundsError rather than letting a balance go under. */
export async function debitWallet(input: MovementInput): Promise<{ balanceAfterCents: number }> {
  await ensureWallet(input.organizationId)
  return db.$transaction((tx) =>
    applyMovement(tx, { ...input, signedAmountCents: -Math.abs(input.amountCents) }),
  )
}

// ── Ledger ───────────────────────────────────────────────────────────────────

export type LedgerRow = {
  id: string
  kind: WalletEntryKind
  amountCents: number
  balanceAfterCents: number
  description: string
  createdAt: Date
  numberE164: string | null
  actorName: string | null
}

export async function recentLedger(organizationId: string, take = 25): Promise<LedgerRow[]> {
  const rows = await db.walletEntry.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      kind: true,
      amountCents: true,
      balanceAfterCents: true,
      description: true,
      createdAt: true,
      phoneNumber: { select: { e164: true } },
      createdBy: { select: { name: true } },
    },
  })
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountCents: r.amountCents,
    balanceAfterCents: r.balanceAfterCents,
    description: r.description,
    createdAt: r.createdAt,
    numberE164: r.phoneNumber?.e164 ?? null,
    actorName: r.createdBy?.name ?? null,
  }))
}
