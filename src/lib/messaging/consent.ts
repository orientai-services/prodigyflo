import type { ConsentType } from '@prisma/client'
import { db } from '@/lib/db'

/**
 * Consent gate. A message leaves the system only when the client holds a live
 * consent for that channel AND has not opted out since. The decision is
 * computed here (pure) and enforced in the send service and the API — the
 * composer's disabled state is a courtesy, not the control.
 */

export type MessagingChannel = 'EMAIL' | 'SMS'

export const REQUIRED_CONSENT: Record<MessagingChannel, ConsentType> = {
  EMAIL: 'ELECTRONIC_COMMUNICATION',
  SMS: 'TCPA_CONTACT',
}

export type ConsentDecision =
  | { allowed: true }
  | {
      allowed: false
      code: 'NO_CONSENT' | 'CONSENT_DECLINED' | 'CONSENT_REVOKED' | 'CONSENT_EXPIRED' | 'OPTED_OUT'
      reason: string
    }

export type ConsentRow = {
  type: ConsentType
  granted: boolean
  grantedAt: Date
  revokedAt: Date | null
  expiresAt: Date | null
}

export type InboundSignal = {
  body: string | null
  optOutDetected: boolean
} | null

// Standard TCPA opt-out keywords. Matched against the whole (trimmed) message
// so "please stop calling my office" does not count as an opt-out.
const STOP_WORDS = new Set(['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke'])

export function isStopMessage(body: string | null | undefined): boolean {
  if (!body) return false
  const normalized = body.trim().toLowerCase().replace(/[.!]+$/, '').trim()
  return STOP_WORDS.has(normalized)
}

const CHANNEL_LABEL: Record<MessagingChannel, string> = { EMAIL: 'email', SMS: 'SMS' }
const CONSENT_LABEL: Record<MessagingChannel, string> = {
  EMAIL: 'electronic communication consent',
  SMS: 'TCPA contact consent',
}

/** Pure decision over already-loaded rows — this is what the tests exercise. */
export function evaluateConsent(
  input: { consents: ConsentRow[]; latestInbound?: InboundSignal; now?: Date },
  channel: MessagingChannel,
): ConsentDecision {
  const now = input.now ?? new Date()
  const requiredType = REQUIRED_CONSENT[channel]

  const relevant = input.consents
    .filter((c) => c.type === requiredType)
    .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())
  const latest = relevant[0]

  if (!latest) {
    return {
      allowed: false,
      code: 'NO_CONSENT',
      reason: `No ${CONSENT_LABEL[channel]} on file — ${CHANNEL_LABEL[channel]} cannot be sent.`,
    }
  }
  if (latest.revokedAt) {
    return {
      allowed: false,
      code: 'CONSENT_REVOKED',
      reason: `The client revoked ${CONSENT_LABEL[channel]} on ${latest.revokedAt.toLocaleDateString('en-US')}.`,
    }
  }
  if (!latest.granted) {
    return {
      allowed: false,
      code: 'CONSENT_DECLINED',
      reason: `The client declined ${CONSENT_LABEL[channel]}.`,
    }
  }
  if (latest.expiresAt && latest.expiresAt.getTime() < now.getTime()) {
    return {
      allowed: false,
      code: 'CONSENT_EXPIRED',
      reason: `The ${CONSENT_LABEL[channel]} expired on ${latest.expiresAt.toLocaleDateString('en-US')}.`,
    }
  }

  const inbound = input.latestInbound
  if (inbound && (inbound.optOutDetected || isStopMessage(inbound.body))) {
    return {
      allowed: false,
      code: 'OPTED_OUT',
      reason: `The client's most recent inbound ${CHANNEL_LABEL[channel]} was an opt-out — do not contact on this channel.`,
    }
  }

  return { allowed: true }
}

/** Loads the rows and evaluates. The client must already be scope-checked. */
export async function getConsentDecision(clientId: string, channel: MessagingChannel): Promise<ConsentDecision> {
  const [consents, latestInboundComm] = await Promise.all([
    db.consent.findMany({
      where: { clientId, type: REQUIRED_CONSENT[channel] },
      select: { type: true, granted: true, grantedAt: true, revokedAt: true, expiresAt: true },
    }),
    db.communication.findFirst({
      where: { clientId, channel, direction: 'INBOUND' },
      orderBy: { occurredAt: 'desc' },
      select: { body: true, message: { select: { optOutDetected: true } } },
    }),
  ])

  return evaluateConsent(
    {
      consents,
      latestInbound: latestInboundComm
        ? { body: latestInboundComm.body, optOutDetected: latestInboundComm.message?.optOutDetected ?? false }
        : null,
    },
    channel,
  )
}
