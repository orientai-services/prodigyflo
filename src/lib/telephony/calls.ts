import 'server-only'
import type { CallOutcome, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { normalisePhone } from '@/lib/dedupe'
import { maskPhone } from '@/lib/messaging/send'
import { formatE164 } from './provider'

/**
 * Inbound calls, from the carrier's webhook to the client timeline.
 *
 * The account is resolved from the number that was DIALLED, which is the whole
 * reason PhoneNumber.e164 is globally unique: one number, one account, no
 * guessing. That is a real improvement on the SMS path, which had to infer the
 * tenant from a user's personal phone (see organizationHint in
 * messaging/inbound.ts, now backed by this same lookup).
 *
 * A call from a number we recognise becomes a Communication + Call on that
 * client, exactly like a logged call, so it lands in the timeline, the comms
 * tab and the scoreboard with no special-casing. A call from a stranger cannot
 * become a Communication (they are client-scoped by schema), so it notifies the
 * account's admins instead — the same contract as an unmatched inbound SMS.
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
} as const

export type InboundNumber = Prisma.PhoneNumberGetPayload<{ select: typeof NUMBER_SELECT }>

/** The account line a call came in on, or null when we do not own the number. */
export async function resolveInboundNumber(toE164: string): Promise<InboundNumber | null> {
  const row = await db.phoneNumber.findUnique({ where: { e164: toE164 }, select: NUMBER_SELECT })
  if (!row) return null
  return row.status === 'ACTIVE' || row.status === 'PENDING' ? row : null
}

/** E.164 numbers to ring for a TEAM-routed line, in the configured order. */
export async function teamDialNumbers(number: InboundNumber): Promise<string[]> {
  const ids = Array.isArray(number.teamUserIds) ? (number.teamUserIds as unknown[]).filter((v): v is string => typeof v === 'string') : []
  if (ids.length === 0) return []
  const users = await db.user.findMany({
    where: { id: { in: ids }, organizationId: number.organizationId, isActive: true, deletedAt: null },
    select: { id: true, phone: true },
  })
  const byId = new Map(users.map((u) => [u.id, u.phone]))
  return ids
    .map((id) => byId.get(id))
    .filter((p): p is string => Boolean(p && normalisePhone(p).length === 10))
    .map((p) => `+1${normalisePhone(p)}`)
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
}

export type RecordInboundCallResult =
  | { matched: true; duplicate: boolean; clientId: string; communicationId: string }
  | { matched: false; notified: number }

/**
 * Writes (once) the CRM record for a ringing call. Idempotent on the carrier's
 * CallSid, because Twilio retries webhooks and a duplicated call in a client's
 * timeline is worse than a missing one.
 */
export async function recordInboundCall(input: RecordInboundCallInput): Promise<RecordInboundCallResult> {
  const existing = await db.communication.findFirst({
    where: { channel: 'CALL', direction: 'INBOUND', externalRef: input.callSid },
    select: { id: true, clientId: true },
  })
  if (existing) {
    return { matched: true, duplicate: true, clientId: existing.clientId, communicationId: existing.id }
  }

  const client = await matchCallerToClient(input.number.organizationId, input.fromE164)
  if (!client) {
    const notified = await notifyUnknownCaller(input)
    return { matched: false, notified }
  }

  const now = new Date()
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

  return { matched: true, duplicate: false, clientId: client.id, communicationId: communication.id }
}

/** Same shape as messaging/inbound.ts notifyUnmatched — nothing is ever lost. */
async function notifyUnknownCaller(input: RecordInboundCallInput): Promise<number> {
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
      body: `${maskPhone(input.fromE164)} called ${input.number.friendlyName} (${formatE164(input.number.e164)}) and matched no client on this account.`,
      href: '/clients/new',
    })),
  })
  return admins.length
}

/** Twilio DialCallStatus / CallStatus -> the CRM's own outcome vocabulary. */
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

export type CallOutcomeUpdate = {
  callSid: string
  status?: string | null
  durationSeconds?: number | null
  recordingRef?: string | null
  recordingDurationSeconds?: number | null
  voicemailLeft?: boolean
}

/**
 * Folds a status or recording callback into the Call row. Silently does
 * nothing when the call was never recorded (an unmatched caller), which is the
 * right behaviour — the callback is informational, not a command.
 */
export async function updateCallOutcome(update: CallOutcomeUpdate): Promise<boolean> {
  const communication = await db.communication.findFirst({
    where: { channel: 'CALL', direction: 'INBOUND', externalRef: update.callSid },
    select: { id: true, call: { select: { id: true, durationSeconds: true } } },
  })
  if (!communication?.call) return false

  const data: Prisma.CallUpdateInput = {}
  if (update.status) data.outcome = outcomeFromCarrierStatus(update.status)
  if (typeof update.durationSeconds === 'number' && update.durationSeconds >= 0) {
    data.durationSeconds = update.durationSeconds
  }
  if (update.recordingRef) data.recordingRef = update.recordingRef
  if (typeof update.recordingDurationSeconds === 'number') {
    data.recordingDurationSeconds = update.recordingDurationSeconds
  }
  if (update.voicemailLeft !== undefined) data.voicemailLeft = update.voicemailLeft
  if (update.voicemailLeft) data.outcome = 'VOICEMAIL'

  if (Object.keys(data).length === 0) return false
  await db.call.update({ where: { id: communication.call.id }, data })
  await db.communication.update({
    where: { id: communication.id },
    data: { status: 'RECEIVED' },
  })
  return true
}
