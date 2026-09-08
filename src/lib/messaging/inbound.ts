import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { normaliseEmail, normalisePhone } from '@/lib/dedupe'
import { isStopMessage, type MessagingChannel } from './consent'
import { maskEmail, maskPhone } from './send'

/**
 * Inbound message ingestion. A provider webhook (or the mock curl during
 * development) posts {from, to?, subject?, body, external_id} to
 * /api/inbound/email or /api/inbound/sms, signed with HMAC-SHA256 over the raw
 * body using JOBS_TOKEN as the key. This module owns everything after the
 * route parses the payload: idempotency, client matching, the Communication
 * row, TCPA STOP handling, and the unmatched-message notification.
 */

export const INBOUND_SIGNATURE_HEADER = 'x-inbound-signature'

/** Compute the signature header value for a raw request body. */
export function signInboundBody(token: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', token).update(rawBody, 'utf8').digest('hex')}`
}

/** Timing-safe verification. Refuses everything when JOBS_TOKEN is unset. */
export function verifyInboundSignature(
  rawBody: string,
  header: string | null | undefined,
  token: string | undefined = process.env.JOBS_TOKEN,
): boolean {
  if (!token || !header) return false
  const expected = Buffer.from(signInboundBody(token, rawBody), 'utf8')
  const received = Buffer.from(header.trim(), 'utf8')
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}

export type InboundPayload = {
  from: string
  to?: string | null
  subject?: string | null
  body: string
  external_id: string
}

export type InboundResult =
  | { matched: true; duplicate: boolean; clientId: string; communicationId: string; optOut: boolean }
  | { matched: false; duplicate: boolean; notified: number }

/**
 * Try to pin the tenant from the `to` address: replies land on the address or
 * number the message went out from, which belongs to one of our users.
 *
 * For SMS the strongest signal is an account-owned phone number: PhoneNumber.e164
 * is globally unique, so a text to one of our lines identifies its account with
 * no ambiguity. A user's personal mobile is the fallback for installs (and
 * historical rows) that predate owned numbers.
 */
async function organizationHint(channel: MessagingChannel, to: string | null | undefined): Promise<string | null> {
  if (!to) return null
  if (channel === 'EMAIL') {
    const email = normaliseEmail(to)
    if (!email) return null
    const user = await db.user.findFirst({
      where: {
        deletedAt: null,
        OR: [{ email: { equals: email, mode: 'insensitive' } }, { emailAlias: { equals: email, mode: 'insensitive' } }],
      },
      select: { organizationId: true },
    })
    return user?.organizationId ?? null
  }
  const phone = normalisePhone(to)
  if (phone.length < 4) return null

  if (phone.length === 10) {
    const line = await db.phoneNumber.findFirst({
      where: { e164: { endsWith: phone }, status: { in: ['ACTIVE', 'PENDING'] } },
      select: { organizationId: true },
    })
    if (line) return line.organizationId
  }

  const user = await db.user.findFirst({
    where: { deletedAt: null, phone: { contains: phone.slice(-4) } },
    select: { organizationId: true, phone: true },
  })
  return user && normalisePhone(user.phone) === phone ? user.organizationId : null
}

/** Match the sender to a client by normalised email (EMAIL) or phone (SMS). */
async function matchClient(channel: MessagingChannel, from: string, organizationId: string | null) {
  const scope = organizationId ? { organizationId } : {}

  if (channel === 'EMAIL') {
    const email = normaliseEmail(from)
    if (!email) return null
    return db.client.findFirst({
      where: { ...scope, deletedAt: null, email: { equals: email, mode: 'insensitive' } },
      orderBy: { lastActivityAt: 'desc' },
      select: { id: true, organizationId: true, firstName: true, lastName: true },
    })
  }

  const phone = normalisePhone(from)
  if (phone.length < 4) return null
  // SQL prefilters on the last four digits; exact comparison happens in JS
  // because stored numbers may carry formatting.
  const candidates = await db.client.findMany({
    where: { ...scope, deletedAt: null, phone: { contains: phone.slice(-4) } },
    orderBy: { lastActivityAt: 'desc' },
    take: 20,
    select: { id: true, organizationId: true, firstName: true, lastName: true, phone: true },
  })
  return candidates.find((c) => normalisePhone(c.phone) === phone) ?? null
}

/** Notify users:manage holders so an unmatched message is never silently lost. */
async function notifyUnmatched(
  channel: MessagingChannel,
  payload: InboundPayload,
  organizationId: string | null,
): Promise<number> {
  let orgId = organizationId
  if (!orgId) {
    // The tenant is unknowable without a `to` match — route to the AGENCY
    // (master) account, whose admins triage cross-account traffic. Installs
    // without an agency org fall back to the oldest organization so the
    // message still reaches a human.
    const org =
      (await db.organization.findFirst({
        where: { kind: 'AGENCY', deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })) ??
      (await db.organization.findFirst({
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }))
    orgId = org?.id ?? null
  }
  if (!orgId) return 0

  const admins = await db.user.findMany({
    where: {
      organizationId: orgId,
      isActive: true,
      deletedAt: null,
      role: { permissions: { some: { permission: { key: 'users:manage' } } } },
    },
    select: { id: true },
  })
  if (admins.length === 0) return 0

  const fromMasked = channel === 'EMAIL' ? maskEmail(payload.from) : maskPhone(payload.from)
  const snippet = payload.body.replace(/\s+/g, ' ').trim().slice(0, 140)
  await db.notification.createMany({
    data: admins.map((a) => ({
      organizationId: orgId,
      userId: a.id,
      kind: 'MESSAGE' as const,
      title: `Unmatched inbound ${channel === 'EMAIL' ? 'email' : 'SMS'}`,
      body: `From ${fromMasked}: “${snippet}${payload.body.length > 140 ? '…' : ''}” — no client with this ${channel === 'EMAIL' ? 'email address' : 'phone number'} was found.`,
      href: '/inbox',
    })),
  })
  return admins.length
}

/**
 * Process one verified inbound message. Idempotent on external_id: replaying
 * the same webhook returns the original result without writing anything.
 */
export async function processInboundMessage(
  channel: MessagingChannel,
  payload: InboundPayload,
): Promise<InboundResult> {
  const existing = await db.communication.findFirst({
    where: { direction: 'INBOUND', channel, externalRef: payload.external_id },
    select: { id: true, clientId: true, message: { select: { optOutDetected: true } } },
  })
  if (existing) {
    return {
      matched: true,
      duplicate: true,
      clientId: existing.clientId,
      communicationId: existing.id,
      optOut: existing.message?.optOutDetected ?? false,
    }
  }

  const orgHint = await organizationHint(channel, payload.to)
  const client = await matchClient(channel, payload.from, orgHint)

  if (!client) {
    const notified = await notifyUnmatched(channel, payload, orgHint)
    return { matched: false, duplicate: false, notified }
  }

  const optOut = channel === 'SMS' && isStopMessage(payload.body)
  const fromMasked = channel === 'EMAIL' ? maskEmail(payload.from) : maskPhone(payload.from)
  const now = new Date()

  const communication = await db.communication.create({
    data: {
      clientId: client.id,
      channel,
      direction: 'INBOUND',
      status: 'RECEIVED',
      subject: channel === 'EMAIL' ? (payload.subject?.trim() || null) : null,
      body: payload.body,
      externalRef: payload.external_id,
      occurredAt: now,
      message: { create: { fromMasked, optOutDetected: optOut } },
    },
  })
  await db.client.update({ where: { id: client.id }, data: { lastActivityAt: now } })

  await db.auditEvent.create({
    data: {
      organizationId: client.organizationId,
      actorLabel: 'Inbound webhook',
      action: 'communication.inbound',
      entityType: 'Communication',
      entityId: communication.id,
      summary: `Inbound ${channel === 'EMAIL' ? 'email' : 'SMS'} received from ${fromMasked}`,
      after: { channel, fromMasked, optOut, externalRef: payload.external_id },
    },
  })

  if (optOut) {
    // A STOP-type SMS revokes the TCPA consent itself, not just the send gate,
    // so every future decision sees the revocation regardless of message order.
    const revoked = await db.consent.updateMany({
      where: { clientId: client.id, type: 'TCPA_CONTACT', granted: true, revokedAt: null },
      data: { revokedAt: now },
    })
    await db.auditEvent.create({
      data: {
        organizationId: client.organizationId,
        actorLabel: 'Inbound webhook',
        action: 'consent.revoked',
        entityType: 'Client',
        entityId: client.id,
        summary: `TCPA contact consent revoked by inbound STOP message (${revoked.count} consent record${revoked.count === 1 ? '' : 's'} updated)`,
        after: { trigger: 'inbound_sms_stop', communicationId: communication.id },
      },
    })
  }

  return { matched: true, duplicate: false, clientId: client.id, communicationId: communication.id, optOut }
}
