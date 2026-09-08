import 'server-only'
import type { CallRouting, PhoneNumberKind, PhoneNumberStatus, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { can, type SessionUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { requireStepUp, StepUpRequiredError } from '@/lib/stepup'
import {
  getTelephonyProvider,
  telephonyCredentials,
  webhooksFor,
  type AvailableNumber,
  type SearchNumbersInput,
} from './index'
import { formatE164, toE164 } from './provider'
import { money, quoteNumber } from './pricing'
import { applyMovement, checkFunding, ensureWallet, InsufficientFundsError } from './billing'

/**
 * Phone numbers: buying one, pointing it somewhere, and giving it back.
 *
 * The order of a purchase is deliberate and is the whole feature in one list:
 *
 *   permission → account + wallet → quote → money gate → carrier → persist
 *
 * The money gate is the fork the owner asked for. A WALLET account must have
 * the funds; an AGENCY_CARD account (ProdigyFlo, CYS, SCS) must instead present
 * the agency provisioning passphrase, which the caller converts into a
 * short-lived 'telephony' step-up grant before getting here.
 *
 * The carrier call happens BEFORE the ledger write, and the ledger write is
 * one transaction with the PhoneNumber row. If that transaction fails — most
 * plausibly because a second admin drained the balance in the meantime — the
 * number is handed straight back to the carrier rather than kept unpaid.
 */

export type NumberActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; code?: string }

const NO_PERMISSION = {
  ok: false as const,
  error: 'You do not have permission to manage phone numbers.',
  code: 'FORBIDDEN',
}

function targetOrganizationId(user: SessionUser): string {
  // The ACTIVE org: an agency user working inside CYS buys CYS's numbers.
  return user.organizationId
}

// ── Search ───────────────────────────────────────────────────────────────────

export async function searchAvailableNumbers(
  user: SessionUser,
  input: SearchNumbersInput,
): Promise<NumberActionResult<{ numbers: AvailableNumber[]; mock: boolean }>> {
  if (!can(user, 'telephony:manage')) return NO_PERMISSION

  const provider = getTelephonyProvider()
  if (provider.isMock) {
    return { ok: true, numbers: await provider.searchNumbers(input, { accountSid: '', authToken: '' }), mock: true }
  }

  const creds = await telephonyCredentials(targetOrganizationId(user))
  if (!creds) {
    return {
      ok: false,
      code: 'NO_CREDENTIALS',
      error:
        'No carrier credentials are configured for this account. Add the Twilio Account SID and Auth Token under Settings → Connectors → Twilio SMS, or set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN on the server.',
    }
  }
  return { ok: true, numbers: await provider.searchNumbers(input, creds), mock: false }
}

// ── Buy ──────────────────────────────────────────────────────────────────────

export type ProvisionInput = {
  e164: string
  kind: PhoneNumberKind
  friendlyName: string
  routing?: CallRouting
  forwardTo?: string | null
  /** Buy for a child account instead of the active one (agency console). */
  organizationId?: string
}

export async function provisionNumber(
  user: SessionUser,
  input: ProvisionInput,
): Promise<NumberActionResult<{ phoneNumberId: string; e164: string; chargedCents: number }>> {
  if (!can(user, 'telephony:manage')) return NO_PERMISSION

  const e164 = toE164(input.e164)
  if (!e164) return { ok: false, code: 'BAD_NUMBER', error: 'That is not a valid phone number.' }

  const organizationId = await resolveTargetOrg(user, input.organizationId)
  if (!organizationId) {
    return { ok: false, code: 'FORBIDDEN', error: 'That account is not one you can buy numbers for.' }
  }

  const friendlyName = input.friendlyName.trim().slice(0, 80)
  if (!friendlyName) return { ok: false, code: 'NO_LABEL', error: 'Give the number a label so the team knows what it is for.' }

  const forwardTo = input.forwardTo ? toE164(input.forwardTo) : null
  const routing: CallRouting = input.routing ?? (forwardTo ? 'FORWARD' : 'VOICEMAIL_ONLY')
  if (routing === 'FORWARD' && !forwardTo) {
    return { ok: false, code: 'NO_FORWARD', error: 'Forwarding needs a number to ring. Enter one, or choose voicemail.' }
  }

  // Never sell the same number twice, and never resurrect a released row.
  const taken = await db.phoneNumber.findUnique({ where: { e164 }, select: { status: true } })
  if (taken && taken.status !== 'RELEASED') {
    return { ok: false, code: 'TAKEN', error: 'That number is already on an account here.' }
  }

  const wallet = await ensureWallet(organizationId)
  const quote = quoteNumber(input.kind)

  // ── the money gate ──
  if (wallet.billingMode === 'AGENCY_CARD') {
    try {
      await requireStepUp(user, 'telephony')
    } catch (e) {
      if (e instanceof StepUpRequiredError) {
        return {
          ok: false,
          code: 'PASSPHRASE_REQUIRED',
          error: 'This account bills to the agency card. Enter the agency provisioning passphrase to continue.',
        }
      }
      throw e
    }
  } else {
    const funding = checkFunding(wallet, quote)
    if (!funding.ok) return { ok: false, code: funding.code, error: funding.error }
  }

  // ── carrier ──
  const provider = getTelephonyProvider()
  const creds = provider.isMock
    ? { accountSid: '', authToken: '' }
    : await telephonyCredentials(organizationId)
  if (!creds) {
    return {
      ok: false,
      code: 'NO_CREDENTIALS',
      error: 'No carrier credentials are configured for this account, so no number can be bought yet.',
    }
  }

  const purchase = await provider.purchase(
    { e164, friendlyName, webhooks: webhooksFor() },
    creds,
  )
  if (!purchase.ok) {
    await recordAudit(user, {
      action: 'telephony.purchase_failed',
      entityType: 'PhoneNumber',
      summary: `Carrier refused ${formatE164(e164)}: ${purchase.error}`,
      after: { organizationId, e164, provider: provider.name, error: purchase.error },
    })
    return { ok: false, code: 'CARRIER_ERROR', error: purchase.error }
  }
  const bought = purchase.number

  // ── persist: the row and the charge move together or not at all ──
  const now = new Date()
  const nextRenewalAt = new Date(now)
  nextRenewalAt.setMonth(nextRenewalAt.getMonth() + 1)

  try {
    const created = await db.$transaction(async (tx) => {
      // Only one primary line per account: the first ACTIVE number claims it.
      const existingPrimary = await tx.phoneNumber.count({
        where: { organizationId, isPrimary: true, status: { in: ['ACTIVE', 'PENDING'] } },
      })

      const row = await tx.phoneNumber.upsert({
        where: { e164: bought.e164 },
        create: {
          organizationId,
          e164: bought.e164,
          friendlyName,
          kind: input.kind,
          status: 'ACTIVE',
          isPrimary: existingPrimary === 0,
          areaCode: bought.areaCode,
          region: bought.region,
          locality: bought.locality,
          provider: provider.name,
          providerSid: bought.providerSid,
          capabilities: bought.capabilities as unknown as Prisma.InputJsonValue,
          routing,
          forwardTo,
          billingMode: wallet.billingMode,
          monthlyCostCents: quote.monthlyCents,
          setupCostCents: quote.setupCents,
          nextRenewalAt,
          createdById: user.id,
        },
        update: {
          organizationId,
          friendlyName,
          kind: input.kind,
          status: 'ACTIVE',
          isPrimary: existingPrimary === 0,
          areaCode: bought.areaCode,
          region: bought.region,
          locality: bought.locality,
          provider: provider.name,
          providerSid: bought.providerSid,
          capabilities: bought.capabilities as unknown as Prisma.InputJsonValue,
          routing,
          forwardTo,
          billingMode: wallet.billingMode,
          monthlyCostCents: quote.monthlyCents,
          setupCostCents: quote.setupCents,
          nextRenewalAt,
          releasedAt: null,
          createdById: user.id,
        },
        select: { id: true },
      })

      if (quote.dueTodayCents > 0) {
        await applyMovement(tx, {
          organizationId,
          kind: 'NUMBER_MONTHLY',
          amountCents: quote.dueTodayCents,
          signedAmountCents: -quote.dueTodayCents,
          description: `${formatE164(bought.e164)} — ${friendlyName} (first month${quote.setupCents > 0 ? ' + setup' : ''})`,
          phoneNumberId: row.id,
          externalRef: bought.providerSid,
          createdById: user.id,
        })
      }
      return row
    })

    await recordAudit(user, {
      action: 'telephony.number_purchased',
      entityType: 'PhoneNumber',
      entityId: created.id,
      summary: `Bought ${formatE164(bought.e164)} (${friendlyName}) — ${money(quote.dueTodayCents)} ${wallet.billingMode === 'AGENCY_CARD' ? 'on the agency card' : 'from the account balance'}`,
      after: {
        organizationId,
        e164: bought.e164,
        provider: provider.name,
        billingMode: wallet.billingMode,
        dueTodayCents: quote.dueTodayCents,
        routing,
      },
    })

    return { ok: true, phoneNumberId: created.id, e164: bought.e164, chargedCents: quote.dueTodayCents }
  } catch (err) {
    // The charge could not be recorded — hand the number straight back rather
    // than keep a line nobody paid for.
    const release = await provider.release(bought.providerSid, creds)
    await recordAudit(user, {
      action: 'telephony.purchase_rolled_back',
      entityType: 'PhoneNumber',
      summary: `Rolled back ${formatE164(bought.e164)} — the charge could not be recorded${release.ok ? ' and the number was released' : `; RELEASE FAILED (${release.error}) — release it manually at the carrier`}`,
      after: { organizationId, e164: bought.e164, providerSid: bought.providerSid, released: release.ok },
    })
    if (err instanceof InsufficientFundsError) {
      return { ok: false, code: 'INSUFFICIENT_FUNDS', error: `${err.message} The number was not kept.` }
    }
    throw err
  }
}

/**
 * Which account this action may touch. Absent an explicit id it is the active
 * org; an explicit id is only allowed when it is the caller's own agency or one
 * of its direct child accounts.
 */
async function resolveTargetOrg(user: SessionUser, requested?: string): Promise<string | null> {
  const active = targetOrganizationId(user)
  if (!requested || requested === active) return active

  const home = user.homeOrganizationId ?? active
  if (requested === home) return home
  const child = await db.organization.findFirst({
    where: { id: requested, deletedAt: null, parentOrganizationId: home },
    select: { id: true },
  })
  return child?.id ?? null
}

// ── Configure ────────────────────────────────────────────────────────────────

export type UpdateNumberInput = {
  phoneNumberId: string
  friendlyName?: string
  routing?: CallRouting
  forwardTo?: string | null
  teamUserIds?: string[]
  voicemailGreeting?: string | null
  recordCalls?: boolean
  assignedUserId?: string | null
}

export async function updateNumber(
  user: SessionUser,
  input: UpdateNumberInput,
): Promise<NumberActionResult> {
  if (!can(user, 'telephony:manage')) return NO_PERMISSION

  const number = await findNumberInScope(user, input.phoneNumberId)
  if (!number) return { ok: false, code: 'NOT_FOUND', error: 'That number is not on an account you manage.' }

  const data: Prisma.PhoneNumberUpdateInput = {}

  if (input.friendlyName !== undefined) {
    const label = input.friendlyName.trim().slice(0, 80)
    if (!label) return { ok: false, code: 'NO_LABEL', error: 'The label cannot be empty.' }
    data.friendlyName = label
  }

  const routing = input.routing ?? number.routing
  if (input.forwardTo !== undefined) {
    const forwardTo = input.forwardTo ? toE164(input.forwardTo) : null
    if (input.forwardTo && !forwardTo) {
      return { ok: false, code: 'BAD_NUMBER', error: 'That forwarding number is not a valid phone number.' }
    }
    data.forwardTo = forwardTo
  }
  const effectiveForward = input.forwardTo !== undefined ? (input.forwardTo ? toE164(input.forwardTo) : null) : number.forwardTo

  if (input.routing !== undefined) data.routing = input.routing

  if (routing === 'FORWARD' && !effectiveForward) {
    return { ok: false, code: 'NO_FORWARD', error: 'Forwarding needs a number to ring. Enter one, or choose voicemail.' }
  }

  if (input.teamUserIds !== undefined) {
    // Only real, active members of the SAME account may be rung.
    const members = await db.user.findMany({
      where: {
        id: { in: input.teamUserIds.slice(0, 10) },
        organizationId: number.organizationId,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true },
    })
    const valid = input.teamUserIds.filter((id) => members.some((m) => m.id === id))
    if (routing === 'TEAM' && valid.length === 0) {
      return { ok: false, code: 'NO_TEAM', error: 'Pick at least one teammate for the call to ring.' }
    }
    data.teamUserIds = valid
  } else if (routing === 'TEAM' && (number.teamUserIds as string[]).length === 0) {
    return { ok: false, code: 'NO_TEAM', error: 'Pick at least one teammate for the call to ring.' }
  }

  if (input.voicemailGreeting !== undefined) {
    data.voicemailGreeting = input.voicemailGreeting?.trim().slice(0, 500) || null
  }
  if (input.recordCalls !== undefined) data.recordCalls = input.recordCalls

  if (input.assignedUserId !== undefined) {
    if (input.assignedUserId === null) {
      data.assignedUser = { disconnect: true }
    } else {
      const member = await db.user.findFirst({
        where: { id: input.assignedUserId, organizationId: number.organizationId, isActive: true, deletedAt: null },
        select: { id: true },
      })
      if (!member) return { ok: false, code: 'NOT_A_MEMBER', error: 'That person is not an active user on this account.' }
      data.assignedUser = { connect: { id: member.id } }
    }
  }

  await db.phoneNumber.update({ where: { id: number.id }, data })
  await recordAudit(user, {
    action: 'telephony.number_updated',
    entityType: 'PhoneNumber',
    entityId: number.id,
    summary: `Updated call handling for ${formatE164(number.e164)}`,
    before: {
      routing: number.routing,
      forwardTo: number.forwardTo,
      recordCalls: number.recordCalls,
      friendlyName: number.friendlyName,
    },
    after: { routing, forwardTo: effectiveForward, ...('recordCalls' in data ? { recordCalls: data.recordCalls } : {}) },
  })
  return { ok: true }
}

/** Exactly one ACTIVE number per account carries isPrimary. */
export async function setPrimaryNumber(
  user: SessionUser,
  phoneNumberId: string,
): Promise<NumberActionResult> {
  if (!can(user, 'telephony:manage')) return NO_PERMISSION
  const number = await findNumberInScope(user, phoneNumberId)
  if (!number) return { ok: false, code: 'NOT_FOUND', error: 'That number is not on an account you manage.' }
  if (number.status !== 'ACTIVE') {
    return { ok: false, code: 'NOT_ACTIVE', error: 'Only an active number can be the main line.' }
  }

  await db.$transaction([
    db.phoneNumber.updateMany({
      where: { organizationId: number.organizationId, isPrimary: true },
      data: { isPrimary: false },
    }),
    db.phoneNumber.update({ where: { id: number.id }, data: { isPrimary: true } }),
  ])

  await recordAudit(user, {
    action: 'telephony.primary_changed',
    entityType: 'PhoneNumber',
    entityId: number.id,
    summary: `${formatE164(number.e164)} is now the main line`,
    after: { organizationId: number.organizationId, e164: number.e164 },
  })
  return { ok: true }
}

/**
 * Hands a number back to the carrier. Deliberately irreversible and warned
 * about in the UI: once released, the number goes back into the general pool
 * and anyone can buy it. Billing stops immediately — no refund of the current
 * month, which is how the carrier bills us too.
 */
export async function releaseNumber(
  user: SessionUser,
  phoneNumberId: string,
): Promise<NumberActionResult> {
  if (!can(user, 'telephony:manage')) return NO_PERMISSION
  const number = await findNumberInScope(user, phoneNumberId)
  if (!number) return { ok: false, code: 'NOT_FOUND', error: 'That number is not on an account you manage.' }
  if (number.status === 'RELEASED') return { ok: true }

  const provider = getTelephonyProvider()
  const creds = provider.isMock
    ? { accountSid: '', authToken: '' }
    : await telephonyCredentials(number.organizationId)

  if (number.providerSid && creds) {
    const res = await provider.release(number.providerSid, creds)
    if (!res.ok) return { ok: false, code: 'CARRIER_ERROR', error: res.error }
  }

  await db.phoneNumber.update({
    where: { id: number.id },
    data: { status: 'RELEASED', isPrimary: false, releasedAt: new Date(), nextRenewalAt: null },
  })

  // If the main line just went away, promote another active number so the
  // account never ends up sending SMS from nowhere.
  if (number.isPrimary) {
    const next = await db.phoneNumber.findFirst({
      where: { organizationId: number.organizationId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (next) await db.phoneNumber.update({ where: { id: next.id }, data: { isPrimary: true } })
  }

  await recordAudit(user, {
    action: 'telephony.number_released',
    entityType: 'PhoneNumber',
    entityId: number.id,
    summary: `Released ${formatE164(number.e164)} back to the carrier`,
    before: { status: number.status, isPrimary: number.isPrimary },
    after: { status: 'RELEASED', organizationId: number.organizationId },
  })
  return { ok: true }
}

// ── Reads ────────────────────────────────────────────────────────────────────

const NUMBER_SELECT = {
  id: true,
  organizationId: true,
  e164: true,
  friendlyName: true,
  kind: true,
  status: true,
  isPrimary: true,
  region: true,
  locality: true,
  provider: true,
  providerSid: true,
  capabilities: true,
  routing: true,
  forwardTo: true,
  teamUserIds: true,
  voicemailGreeting: true,
  recordCalls: true,
  assignedUserId: true,
  billingMode: true,
  monthlyCostCents: true,
  nextRenewalAt: true,
  createdAt: true,
  assignedUser: { select: { id: true, name: true } },
} as const

export type NumberRecord = Prisma.PhoneNumberGetPayload<{ select: typeof NUMBER_SELECT }>

/** Scope rule: a number is reachable when it belongs to the active account, or
 *  — for an agency user — to the agency or one of its direct children. */
async function findNumberInScope(user: SessionUser, phoneNumberId: string): Promise<NumberRecord | null> {
  const number = await db.phoneNumber.findUnique({ where: { id: phoneNumberId }, select: NUMBER_SELECT })
  if (!number) return null
  const allowed = await resolveTargetOrg(user, number.organizationId)
  return allowed === number.organizationId ? number : null
}

export async function listNumbers(organizationId: string, includeReleased = false): Promise<NumberRecord[]> {
  const status: PhoneNumberStatus[] = includeReleased
    ? ['PENDING', 'ACTIVE', 'SUSPENDED', 'RELEASED']
    : ['PENDING', 'ACTIVE', 'SUSPENDED']
  return db.phoneNumber.findMany({
    where: { organizationId, status: { in: status } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: NUMBER_SELECT,
  })
}

/** The number an account sends SMS from: its main line, else its oldest active one. */
export async function primaryNumberFor(organizationId: string): Promise<string | null> {
  const row = await db.phoneNumber.findFirst({
    where: { organizationId, status: 'ACTIVE' },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: { e164: true },
  })
  return row?.e164 ?? null
}
