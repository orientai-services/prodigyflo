import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { normaliseEmail, normalisePhone } from '@/lib/dedupe'
import { isRevocationText, isStartMessage, isStopMessage, type MessagingChannel } from './consent'
import { maskEmail, maskPhone } from './send'
import { last4Of, phoneHashOrNull } from '@/lib/telephony/compliance-core'
import { blockNumber, clearSmsStop } from '@/lib/telephony/suppressions'

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
    // A STOP from a stranger still counts: it blocks texts in the LINE's
    // organization (it used to be recorded nowhere).
    if (channel === 'SMS') await applySmsKeywords(orgHint, payload)
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
  if (channel === 'SMS') await applySmsKeywords(client.organizationId, payload)

  return { matched: true, duplicate: false, clientId: client.id, communicationId: communication.id, optOut }
}

/**
 * STOP, START and revocation words for one inbound text, in one organization
 * (docs/TELEPHONY_LIVE.md §2.10):
 *
 *  - whole-message STOP (incl. Spanish) → SMS block (sms_stop) on the number,
 *    and every Call Center lead with that number loses its consent
 *  - a revocation word inside a longer message → SMS hold (sms_stop_review)
 *    until an admin confirms or lifts it, and the admins are told
 *  - START / UNSTOP → lifts only a STOP-made SMS block; consent stays gone
 *  - any other text → a genuine inquiry: a lead whose consent came from an
 *    earlier inquiry has it moved forward. STOP never counts as an inquiry.
 *
 * Never throws and never drops an opt-out silently: a save failure becomes an
 * "Opt-out not saved — add it by hand" notification.
 */
async function applySmsKeywords(organizationId: string | null, payload: InboundPayload): Promise<void> {
  const stop = isStopMessage(payload.body)
  const start = !stop && isStartMessage(payload.body)
  const review = !stop && !start && isRevocationText(payload.body)
  const now = new Date()
  const hash = phoneHashOrNull(payload.from)
  const last4 = last4Of(payload.from)

  try {
    if (!organizationId || (!hash && (stop || review))) {
      if (stop || review) throw new Error('No organization or number hash for this opt-out.')
      return
    }
    if (stop) {
      await blockNumber({ organizationId, numberHash: hash!, last4, sms: 'sms_stop', reason: 'Replied STOP' }, now)
      await db.callCenterLead.updateMany({
        where: { organizationId, phoneHash: hash!, consentRevokedAt: null },
        data: { consentRevokedAt: now },
      })
      await auditSystem(organizationId, 'telephony.suppression_added', `Texts to the number ending ${last4 ?? '····'} stopped by a STOP reply`, {
        source: 'sms_stop',
        last4,
      })
      return
    }
    if (review) {
      await blockNumber({ organizationId, numberHash: hash!, last4, sms: 'sms_stop_review', reason: 'Possible opt-out' }, now)
      const snippet = payload.body.replace(/\s+/g, ' ').trim().slice(0, 80)
      await notifyAdmins(organizationId, 'Possible opt-out', `Possible opt-out: '${snippet}'. Confirm or lift.`, '/call-center')
      await auditSystem(organizationId, 'telephony.optout_review', `Texts to the number ending ${last4 ?? '····'} held for review`, {
        source: 'sms_stop_review',
        last4,
      })
      return
    }
    if (!hash) return
    if (start) {
      if (await clearSmsStop(organizationId, hash)) {
        await auditSystem(organizationId, 'telephony.suppression_removed', `START lifted the STOP block on the number ending ${last4 ?? '····'}`, {
          source: 'sms_start',
          last4,
        })
      }
      return
    }
    await db.callCenterLead.updateMany({
      where: { organizationId, phoneHash: hash, consentSource: 'inbound_inquiry', consentRevokedAt: null },
      data: { consentAt: now },
    })
  } catch {
    if (stop || review) {
      const target = organizationId ?? (await platformOwnerOrganization())
      if (target) {
        await notifyAdmins(
          target,
          'Opt-out not saved',
          `A reply from ${maskPhone(payload.from)} looked like an opt-out but could not be saved. Opt-out not saved — add it by hand.`,
          '/call-center',
        ).catch(() => undefined)
      }
    }
  }
}

/**
 * A signed text to a number this app has no line for (released here, or never
 * imported). It can't be filed against an account, but an opt-out must never
 * vanish: a STOP or a possible opt-out tells the platform owner's admins to
 * add it by hand. Any other text is ignored, as before.
 */
export async function recordUnroutedOptOut(payload: InboundPayload): Promise<void> {
  if (!isStopMessage(payload.body) && !isRevocationText(payload.body)) return
  try {
    await applySmsKeywords(null, payload)
  } catch {
    // The carrier's own STOP handling still applies; the webhook answer must not fail.
  }
}

/**
 * Who hears about an opt-out that can't be tied to an account: the platform
 * owner (TELEPHONY_PLATFORM_ORG_ID), who runs the carrier account the text
 * came in on. Never "the first organization" — on the shared platform that
 * could be another business entirely. Unset (or gone) means no notice; the
 * carrier's own STOP handling still applies.
 */
async function platformOwnerOrganization(): Promise<string | null> {
  const { platformOrgId } = await import('@/lib/telephony/tenancy')
  const id = platformOrgId()
  if (!id) return null
  const org = await db.organization.findFirst({ where: { id, deletedAt: null }, select: { id: true } })
  return org?.id ?? null
}

async function notifyAdmins(organizationId: string, title: string, body: string, href: string): Promise<void> {
  const admins = await db.user.findMany({
    where: {
      organizationId,
      isActive: true,
      deletedAt: null,
      role: { permissions: { some: { permission: { key: 'users:manage' } } } },
    },
    select: { id: true },
  })
  if (admins.length === 0) return
  await db.notification.createMany({
    data: admins.map((a) => ({ organizationId, userId: a.id, kind: 'MESSAGE' as const, title, body, href })),
  })
}

async function auditSystem(organizationId: string, action: string, summary: string, after: Record<string, unknown>): Promise<void> {
  try {
    await db.auditEvent.create({
      data: { organizationId, actorLabel: 'Inbound webhook', action, entityType: 'CallCenterSuppression', summary, after: after as never },
    })
  } catch {
    // Logging never blocks an opt-out.
  }
}
