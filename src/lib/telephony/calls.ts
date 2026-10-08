import 'server-only'
import type { CallOutcome, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { normalisePhone } from '@/lib/dedupe'
import { maskPhone } from '@/lib/messaging/send'
import { formatE164, toE164 } from './provider'
import { last4Of, phoneHashOrNull } from './compliance-core'
import { linkVoiceCall, startInboundCall } from './voice-calls'

/**
 * Inbound calls, from the carrier's webhook to the client timeline.
 *
 * The account is resolved from the number that was DIALLED, which is the whole
 * reason PhoneNumber.e164 is globally unique: one number, one account, no
 * guessing. That is a real improvement on the SMS path, which had to infer the
 * tenant from a user's personal phone (see organizationHint in
 * messaging/inbound.ts, now backed by this same lookup).
 *
 * Every inbound call gets a VoiceCall row (the ledger: status, who answered,
 * the voicemail's RecordingSid). A call from a number we recognise also becomes
 * a Communication + Call on that client, exactly like a logged call, so it
 * lands in the timeline, the comms tab and the scoreboard. A call from a
 * stranger cannot become a Communication (they are client-scoped by schema), so
 * it becomes an INBOUND Call Center lead instead — its voicemail kept on the
 * VoiceCall (audit 5c: it used to be lost) — and the admins are told.
 */

const NUMBER_SELECT = {
  id: true,
  organizationId: true,
  e164: true,
  friendlyName: true,
  status: true,
  routing: true,
  forwardTo: true,
  teamUserIds: true,
  voicemailGreeting: true,
  recordCalls: true,
  assignedUserId: true,
  ringBrowsers: true,
  providerAccountSid: true,
} as const

export type InboundNumber = Prisma.PhoneNumberGetPayload<{ select: typeof NUMBER_SELECT }>

/** The account line a call came in on, or null when we do not own the number. */
export async function resolveInboundNumber(toE164: string): Promise<InboundNumber | null> {
  const row = await db.phoneNumber.findUnique({ where: { e164: toE164 }, select: NUMBER_SELECT })
  if (!row) return null
  return row.status === 'ACTIVE' || row.status === 'PENDING' ? row : null
}

export type TeamTarget = { userId: string; e164: string }

/**
 * Who to ring for a TEAM-routed line, in the configured order. Any valid
 * number goes through toE164 — not only 10-digit US numbers (audit 5e).
 */
export async function teamDialTargets(number: Pick<InboundNumber, 'teamUserIds' | 'organizationId'>): Promise<TeamTarget[]> {
  const ids = Array.isArray(number.teamUserIds) ? (number.teamUserIds as unknown[]).filter((v): v is string => typeof v === 'string') : []
  if (ids.length === 0) return []
  const users = await db.user.findMany({
    where: { id: { in: ids }, organizationId: number.organizationId, isActive: true, deletedAt: null },
    select: { id: true, phone: true },
  })
  const byId = new Map(users.map((u) => [u.id, u.phone]))
  const out: TeamTarget[] = []
  for (const id of ids) {
    const e164 = toE164(byId.get(id) ?? '')
    if (e164) out.push({ userId: id, e164 })
  }
  return out
}

/** The same line, found from a call's own record (callbacks that don't name it). */
export async function resolveInboundNumberById(id: string): Promise<InboundNumber | null> {
  const row = await db.phoneNumber.findUnique({ where: { id }, select: NUMBER_SELECT })
  if (!row) return null
  return row.status === 'ACTIVE' || row.status === 'PENDING' ? row : null
}

/** E.164 numbers to ring for a TEAM-routed line, in the configured order. */
export async function teamDialNumbers(number: Pick<InboundNumber, 'teamUserIds' | 'organizationId'>): Promise<string[]> {
  return (await teamDialTargets(number)).map((t) => t.e164)
}

/** Match a caller to a client inside the account that owns the dialled line. */
export async function matchCallerToClient(organizationId: string, fromE164: string) {
  const phone = normalisePhone(fromE164)
  if (phone.length < 10) return null
  const candidates = await db.client.findMany({
    where: { organizationId, deletedAt: null, phone: { contains: phone.slice(-4) } },
    orderBy: { lastActivityAt: 'desc' },
    take: 20,
    select: { id: true, firstName: true, lastName: true, phone: true, ownerId: true },
  })
  return candidates.find((c) => normalisePhone(c.phone) === phone) ?? null
}

export type RecordInboundCallInput = {
  number: InboundNumber
  fromE164: string
  /** Twilio CallSid — the idempotency key for every later status callback. */
  callSid: string
  /** Twilio account the line is on. */
  accountSid?: string
  /** Where the call is right now: 'greeting' | 'browser' | 'forward' | 'team' | 'voicemail'. */
  stage?: string
  /** Twilio's StirVerstat (caller-ID attestation), stored on the VoiceCall. */
  stirVerstat?: string | null
  now?: Date
}

export type RecordInboundCallResult =
  | { matched: true; duplicate: boolean; clientId: string; communicationId: string; voiceCallId: string }
  | { matched: false; duplicate: boolean; notified: number; voiceCallId: string; leadId: string | null }

/**
 * Writes (once) the CRM record for a ringing call. Idempotent on the carrier's
 * CallSid, because Twilio retries webhooks and a duplicated call in a client's
 * timeline is worse than a missing one.
 */
export async function recordInboundCall(input: RecordInboundCallInput): Promise<RecordInboundCallResult> {
  const now = input.now ?? new Date()
  const { row: vc } = await startInboundCall({
    organizationId: input.number.organizationId,
    accountSid: input.accountSid ?? 'mock',
    callSid: input.callSid,
    phoneNumberId: input.number.id,
    lineE164: input.number.e164,
    from: input.fromE164,
    stage: input.stage ?? 'greeting',
    recordingExpected: input.number.recordCalls,
    stirVerstat: input.stirVerstat ?? null,
  })

  const existing = await db.communication.findFirst({
    where: { channel: 'CALL', direction: 'INBOUND', externalRef: input.callSid },
    select: { id: true, clientId: true },
  })
  if (existing) {
    return { matched: true, duplicate: true, clientId: existing.clientId, communicationId: existing.id, voiceCallId: vc.id }
  }
  if (vc.callCenterLeadId) {
    return { matched: false, duplicate: true, notified: 0, voiceCallId: vc.id, leadId: vc.callCenterLeadId }
  }

  const client = await matchCallerToClient(input.number.organizationId, input.fromE164)
  if (!client) {
    const leadId = await upsertInboundLead(input, vc.id, now)
    if (leadId) await linkVoiceCall(input.callSid, { callCenterLeadId: leadId })
    const notified = await notifyUnknownCaller(input, vc.id)
    return { matched: false, duplicate: false, notified, voiceCallId: vc.id, leadId }
  }

  const communication = await db.communication.create({
    data: {
      clientId: client.id,
      // Attribute the call to whoever owns the client, when there is one — the
      // timeline reads better than an unattributed system row.
      userId: client.ownerId ?? null,
      channel: 'CALL',
      direction: 'INBOUND',
      status: 'RECEIVED',
      body: `Inbound call to ${input.number.friendlyName} (${formatE164(input.number.e164)}).`,
      externalRef: input.callSid,
      occurredAt: now,
      call: {
        create: {
          fromMasked: maskPhone(input.fromE164),
          toMasked: maskPhone(input.number.e164),
          outcome: 'NO_ANSWER',
        },
      },
    },
    select: { id: true },
  })
  await db.client.update({ where: { id: client.id }, data: { lastActivityAt: now } })
  await linkVoiceCall(input.callSid, { clientId: client.id, communicationId: communication.id })

  await db.auditEvent.create({
    data: {
      organizationId: input.number.organizationId,
      actorLabel: 'Inbound call',
      action: 'communication.inbound_call',
      entityType: 'Communication',
      entityId: communication.id,
      summary: `Inbound call from ${maskPhone(input.fromE164)} to ${formatE164(input.number.e164)}`,
      after: { callSid: input.callSid, line: input.number.e164 },
    },
  })

  return { matched: true, duplicate: false, clientId: client.id, communicationId: communication.id, voiceCallId: vc.id }
}

/**
 * An unknown caller becomes (or reuses) an INBOUND Call Center lead in the
 * line's organization, deduped on (organizationId, phoneHash) — so a Facebook
 * lead for the same number is reused once its hash is backfilled.
 *
 * Consent: none here. A ringing call proves nothing — caller ID is easy to
 * spoof and the caller may hang up during the greeting. 'inbound_inquiry'
 * (90 days) is granted when the call is over, and only for a caller ID the
 * carrier vouched for who reached someone or left a voicemail
 * (finalizeCall → inboundInquiryCounts). Until then a rep records consent by
 * hand.
 */
async function upsertInboundLead(input: RecordInboundCallInput, voiceCallId: string, now: Date): Promise<string | null> {
  const e164 = toE164(input.fromE164)
  if (!e164) return null
  const hash = phoneHashOrNull(e164)
  const orgId = input.number.organizationId
  const eventBody = JSON.stringify({
    label: 'Inbound call',
    detail: `Called ${input.number.friendlyName}`,
    voiceCallId,
  })

  try {
    const existing = hash
      ? await db.callCenterLead.findFirst({
          where: { organizationId: orgId, phoneHash: hash },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
      : null
    if (existing) {
      await db.callCenterEvent.create({ data: { leadId: existing.id, type: 'INBOUND', body: eventBody, createdAt: now } })
      return existing.id
    }

    let phoneSecret: Prisma.InputJsonValue | undefined
    try {
      phoneSecret = process.env.VAULT_KEY ? (encryptSecret(e164) as unknown as Prisma.InputJsonValue) : undefined
    } catch {
      phoneSecret = undefined
    }
    const lead = await db.callCenterLead.create({
      data: {
        organizationId: orgId,
        source: 'INBOUND',
        language: 'EN',
        status: 'INBOUND',
        phoneLast4: last4Of(e164),
        phoneSecret,
        phoneHash: hash,
        events: { create: { type: 'INBOUND', body: eventBody, createdAt: now } },
      },
      select: { id: true },
    })
    return lead.id
  } catch (err) {
    console.error('[telephony] could not save the unknown caller as a lead', err instanceof Error ? err.message : err)
    return null
  }
}

/** Same shape as messaging/inbound.ts notifyUnmatched — nothing is ever lost. */
async function notifyUnknownCaller(input: RecordInboundCallInput, voiceCallId: string): Promise<number> {
  const admins = await db.user.findMany({
    where: {
      organizationId: input.number.organizationId,
      isActive: true,
      deletedAt: null,
      role: { permissions: { some: { permission: { key: 'users:manage' } } } },
    },
    select: { id: true },
  })
  if (admins.length === 0) return 0

  await db.notification.createMany({
    data: admins.map((a) => ({
      organizationId: input.number.organizationId,
      userId: a.id,
      kind: 'MESSAGE' as const,
      title: 'Call from an unknown number',
      body: `${maskPhone(input.fromE164)} called ${input.number.friendlyName} (${formatE164(input.number.e164)}). It is on the Call Center desk.`,
      href: `/call-center?missed=${voiceCallId}`,
    })),
  })
  return admins.length
}

/** Twilio DialCallStatus -> the CRM's own outcome vocabulary. Only for a DIAL result. */
export function outcomeFromCarrierStatus(status: string | null | undefined): CallOutcome {
  switch ((status ?? '').toLowerCase()) {
    case 'completed':
    case 'answered':
      return 'CONNECTED'
    case 'busy':
      return 'BUSY'
    case 'no-answer':
    case 'noanswer':
      return 'NO_ANSWER'
    case 'canceled':
    case 'cancelled':
      return 'DECLINED'
    case 'failed':
      return 'FAILED'
    default:
      return 'NO_ANSWER'
  }
}
