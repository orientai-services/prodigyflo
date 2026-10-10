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

// Standard TCPA opt-out keywords, plus the Spanish ones our leads actually
// send. Matched against the whole (trimmed) message, so these are automatic.
// A keyword INSIDE a longer message is handled by isRevocationText below: it
// holds texts for an admin to confirm rather than being ignored.
const STOP_WORDS = new Set([
  'stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke',
  'optout', 'opt out', 'opt-out',
  'parar', 'alto', 'baja', 'cancelar',
])

// START / UNSTOP re-enable texting at the carrier. They clear only a block that
// a STOP created; they never restore consent (staff must record it again).
const START_WORDS = new Set(['start', 'unstop'])

// The FCC's 2024 revocation order treats a reply that reasonably conveys
// "stop" as revocation even inside a sentence. Inside a sentence only clear
// PHRASES count, matched as whole words: our clients are cancelling solar
// contracts, so "cancel", "cancelar", "end", "alto" (high), "baja" (lower) and
// "quit" turn up in ordinary replies and are not, on their own, a request to
// stop texting. Accents are ignored ("envíen" = "envien").
const REVOCATION_PHRASES = [
  'stop texting', 'stop text', 'stop the texts', 'stop messaging', 'stop the messages', 'stop sending',
  'stop contacting', 'stop calling', 'please stop', 'stop please',
  'no more texts', 'no more text', 'no more messages',
  "don't text", 'dont text', 'do not text', "don't message", 'dont message', 'do not message',
  "don't contact", 'dont contact', 'do not contact',
  'unsubscribe', 'opt out', 'opt-out', 'optout', 'revoke consent', 'revoke my consent',
  'remove me from your list', 'remove me from this list', 'remove my number', 'take me off your list', 'take me off this list',
  'dejen de escribir', 'dejen de escribirme', 'deja de escribir', 'deja de escribirme',
  'dejen de mandar', 'deja de mandar', 'dejen de enviar', 'deja de enviar', 'dejen de llamar', 'dejen de llamarme', 'deja de llamarme',
  'no me escriban', 'no me escribas', 'no me manden mensajes', 'no me mandes mensajes', 'no me envien mensajes',
  'no mas mensajes', 'no quiero mas mensajes', 'no quiero recibir mensajes',
  'borren mi numero', 'quitenme de la lista', 'saquenme de la lista',
]

/** A message that OPENS with a stop word and punctuation: "STOP! wrong number", "Stop, not interested". */
const LEADING_STOP = /^\s*(stop|unsubscribe|parar)\s*[.!,;:¡-]/i

function normalizeKeyword(body: string): string {
  return body.trim().toLowerCase().replace(/[.!¡]+/g, '').replace(/\s+/g, ' ').trim()
}

function normalizeSentence(body: string): string {
  const plain = body.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').replace(/[’‘`]/g, "'")
  return ` ${plain.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim()} `
}

export function isStopMessage(body: string | null | undefined): boolean {
  if (!body) return false
  return STOP_WORDS.has(normalizeKeyword(body))
}

export function isStartMessage(body: string | null | undefined): boolean {
  if (!body) return false
  return START_WORDS.has(normalizeKeyword(body))
}

/**
 * A clear revocation inside a longer message ("please stop texting me").
 * Whole-message keywords are NOT this — they are automatic (isStopMessage).
 * A match holds texts for an admin to confirm or lift. Kept to clear phrases:
 * a hold on an ordinary reply ("I want to cancel my solar contract") would
 * silence the very client asking for help.
 */
export function isRevocationText(body: string | null | undefined): boolean {
  if (!body || isStopMessage(body)) return false
  if (LEADING_STOP.test(body)) return true
  const text = normalizeSentence(body)
  return REVOCATION_PHRASES.some((p) => text.includes(` ${p} `))
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
