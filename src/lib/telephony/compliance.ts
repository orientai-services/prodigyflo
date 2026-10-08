import 'server-only'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { isStopMessage } from '@/lib/messaging/consent'
import type { SessionUser } from '@/lib/rbac'
import {
  evaluateOutbound,
  phoneHash,
  type ClientConsentFact,
  type LeadConsentFact,
  type OutboundChannel,
  type OutboundDecision,
  type OutboundFacts,
} from './compliance-core'
import { toE164 } from './provider'
import { readTelephonySettings } from './settings'
import type { ZoneHints } from './timezones'
import type { OutboundPurpose } from './voice-contract'

/**
 * The ONE outbound decision every call and text runs through (§2.7):
 * Call Center "Call" (checkDial before the tel: link, and before
 * Device.connect), the browser-call webhook, client SMS and automation SMS.
 *
 * The rules themselves are pure (compliance-core.ts) and re-exported here;
 * this file gathers the facts. It FAILS CLOSED: any read error, or a missing
 * PHONE_HASH_KEY, is CHECK_FAILED — never an allow. User.phone is never read:
 * it is self-editable, so it can't vouch for anything.
 */

export * from './compliance-core'
export { deferUntil } from './timezones'
export { isRevocationText } from '@/lib/messaging/consent'

export const REPLY_WINDOW_MS = 30 * 60_000

export type OutboundInput = {
  organizationId: string
  channel: OutboundChannel
  purpose: OutboundPurpose
  phone: string | null
  servicingBasis?: string | null
  clientId?: string | null
  leadId?: string | null
  zoneHints: ZoneHints
  /**
   * A scheduled or sequence send. The 30-minute reply window is for a person
   * answering a text; automation never uses it, so it keeps quiet hours,
   * Sundays, holidays and the unknown-zone rule (§2.7).
   */
  automated?: boolean
}

export async function loadOutboundFacts(input: OutboundInput, now: Date): Promise<OutboundFacts> {
  const e164 = input.phone ? toE164(input.phone) : null
  const hash = e164 ? phoneHash(e164) : null // throws when PHONE_HASH_KEY is missing → CHECK_FAILED

  const [org, suppression, ownLine, lead, clientConsents, latestInbound] = await Promise.all([
    db.organization.findUnique({ where: { id: input.organizationId }, select: { settings: true } }),
    hash
      ? db.callCenterSuppression.findUnique({
          where: { organizationId_numberHash: { organizationId: input.organizationId, numberHash: hash } },
          select: { smsBlockedAt: true, callBlockedAt: true, removedAt: true, smsBlockedSource: true },
        })
      : null,
    e164
      ? db.phoneNumber.count({ where: { organizationId: input.organizationId, e164, status: { not: 'RELEASED' } } })
      : 0,
    input.leadId
      ? db.callCenterLead.findFirst({
          where: { id: input.leadId, organizationId: input.organizationId },
          select: {
            doNotCallAt: true,
            consentAt: true,
            consentSource: true,
            consentRevokedAt: true,
            consentFormId: true,
            consentNote: true,
          },
        })
      : null,
    input.clientId
      ? db.consent.findMany({
          where: { clientId: input.clientId, type: 'TCPA_CONTACT' },
          select: { granted: true, grantedAt: true, revokedAt: true, expiresAt: true, textVersion: true },
        })
      : [],
    input.clientId
      ? db.communication.findFirst({
          where: { clientId: input.clientId, channel: 'SMS', direction: 'INBOUND' },
          orderBy: { occurredAt: 'desc' },
          select: { body: true, occurredAt: true, message: { select: { optOutDetected: true } } },
        })
      : null,
  ])

  const settings = readTelephonySettings(org?.settings)
  const teamNumber = Boolean(hash && settings.teamNumbers.some((t) => t.hash === hash))

  const latestTcpa = [...clientConsents].sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())[0]
  const smsOptedOut = Boolean(
    (latestInbound && (latestInbound.message?.optOutDetected || isStopMessage(latestInbound.body))) || latestTcpa?.revokedAt,
  )

  let consent: ClientConsentFact | LeadConsentFact | null = null
  if (input.clientId) consent = { kind: 'client', consents: clientConsents }
  else if (lead) consent = { kind: 'lead', ...lead }

  return {
    channel: input.channel,
    purpose: input.purpose,
    phone: input.phone,
    suppression: suppression ?? null,
    smsOptedOut,
    leadDoNotCall: Boolean(lead?.doNotCallAt),
    ownNumber: ownLine > 0 || teamNumber,
    servicingBasis: input.servicingBasis ?? null,
    consent,
    zoneHints: input.zoneHints,
    callWindow: settings.callWindow,
    replyWindowOpen: Boolean(
      input.channel === 'SMS' &&
        !input.automated &&
        latestInbound &&
        !latestInbound.message?.optOutDetected &&
        now.getTime() - latestInbound.occurredAt.getTime() <= REPLY_WINDOW_MS,
    ),
  }
}

export const CHECK_FAILED_REASON = "We couldn't check the calling rules just now, so nothing was sent. Try again in a moment."

/** Masked to the last four, always — audit rows never hold a full number. */
function last4(phone: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? digits.slice(-4) : null
}

/**
 * Load, decide, and audit every block. Never throws: a failure to read or to
 * hash is a block (CHECK_FAILED), and a failure to write the audit row never
 * stops anything.
 */
export async function decideOutbound(
  input: OutboundInput,
  opts: { actor?: SessionUser | null; override?: boolean; now?: Date } = {},
): Promise<OutboundDecision> {
  const now = opts.now ?? new Date()
  let decision: OutboundDecision
  try {
    const facts = await loadOutboundFacts(input, now)
    decision = evaluateOutbound(facts, now, { override: opts.override })
  } catch {
    decision = { allowed: false, code: 'CHECK_FAILED', reason: CHECK_FAILED_REASON, canOverride: null }
  }

  if (!decision.allowed) {
    await auditOutbound(input, opts.actor ?? null, {
      action: 'telephony.outbound_blocked',
      summary: `${input.channel === 'CALL' ? 'Call' : 'Text'} to •••${last4(input.phone) ?? ''} blocked: ${decision.code}`,
      after: { channel: input.channel, purpose: input.purpose, code: decision.code, last4: last4(input.phone) },
    })
  }
  return decision
}

export async function auditOutbound(
  input: Pick<OutboundInput, 'organizationId' | 'clientId' | 'leadId'>,
  actor: SessionUser | null,
  entry: { action: string; summary: string; after: Record<string, unknown> },
): Promise<void> {
  try {
    const entityType = input.clientId ? 'Client' : input.leadId ? 'CallCenterLead' : 'Organization'
    const entityId = input.clientId ?? input.leadId ?? input.organizationId
    if (actor) {
      await recordAudit(actor, { action: entry.action, entityType, entityId, summary: entry.summary, after: entry.after })
    } else {
      await db.auditEvent.create({
        data: {
          organizationId: input.organizationId,
          actorLabel: 'Calling rules',
          action: entry.action,
          entityType,
          entityId,
          summary: entry.summary,
          after: entry.after as never,
        },
      })
    }
  } catch {
    // Logging must never stop a call or a text.
  }
}
