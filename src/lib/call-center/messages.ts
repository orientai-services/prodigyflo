import 'server-only'
import { db } from '@/lib/db'
import { can, clientScope, ForbiddenError, type SessionUser } from '@/lib/rbac'
import { getSmsProvider } from '@/lib/messaging'
import { sendMessage } from '@/lib/messaging/send'
import { decideOutbound } from '@/lib/telephony/compliance'
import { last4Of, maskedLast4, phoneHashOrNull } from '@/lib/telephony/compliance-core'
import { leadPhonesFor } from './lead-phones'
import { leadPhoneView, type LeadPhoneView } from './phone-display'
import { failureCodeText } from '@/lib/telephony/carrier-errors'
import { toE164 } from '@/lib/telephony/provider'
import { isUniqueViolation } from '@/lib/telephony/voice-calls'
import { readSecret } from './contact'
import { readFacebookFormEvent } from './meta-route'
import {
  clockLabel,
  communicationSmsStatus,
  displayName,
  failureReason,
  listTimeLabel,
  readSmsEvent,
  smsEventBody,
  snippet,
  threadKeyString,
  type SmsStatus,
  type ThreadKey,
  type ThreadKind,
} from './messages-core'

/**
 * The dialer's Messages section (docs/DIALER_APP.md §4).
 *
 * Lead texts are CallCenterEvent rows of type SMS with `direction` set ('in'
 * from processInboundMessage, 'out' from sendThreadText). Client texts stay in
 * Communication and are read here under clientScope. Older desk "Text" trail
 * lines (no direction) are not messages and never show.
 *
 * Nothing here returns a full phone number: the list and the thread carry the
 * last four only. Every send goes through the one outbound decision
 * (do-not-contact, STOP, consent, quiet hours) on the server.
 */

const THREAD_LIMIT = 200
const MESSAGE_LIMIT = 300
/** Client texts predate read tracking; only recent ones count as unread. */
const CLIENT_UNREAD_DAYS = 30

export type ThreadSummaryVM = {
  key: string
  kind: ThreadKind
  name: string
  last4: string | null
  /** Full number of a lead thread, only for a viewer allowed to see it (lead-phones.ts). */
  phone?: LeadPhoneView | null
  snippet: string
  lastDirection: 'in' | 'out'
  at: string
  timeLabel: string
  unread: number
}

export type MessageVM = {
  id: string
  direction: 'in' | 'out'
  text: string
  at: string
  time: string
  status: SmsStatus
  /** Shown under a failed bubble, in plain words. */
  note: string | null
  /** Sender's first name for outbound texts, when known. */
  by: string | null
}

export type ThreadVM = {
  key: string
  kind: ThreadKind
  name: string
  last4: string | null
  /** Full number of a lead thread, only for a viewer allowed to see it (lead-phones.ts). */
  phone?: LeadPhoneView | null
  messages: MessageVM[]
  canSend: boolean
  /** Why the composer is off, when it is. */
  sendNote: string | null
  /** Where the lead or client opens in the app. */
  openHref: string
}

/** A lead thread's name; a nameless lead reads as its full number when the viewer may see it. */
function leadThreadName(name: string | null | undefined, last4: string | null, phone: LeadPhoneView | null): string {
  if (!name?.trim() && phone?.state === 'shown') return phone.display
  return displayName(name, last4)
}

export type SendTextResult = { ok: true; message: MessageVM } | { ok: false; error: string }

const SMS_IN = 'in'
const SMS_OUT = 'out'

function firstName(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0]
  return first || null
}

async function userFirstNames(ids: Iterable<string>): Promise<Map<string, string>> {
  const list = [...new Set(ids)].filter(Boolean)
  if (list.length === 0) return new Map()
  const rows = await db.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })
  return new Map(rows.flatMap((r) => (firstName(r.name) ? [[r.id, firstName(r.name)!] as const] : [])))
}

function leadNameFrom(events: { body: string }[]): string | null {
  for (const e of events) {
    const read = readFacebookFormEvent(e.body)
    if (read.name) return read.name
  }
  return null
}

function leadMessage(row: { id: string; body: string; direction: string | null; createdAt: Date }, names: Map<string, string>): MessageVM {
  const copy = readSmsEvent(row.body)
  const direction = row.direction === SMS_IN ? 'in' : 'out'
  const status: SmsStatus = copy?.status ?? (direction === 'in' ? 'received' : 'sent')
  return {
    id: row.id,
    direction,
    text: copy?.detail ?? '',
    at: row.createdAt.toISOString(),
    time: clockLabel(row.createdAt),
    status,
    note: status === 'failed' ? failureReason(copy?.error) : null,
    by: direction === 'out' && copy?.userId ? names.get(copy.userId) ?? null : null,
  }
}

function clientMessage(row: {
  id: string
  body: string | null
  direction: string
  status: string
  occurredAt: Date
  user: { name: string } | null
  message: { failureCode: string | null } | null
}): MessageVM {
  const direction = row.direction === 'INBOUND' ? 'in' : 'out'
  const status = communicationSmsStatus(row.status)
  return {
    id: row.id,
    direction,
    text: row.body ?? '',
    at: row.occurredAt.toISOString(),
    time: clockLabel(row.occurredAt),
    status,
    note: status === 'failed' ? failureReason(row.message?.failureCode) : null,
    by: direction === 'out' ? firstName(row.user?.name) : null,
  }
}

const leadSmsWhere = (organizationId: string) => ({
  type: 'SMS' as const,
  direction: { not: null },
  lead: { organizationId },
})

function clientsVisible(user: SessionUser): boolean {
  return can(user, 'communications:read')
}

// ── List ─────────────────────────────────────────────────────────────────────

export async function listThreads(user: SessionUser, now = new Date()): Promise<ThreadSummaryVM[]> {
  const showClients = clientsVisible(user)
  const [leadRows, leadUnread, clientRows, clientUnread] = await Promise.all([
    db.callCenterEvent.findMany({
      where: leadSmsWhere(user.organizationId),
      orderBy: { createdAt: 'desc' },
      take: THREAD_LIMIT * 5,
      select: { leadId: true, body: true, direction: true, createdAt: true },
    }),
    db.callCenterEvent.groupBy({
      by: ['leadId'],
      where: { ...leadSmsWhere(user.organizationId), direction: SMS_IN, readAt: null },
      _count: { _all: true },
    }),
    showClients
      ? db.communication.findMany({
          where: { channel: 'SMS', isInternal: false, client: clientScope(user) },
          orderBy: { occurredAt: 'desc' },
          take: THREAD_LIMIT * 5,
          select: { clientId: true, body: true, direction: true, occurredAt: true },
        })
      : Promise.resolve([]),
    showClients
      ? db.communication.groupBy({
          by: ['clientId'],
          where: clientUnreadWhere(user, now),
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ])

  const latestLead = new Map<string, (typeof leadRows)[number]>()
  for (const row of leadRows) if (!latestLead.has(row.leadId)) latestLead.set(row.leadId, row)
  const latestClient = new Map<string, (typeof clientRows)[number]>()
  for (const row of clientRows) if (!latestClient.has(row.clientId)) latestClient.set(row.clientId, row)

  const [leads, clients] = await Promise.all([
    latestLead.size
      ? db.callCenterLead.findMany({
          where: { id: { in: [...latestLead.keys()] }, organizationId: user.organizationId },
          select: { id: true, phoneLast4: true, events: { where: { type: 'FORM' }, select: { body: true }, take: 1 } },
        })
      : Promise.resolve([]),
    latestClient.size
      ? db.client.findMany({
          where: { AND: [clientScope(user), { id: { in: [...latestClient.keys()] } }] },
          select: { id: true, firstName: true, lastName: true, phone: true },
        })
      : Promise.resolve([]),
  ])

  const leadUnreadBy = new Map(leadUnread.map((g) => [g.leadId, g._count._all]))
  const clientUnreadBy = new Map(clientUnread.map((g) => [g.clientId, g._count._all]))
  const threads: ThreadSummaryVM[] = []

  const phones = await leadPhonesFor(user, leads.map((l) => l.id))
  for (const lead of leads) {
    const last = latestLead.get(lead.id)!
    const last4 = lead.phoneLast4 && /^\d{4}$/.test(lead.phoneLast4) ? lead.phoneLast4 : null
    const phone = phones.get(lead.id) ?? null
    threads.push({
      key: threadKeyString({ kind: 'lead', id: lead.id }),
      kind: 'lead',
      name: leadThreadName(leadNameFrom(lead.events), last4, phone),
      last4,
      phone,
      snippet: snippet(readSmsEvent(last.body)?.detail ?? ''),
      lastDirection: last.direction === SMS_IN ? 'in' : 'out',
      at: last.createdAt.toISOString(),
      timeLabel: listTimeLabel(last.createdAt, now),
      unread: leadUnreadBy.get(lead.id) ?? 0,
    })
  }
  for (const client of clients) {
    const last = latestClient.get(client.id)!
    const last4 = last4Of(client.phone)
    threads.push({
      key: threadKeyString({ kind: 'client', id: client.id }),
      kind: 'client',
      name: displayName(`${client.firstName} ${client.lastName}`, last4),
      last4,
      phone: leadPhoneView(client.phone, Boolean(client.phone)),
      snippet: snippet(last.body ?? ''),
      lastDirection: last.direction === 'INBOUND' ? 'in' : 'out',
      at: last.occurredAt.toISOString(),
      timeLabel: listTimeLabel(last.occurredAt, now),
      unread: clientUnreadBy.get(client.id) ?? 0,
    })
  }

  threads.sort((a, b) => b.at.localeCompare(a.at))
  return threads.slice(0, THREAD_LIMIT)
}

function clientUnreadWhere(user: SessionUser, now: Date) {
  return {
    channel: 'SMS' as const,
    direction: 'INBOUND' as const,
    isInternal: false,
    occurredAt: { gte: new Date(now.getTime() - CLIENT_UNREAD_DAYS * 86_400_000) },
    message: { is: { readAt: null } },
    client: clientScope(user),
  }
}

/** Unread inbound texts for the Messages tab badge. */
export async function countUnreadMessages(user: SessionUser, now = new Date()): Promise<number> {
  try {
    const [leads, clients] = await Promise.all([
      db.callCenterEvent.count({ where: { ...leadSmsWhere(user.organizationId), direction: SMS_IN, readAt: null } }),
      clientsVisible(user) ? db.communication.count({ where: clientUnreadWhere(user, now) }) : Promise.resolve(0),
    ])
    return leads + clients
  } catch {
    // A badge never takes the desk down.
    return 0
  }
}

// ── One thread ───────────────────────────────────────────────────────────────

export async function loadThread(user: SessionUser, key: ThreadKey): Promise<ThreadVM | null> {
  return key.kind === 'lead' ? loadLeadThread(user, key.id) : loadClientThread(user, key.id)
}

async function loadLeadThread(user: SessionUser, leadId: string): Promise<ThreadVM | null> {
  const lead = await db.callCenterLead.findFirst({
    where: { id: leadId, organizationId: user.organizationId },
    select: {
      id: true,
      phoneLast4: true,
      lockedBy: true,
      doNotCallAt: true,
      events: { where: { type: 'FORM' }, select: { body: true }, take: 1 },
    },
  })
  if (!lead) return null
  const rows = await db.callCenterEvent.findMany({
    where: { leadId, type: 'SMS', direction: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: MESSAGE_LIMIT,
    select: { id: true, body: true, direction: true, createdAt: true },
  })
  rows.reverse()
  const names = await userFirstNames(rows.flatMap((r) => (r.direction === SMS_OUT ? [readSmsEvent(r.body)?.userId ?? ''] : [])))
  const last4 = lead.phoneLast4 && /^\d{4}$/.test(lead.phoneLast4) ? lead.phoneLast4 : null
  const gate = leadSendGate(user, lead)
  const phone = (await leadPhonesFor(user, [lead.id])).get(lead.id) ?? null
  return {
    key: threadKeyString({ kind: 'lead', id: lead.id }),
    kind: 'lead',
    name: leadThreadName(leadNameFrom(lead.events), last4, phone),
    last4,
    phone,
    messages: rows.map((r) => leadMessage(r, names)),
    canSend: gate === null,
    sendNote: gate,
    openHref: `/call-center?s=leads&lead=${encodeURIComponent(lead.id)}`,
  }
}

/** Null when the actor may text this lead; else the plain reason. The carrier rules still decide on send. */
function leadSendGate(user: SessionUser, lead: { lockedBy: string | null; doNotCallAt: Date | null }): string | null {
  if (!can(user, 'communications:send')) return "You don't have permission to send texts."
  if (lead.doNotCallAt) return 'This lead is on the do-not-call list.'
  if (lead.lockedBy && lead.lockedBy !== user.id && !can(user, 'telephony:manage')) return 'Another rep has this lead.'
  return null
}

async function loadClientThread(user: SessionUser, clientId: string): Promise<ThreadVM | null> {
  if (!clientsVisible(user)) return null
  const client = await db.client.findFirst({
    where: { AND: [clientScope(user), { id: clientId }] },
    select: { id: true, firstName: true, lastName: true, phone: true },
  })
  if (!client) return null
  const rows = await db.communication.findMany({
    where: { clientId, channel: 'SMS', isInternal: false },
    orderBy: { occurredAt: 'desc' },
    take: MESSAGE_LIMIT,
    select: {
      id: true,
      body: true,
      direction: true,
      status: true,
      occurredAt: true,
      user: { select: { name: true } },
      message: { select: { failureCode: true } },
    },
  })
  rows.reverse()
  const last4 = last4Of(client.phone)
  const canSend = can(user, 'communications:send')
  return {
    key: threadKeyString({ kind: 'client', id: client.id }),
    kind: 'client',
    name: displayName(`${client.firstName} ${client.lastName}`, last4),
    last4,
    phone: leadPhoneView(client.phone, Boolean(client.phone)),
    messages: rows.map(clientMessage),
    canSend,
    sendNote: canSend ? null : "You don't have permission to send texts.",
    openHref: `/clients/${encodeURIComponent(client.id)}`,
  }
}

/** Opening a thread marks its inbound texts read. Returns how many changed. */
export async function markThreadRead(user: SessionUser, key: ThreadKey, now = new Date()): Promise<number> {
  if (key.kind === 'lead') {
    const res = await db.callCenterEvent.updateMany({
      where: { leadId: key.id, type: 'SMS', direction: SMS_IN, readAt: null, lead: { organizationId: user.organizationId } },
      data: { readAt: now },
    })
    return res.count
  }
  if (!clientsVisible(user)) return 0
  const res = await db.message.updateMany({
    where: {
      readAt: null,
      communication: { clientId: key.id, channel: 'SMS', direction: 'INBOUND', client: clientScope(user) },
    },
    data: { readAt: now },
  })
  return res.count
}

// ── Send ─────────────────────────────────────────────────────────────────────

export async function sendThreadText(user: SessionUser, key: ThreadKey, text: string, now = new Date()): Promise<SendTextResult> {
  if (key.kind === 'lead') return sendLeadText(user, key.id, text, now)
  try {
    const out = await sendMessage(user, { clientId: key.id, channel: 'SMS', body: text })
    if (!out.ok) return { ok: false, error: out.error }
    const row = await db.communication.findUniqueOrThrow({
      where: { id: out.communicationId },
      select: {
        id: true,
        body: true,
        direction: true,
        status: true,
        occurredAt: true,
        user: { select: { name: true } },
        message: { select: { failureCode: true } },
      },
    })
    return { ok: true, message: clientMessage(row) }
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: err.message }
    throw err
  }
}

function attributionState(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const state = (raw as { state?: unknown }).state
  return typeof state === 'string' ? state : null
}

/**
 * Text a Call Center lead. The number is read from the lead's secret on the
 * server; the one outbound decision runs first (a block sends nothing and
 * writes nothing). What the carrier answered is stored as-is: a failure is
 * kept on the thread with its reason, never shown as sent.
 */
export async function sendLeadText(user: SessionUser, leadId: string, text: string, now = new Date()): Promise<SendTextResult> {
  const lead = await db.callCenterLead.findFirst({
    where: { id: leadId, organizationId: user.organizationId },
    select: {
      id: true,
      lockedBy: true,
      doNotCallAt: true,
      phoneSecret: true,
      timeZone: true,
      leadAttribution: true,
      outOfArea: true,
    },
  })
  if (!lead) return { ok: false, error: "That lead isn't in your list." }
  const gate = leadSendGate(user, lead)
  if (gate) return { ok: false, error: gate }
  const phone = readSecret(lead.phoneSecret)
  if (!phone) return { ok: false, error: 'This lead has no phone number on file.' }

  const decision = await decideOutbound(
    {
      organizationId: user.organizationId,
      channel: 'SMS',
      purpose: 'marketing',
      phone,
      leadId: lead.id,
      zoneHints: {
        leadZone: lead.timeZone,
        states: [attributionState(lead.leadAttribution)],
        e164: toE164(phone),
        outOfArea: lead.outOfArea,
      },
    },
    { actor: user, now },
  )
  if (!decision.allowed) return { ok: false, error: decision.reason }

  const result = await getSmsProvider().send({ to: decision.e164, body: text, organizationId: user.organizationId })
  const sent = result.status === 'SENT'
  const row = await db.callCenterEvent.create({
    data: {
      leadId: lead.id,
      type: 'SMS',
      direction: SMS_OUT,
      externalRef: result.externalRef,
      createdAt: now,
      body: smsEventBody({
        label: sent ? 'Text sent' : 'Text not sent',
        detail: text,
        userId: user.id,
        status: sent ? 'sent' : 'failed',
        ...(sent ? {} : { error: (result.error ?? 'Unknown error').slice(0, 300) }),
      }),
    },
    select: { id: true, body: true, direction: true, createdAt: true },
  })
  await db.auditEvent
    .create({
      data: {
        organizationId: user.organizationId,
        actorId: user.id,
        action: 'call_center.text',
        entityType: 'CallCenterLead',
        entityId: lead.id,
        summary: `${sent ? 'Texted' : 'Text failed to'} ${maskedLast4(phone)}`,
        after: { status: result.status, last4: last4Of(phone), externalRef: result.externalRef },
      },
    })
    .catch(() => undefined)
  const names = new Map(firstName(user.name) ? [[user.id, firstName(user.name)!]] : [])
  return { ok: true, message: leadMessage(row, names) }
}

// ── Carrier side ─────────────────────────────────────────────────────────────

/**
 * An inbound text whose sender's number matches a Call Center lead in the
 * org. Written on the newest such lead. The row id is derived from the
 * carrier message id, so a webhook replay writes nothing. Never throws: the
 * webhook's other work must not depend on it.
 */
export async function recordInboundLeadText(
  organizationId: string | null,
  payload: { from: string; body: string; external_id: string },
  at = new Date(),
): Promise<{ leadId: string } | null> {
  if (!organizationId || !payload.external_id) return null
  try {
    const hash = phoneHashOrNull(payload.from)
    if (!hash) return null
    const lead = await db.callCenterLead.findFirst({
      where: { organizationId, phoneHash: hash },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (!lead) return null
    try {
      await db.callCenterEvent.create({
        data: {
          id: inboundEventId(payload.external_id),
          leadId: lead.id,
          type: 'SMS',
          direction: SMS_IN,
          externalRef: payload.external_id,
          createdAt: at,
          body: smsEventBody({ label: 'Text received', detail: payload.body.slice(0, 2000), status: 'received' }),
        },
      })
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
    }
    // The team chat shows this lead's case thread: ask it to pull now instead of on its next poll.
    void import('@/lib/chat-bridge/remote').then((m) => m.pingChatCases([lead.id])).catch(() => {})
    return { leadId: lead.id }
  } catch {
    return null
  }
}

/** One row per carrier message: the primary key is the idempotency key. */
export function inboundEventId(externalId: string): string {
  return `smsin_${externalId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100)}`
}

/**
 * Twilio's delivery report for a lead text (no Communication row). Forward
 * only: 'delivered' and 'failed' are final; 30034 shows as "waiting on carrier
 * approval" on the bubble.
 */
export async function applyLeadSmsStatus(
  organizationId: string,
  messageSid: string,
  input: { status: string | null | undefined; errorCode: string | null | undefined },
): Promise<'delivered' | 'failed' | 'ignored'> {
  if (!messageSid) return 'ignored'
  const status = (input.status ?? '').toLowerCase()
  if (status !== 'delivered' && status !== 'undelivered' && status !== 'failed') return 'ignored'
  const row = await db.callCenterEvent.findFirst({
    where: { externalRef: messageSid, type: 'SMS', direction: SMS_OUT, lead: { organizationId } },
    select: { id: true, body: true },
  })
  if (!row) return 'ignored'
  const copy = readSmsEvent(row.body)
  if (!copy || copy.status === 'delivered' || copy.status === 'failed') return 'ignored'
  const delivered = status === 'delivered'
  await db.callCenterEvent.update({
    where: { id: row.id },
    data: {
      body: smsEventBody({
        ...copy,
        label: delivered ? copy.label : 'Text not sent',
        status: delivered ? 'delivered' : 'failed',
        ...(delivered ? {} : { error: input.errorCode ? failureCodeText(input.errorCode) : 'Delivery failed (no carrier code)' }),
      }),
    },
  })
  return delivered ? 'delivered' : 'failed'
}
