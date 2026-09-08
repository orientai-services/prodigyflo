'use server'

import { revalidatePath } from 'next/cache'
import type { CallRouting, PhoneNumberKind } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { ForbiddenError, requirePermission, requireUser, type SessionUser } from '@/lib/rbac'
import { grantStepUp } from '@/lib/stepup'
import {
  clearAgencyPassphrase,
  MIN_PASSPHRASE_LENGTH,
  setAgencyPassphrase,
  verifyAgencyPassphrase,
} from '@/lib/telephony/passphrase'
import { requireStepUp, StepUpRequiredError } from '@/lib/stepup'
import {
  provisionNumber,
  releaseNumber,
  searchAvailableNumbers,
  setPrimaryNumber,
  updateNumber,
} from '@/lib/telephony/numbers'
import { creditWallet, ensureWallet } from '@/lib/telephony/billing'
import { resumeSuspendedNumbers } from '@/lib/telephony/renewal'
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, money } from '@/lib/telephony/pricing'
import type { AvailableNumber, SearchNumbersInput } from '@/lib/telephony/provider'

/**
 * Server actions for the phone-numbers console.
 *
 * Every action re-checks permission on the server — a server action is a public
 * POST endpoint and the page gate protects nothing here — and the library
 * functions gate again underneath (defence in depth, same as the connectors
 * actions).
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; code?: string }

const FORBIDDEN = { ok: false as const, error: 'You do not have permission to manage phone numbers.' }

async function requireManage(): Promise<SessionUser | null> {
  try {
    return await requirePermission('telephony:manage')
  } catch (e) {
    if (e instanceof ForbiddenError) return null
    throw e
  }
}

function revalidate() {
  revalidatePath('/settings/phone-numbers')
  revalidatePath('/agency')
}

// ── The agency passphrase ────────────────────────────────────────────────────

export type PassphraseState = { error?: string; granted?: boolean }

const BURST_WINDOW_MS = 5 * 60 * 1000
const BURST_MAX = 5

/**
 * Confirms the shared agency provisioning passphrase and issues the 10-minute
 * 'telephony' step-up grant that internal accounts need to buy a number on the
 * agency card.
 *
 * Deliberately NOT confirmPasswordAction: that one takes the caller's own
 * login password, and an admin's login must never stand in for the owner's
 * authorisation to spend the card. Rate-limited the same way, by counting its
 * own denial audits, so a refused attempt extends the lockout instead of
 * resetting it. The submitted value is never audited, echoed, or logged.
 */
export async function confirmProvisioningPassphraseAction(
  _prev: PassphraseState,
  formData: FormData,
): Promise<PassphraseState> {
  const user = await requireUser()
  if (!user.permissions.has('telephony:manage')) {
    return { error: 'You do not have permission to buy phone numbers.' }
  }

  const recentDenials = await db.auditEvent.count({
    where: {
      organizationId: user.organizationId,
      actorId: user.id,
      action: 'telephony.passphrase_denied',
      createdAt: { gte: new Date(Date.now() - BURST_WINDOW_MS) },
    },
  })
  if (recentDenials >= BURST_MAX) {
    await recordAudit(user, {
      action: 'telephony.passphrase_denied',
      entityType: 'User',
      entityId: user.id,
      summary: 'Agency provisioning passphrase rate limited',
      after: { reason: 'rate_limited' },
    })
    return { error: 'Too many failed attempts. Wait a few minutes and try again.' }
  }

  const submitted = formData.get('passphrase')
  const check = await verifyAgencyPassphrase(typeof submitted === 'string' ? submitted : '', {
    // The passphrase belongs to the AGENCY, not to whichever client account is
    // currently active — an agency user buying a CYS line still presents the
    // agency's own passphrase.
    organizationId: user.homeOrganizationId ?? user.organizationId,
  })
  if (!check.ok) {
    if (check.code === 'WRONG') {
      await recordAudit(user, {
        action: 'telephony.passphrase_denied',
        entityType: 'User',
        entityId: user.id,
        summary: 'Agency provisioning passphrase denied',
        after: { reason: 'wrong_passphrase' },
      })
    }
    return { error: check.error }
  }

  await grantStepUp(user, 'telephony')
  await recordAudit(user, {
    action: 'telephony.passphrase_granted',
    entityType: 'User',
    entityId: user.id,
    summary: 'Agency provisioning passphrase accepted — numbers may be charged to the agency card for 10 minutes',
  })
  return { granted: true }
}

// ── Buying ───────────────────────────────────────────────────────────────────

export async function searchNumbersAction(
  input: SearchNumbersInput,
): Promise<Result<{ numbers: AvailableNumber[]; mock: boolean }>> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  return searchAvailableNumbers(user, input)
}

export async function buyNumberAction(input: {
  e164: string
  kind: PhoneNumberKind
  friendlyName: string
  routing?: CallRouting
  forwardTo?: string | null
  organizationId?: string
}): Promise<Result<{ phoneNumberId: string; e164: string; chargedCents: number }>> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  const res = await provisionNumber(user, input)
  if (res.ok) revalidate()
  return res
}

// ── Configuring ──────────────────────────────────────────────────────────────

export async function updateNumberAction(input: {
  phoneNumberId: string
  friendlyName?: string
  routing?: CallRouting
  forwardTo?: string | null
  teamUserIds?: string[]
  voicemailGreeting?: string | null
  recordCalls?: boolean
  assignedUserId?: string | null
}): Promise<Result> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  const res = await updateNumber(user, input)
  if (res.ok) revalidate()
  return res
}

export async function setPrimaryNumberAction(phoneNumberId: string): Promise<Result> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  const res = await setPrimaryNumber(user, phoneNumberId)
  if (res.ok) revalidate()
  return res
}

export async function releaseNumberAction(phoneNumberId: string): Promise<Result> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  const res = await releaseNumber(user, phoneNumberId)
  if (res.ok) revalidate()
  return res
}

// ── Funding ──────────────────────────────────────────────────────────────────

/**
 * Records funds received into an account's wallet.
 *
 * Restricted to AGENCY operators on purpose: until a card processor is
 * connected, money arrives out-of-band (transfer, invoice, card taken by the
 * agency) and someone has to attest that it did. Letting a client account
 * credit its own balance would make the whole funding gate decorative.
 *
 * A client account's own admins get requestFundsAction instead, which asks the
 * agency for a top-up rather than granting one.
 */
export async function recordTopUpAction(input: {
  organizationId: string
  amountCents: number
  reference?: string
}): Promise<Result<{ balanceCents: number; resumed: number }>> {
  const user = await requireManage()
  if (!user) return FORBIDDEN

  const isAgencyOperator = user.organizationKind === 'AGENCY'
  if (!isAgencyOperator) {
    return {
      ok: false,
      code: 'AGENCY_ONLY',
      error:
        'Only your account manager can record funds. Use “Request funds” and they will top the balance up.',
    }
  }

  const amountCents = Math.round(input.amountCents)
  if (!Number.isFinite(amountCents) || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_TOPUP_CENTS) {
    return {
      ok: false,
      code: 'BAD_AMOUNT',
      error: `Enter an amount between ${money(MIN_TOPUP_CENTS)} and ${money(MAX_TOPUP_CENTS)}.`,
    }
  }

  const home = user.homeOrganizationId ?? user.organizationId
  const allowed =
    input.organizationId === home ||
    (await db.organization.count({
      where: { id: input.organizationId, deletedAt: null, parentOrganizationId: home },
    })) > 0
  if (!allowed) return { ok: false, code: 'FORBIDDEN', error: 'That account is not one you manage.' }

  const reference = input.reference?.trim().slice(0, 120) || 'Funds received'
  const { balanceAfterCents } = await creditWallet({
    organizationId: input.organizationId,
    kind: 'TOPUP',
    amountCents,
    description: reference,
    createdById: user.id,
  })

  // A funded wallet brings suspended lines straight back.
  const resumed = await resumeSuspendedNumbers(input.organizationId)

  await recordAudit(user, {
    action: 'telephony.wallet_topup',
    entityType: 'TelephonyWallet',
    entityId: input.organizationId,
    summary: `Recorded ${money(amountCents)} into the telephony balance (${reference})`,
    after: { organizationId: input.organizationId, amountCents, balanceAfterCents, resumed },
  })

  revalidate()
  return { ok: true, balanceCents: balanceAfterCents, resumed }
}

/** Asks the agency to top this account up. Notifies, never credits. */
export async function requestFundsAction(input: {
  amountCents: number
  note?: string
}): Promise<Result<{ notified: number }>> {
  const user = await requireManage()
  if (!user) return FORBIDDEN

  const amountCents = Math.round(input.amountCents)
  if (!Number.isFinite(amountCents) || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_TOPUP_CENTS) {
    return { ok: false, code: 'BAD_AMOUNT', error: `Enter an amount between ${money(MIN_TOPUP_CENTS)} and ${money(MAX_TOPUP_CENTS)}.` }
  }

  const org = await db.organization.findUniqueOrThrow({
    where: { id: user.organizationId },
    select: { name: true, parentOrganizationId: true },
  })
  const billTo = org.parentOrganizationId
  if (!billTo) {
    return {
      ok: false,
      code: 'NO_AGENCY',
      error: 'This account has no agency to bill. Ask an owner to record the funds directly.',
    }
  }

  const admins = await db.user.findMany({
    where: {
      organizationId: billTo,
      isActive: true,
      deletedAt: null,
      role: { permissions: { some: { permission: { key: 'telephony:manage' } } } },
    },
    select: { id: true },
  })
  if (admins.length === 0) return { ok: false, code: 'NO_ADMINS', error: 'No one at the agency can be notified right now.' }

  const note = input.note?.trim().slice(0, 200)
  await db.notification.createMany({
    data: admins.map((a) => ({
      organizationId: billTo,
      userId: a.id,
      kind: 'SYSTEM' as const,
      title: `${org.name} requested ${money(amountCents)} in phone credit`,
      body: note ? `${user.name}: “${note}”` : `${user.name} asked for the telephony balance to be topped up.`,
      href: '/agency',
    })),
  })

  await recordAudit(user, {
    action: 'telephony.funds_requested',
    entityType: 'TelephonyWallet',
    entityId: user.organizationId,
    summary: `Requested ${money(amountCents)} in phone credit`,
    after: { amountCents, notified: admins.length },
  })

  return { ok: true, notified: admins.length }
}

/** Used by the agency console to show a child account's balance. */
export async function walletSnapshotAction(organizationId: string): Promise<
  Result<{ balanceCents: number; billingMode: string }>
> {
  const user = await requireManage()
  if (!user) return FORBIDDEN
  const home = user.homeOrganizationId ?? user.organizationId
  const allowed =
    organizationId === home ||
    (await db.organization.count({ where: { id: organizationId, deletedAt: null, parentOrganizationId: home } })) > 0
  if (!allowed) return { ok: false, error: 'That account is not one you manage.' }
  const wallet = await ensureWallet(organizationId)
  return { ok: true, balanceCents: wallet.balanceCents, billingMode: wallet.billingMode }
}

// ── Managing the passphrase itself (owner only) ─────────────────────────────

/**
 * Sets or replaces the agency provisioning passphrase from the console, so
 * turning the money gate on never needs a shell on the server.
 *
 * Two locks, and both are checked here rather than trusted from the UI:
 * only the organization's true owner may do it, and they must have confirmed
 * their OWN password in the last ten minutes (the 'vault' step-up, the same
 * one that guards connector credentials). The passphrase never appears in the
 * audit record — only the fact that it changed.
 */
async function requireOwnerWithVaultStepUp(): Promise<
  { ok: true; user: SessionUser } | { ok: false; error: string; code?: string }
> {
  const user = await requireUser()
  if (!user.isOwner) {
    return { ok: false, code: 'OWNER_ONLY', error: 'Only the account owner can change the provisioning passphrase.' }
  }
  try {
    await requireStepUp(user, 'vault')
  } catch (e) {
    if (e instanceof StepUpRequiredError) {
      return { ok: false, code: 'STEP_UP_REQUIRED', error: e.message }
    }
    throw e
  }
  return { ok: true, user }
}

export async function setProvisioningPassphraseAction(input: {
  passphrase: string
  confirm: string
}): Promise<Result> {
  const gate = await requireOwnerWithVaultStepUp()
  if (!gate.ok) return gate
  const { user } = gate

  if (input.passphrase !== input.confirm) {
    return { ok: false, code: 'MISMATCH', error: 'The two entries do not match.' }
  }
  if (input.passphrase.trim().length < MIN_PASSPHRASE_LENGTH) {
    return { ok: false, code: 'TOO_SHORT', error: `Use at least ${MIN_PASSPHRASE_LENGTH} characters.` }
  }

  const orgId = user.homeOrganizationId ?? user.organizationId
  const res = await setAgencyPassphrase(orgId, input.passphrase)
  if (!res.ok) return { ok: false, code: 'REJECTED', error: res.error }

  await recordAudit(user, {
    action: 'telephony.passphrase_set',
    entityType: 'Organization',
    entityId: orgId,
    summary: 'Agency provisioning passphrase set from the console',
  })
  revalidate()
  return { ok: true }
}

export async function clearProvisioningPassphraseAction(): Promise<Result> {
  const gate = await requireOwnerWithVaultStepUp()
  if (!gate.ok) return gate
  const { user } = gate

  const orgId = user.homeOrganizationId ?? user.organizationId
  await clearAgencyPassphrase(orgId)
  await recordAudit(user, {
    action: 'telephony.passphrase_cleared',
    entityType: 'Organization',
    entityId: orgId,
    summary: 'Agency provisioning passphrase removed from the console',
  })
  revalidate()
  return { ok: true }
}
