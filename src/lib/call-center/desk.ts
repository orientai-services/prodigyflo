import 'server-only'
import type { CallCenterEventType, CallCenterLeadStatus, VoiceCall } from '@prisma/client'
import { db } from '@/lib/db'
import { isUniqueViolation, recordingPath } from '@/lib/telephony/voice-calls'
import { last4Of, phoneHashOrNull } from '@/lib/telephony/compliance-core'
import { readSecret } from './contact'
import { callLeadsForDesk, type StoredCallCenterLead } from './from-rows'
import { validateCallbackAt } from './cadence'
import { CALL_RESULT_UNKNOWN, planCarrierCall } from './carrier'
import {
  PREVIEW_BANNER,
  applyLeadAction,
  applyOutcome,
  isOutcome,
  saveNote,
  sendIntakeLink,
  type CallLead,
  type TrailEvent,
  type TrailKind,
} from './model'
import type { CallCenterContact, DeskActor, DeskOutcome, DeskResult } from './desk-types'

const EMPTY_CONTACT: CallCenterContact = { phone: null, email: null }

function missingRelation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = 'code' in err ? String((err as { code?: unknown }).code ?? '') : ''
  if (code === 'P2021' || code === 'P2022' || code === '42P01' || code === '42703') return true
  const message = err instanceof Error ? err.message : ''
  return /CallCenterLead|VoiceCall/i.test(message) && /does not exist|undefined_table|P2021|P2022/i.test(message)
}

/** Shown on a desk "Call" made through the phone's own dialer (tel: link). */
export const TEL_DIAL_DETAIL = 'Dialled from a phone after the calling-rules check. Not recorded.'

function dbStatus(lead: CallLead): CallCenterLeadStatus {
  if (lead.status === 'booked') return 'BOOKED'
  if (lead.status === 'missed' || lead.status === 'retry') return 'MISSED'
  if (lead.status === 'inbound') return 'INBOUND'
  return 'WAITING'
}

function eventType(kind: TrailKind): CallCenterEventType {
  switch (kind) {
    case 'form': return 'FORM'
    case 'inbound': return 'INBOUND'
    case 'call': return 'CALL'
    case 'sms': return 'SMS'
    case 'outcome': return 'OUTCOME'
    case 'note': return 'NOTE'
    case 'lock': return 'LOCK'
    case 'intake': return 'INTAKE_LINK'
    default: return 'NOTE'
  }
}

function eventBody(event: TrailEvent): string {
  return JSON.stringify({
    label: event.label.replace(/\d{5,}/g, '····'),
    detail: event.detail.replace(/\d{5,}/g, '····'),
    // The follow-up marker is what tells a callback from a cadence retry later.
    ...(event.followUp ? { followUp: event.followUp } : {}),
  })
}

async function lockNames(organizationId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return new Map()
  const users = await db.user.findMany({
    where: { organizationId, id: { in: unique } },
    select: { id: true, name: true },
  })
  return new Map(users.map((user) => [user.id, user.name]))
}

function toStored(row: {
  id: string
  pageId: string | null
  source: 'FORM' | 'INBOUND'
  language: 'EN' | 'ES'
  status: 'WAITING' | 'INBOUND' | 'MISSED' | 'BOOKED'
  tries: number
  nextAttemptAt: Date | null
  lockedBy: string | null
  doNotCallAt: Date | null
  phoneLast4: string | null
  createdAt: Date
  events: { type: string; body: string; createdAt: Date }[]
  timeZone?: string | null
}): StoredCallCenterLead {
  return row
}

/**
 * Real recordings and open missed calls for the desk, keyed for from-rows.
 * Only the internal playback path is handed out — never Twilio's URL — and
 * the playback route checks access again on every request.
 */
async function deskCallExtras(organizationId: string, leadIds: string[]) {
  const recordings = new Map<string, { src: string; seconds: number; transcript?: string | null }>()
  const missedByLead = new Map<string, string>()
  const missedAtByLead = new Map<string, string>()
  const callbackByLead = new Set<string>()
  if (leadIds.length === 0) return { recordings, missedByLead, missedAtByLead, callbackByLead }
  const calls = await db.voiceCall.findMany({
    where: { organizationId, callCenterLeadId: { in: leadIds } },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      callCenterLeadId: true,
      recordingSid: true,
      recordingDurationSeconds: true,
      needsAction: true,
      handledAt: true,
      startedAt: true,
      transcript: true,
      callbackRequested: true,
    },
  })
  for (const vc of calls) {
    if (vc.recordingSid) recordings.set(vc.id, { src: recordingPath(vc.id), seconds: vc.recordingDurationSeconds ?? 0, transcript: vc.transcript })
    if (vc.needsAction && !vc.handledAt && vc.callCenterLeadId && !missedByLead.has(vc.callCenterLeadId)) {
      missedByLead.set(vc.callCenterLeadId, vc.id)
      missedAtByLead.set(vc.callCenterLeadId, vc.startedAt.toISOString())
    }
    // Any open press-1 request from this lead puts them at the top of Today.
    if (vc.callbackRequested && vc.needsAction && !vc.handledAt && vc.callCenterLeadId) callbackByLead.add(vc.callCenterLeadId)
  }
  return { recordings, missedByLead, missedAtByLead, callbackByLead }
}

/** Desk list for one org. Secrets stay on the server. */
export async function loadCallCenterLeadsFor(organizationId: string, viewerId: string): Promise<CallLead[]> {
  const rows = await db.callCenterLead.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      pageId: true,
      source: true,
      language: true,
      status: true,
      tries: true,
      nextAttemptAt: true,
      lockedBy: true,
      doNotCallAt: true,
      phoneLast4: true,
      createdAt: true,
      timeZone: true,
      events: { orderBy: { createdAt: 'asc' }, select: { type: true, body: true, createdAt: true } },
    },
  })
  const names = await lockNames(organizationId, rows.map((row) => row.lockedBy || ''))
  const extras = await deskCallExtras(organizationId, rows.map((row) => row.id)).catch((err) => {
    // An unmigrated VoiceCall table must not take the desk down.
    if (missingRelation(err)) return undefined
    throw err
  })
  return callLeadsForDesk(rows.map(toStored), viewerId, names, extras)
}

async function publicLead(organizationId: string, viewerId: string, leadId: string): Promise<CallLead | null> {
  const leads = await loadCallCenterLeadsFor(organizationId, viewerId)
  return leads.find((lead) => lead.id === leadId) ?? null
}

export async function revealCallCenterContactFor(
  organizationId: string,
  userId: string,
  leadId: string,
): Promise<CallCenterContact> {
  const row = await db.callCenterLead.findFirst({
    where: { id: leadId, organizationId },
    select: { lockedBy: true, doNotCallAt: true, phoneSecret: true, emailSecret: true },
  })
  if (!row || row.doNotCallAt || row.lockedBy !== userId) return EMPTY_CONTACT
  const phone = readSecret(row.phoneSecret)
  const email = readSecret(row.emailSecret)
  return {
    phone: phone && phone.replace(/\D/g, '').length >= 4 ? phone : null,
    email: email && email.includes('@') ? email : null,
  }
}

export async function takeCallCenterLeadFor(
  organizationId: string,
  actor: DeskActor,
  leadId: string,
  at = new Date(),
): Promise<DeskResult> {
  const claimed = await db.callCenterLead.updateMany({
    where: { id: leadId, organizationId, lockedBy: null, doNotCallAt: null },
    data: { lockedBy: actor.id },
  })
  if (claimed.count !== 1) {
    const row = await db.callCenterLead.findFirst({
      where: { id: leadId, organizationId },
      select: { lockedBy: true, doNotCallAt: true },
    })
    if (!row) return { ok: false, error: 'Lead not found' }
    if (row.doNotCallAt) return { ok: false, error: 'Do not call' }
    if (row.lockedBy === actor.id) {
      const lead = await publicLead(organizationId, actor.id, leadId)
      return lead ? { ok: true, lead } : { ok: false, error: 'Lead not found' }
    }
    return { ok: false, error: 'Another rep has this lead' }
  }
  await db.callCenterEvent.create({
    data: {
      leadId,
      type: 'LOCK',
      createdAt: at,
      body: JSON.stringify({ action: 'take', userId: actor.id, name: actor.name, label: 'Lock' }),
    },
  })
  const lead = await publicLead(organizationId, actor.id, leadId)
  return lead ? { ok: true, lead } : { ok: false, error: 'Lead not found' }
}

export async function skipCallCenterLeadFor(
  organizationId: string,
  actor: DeskActor,
  leadId: string,
  at = new Date(),
): Promise<DeskResult> {
  const released = await db.callCenterLead.updateMany({
    where: { id: leadId, organizationId, lockedBy: actor.id },
    data: { lockedBy: null },
  })
  if (released.count === 1) {
    await db.callCenterEvent.create({
      data: {
        leadId,
        type: 'LOCK',
        createdAt: at,
        body: JSON.stringify({ action: 'skip', userId: actor.id, name: actor.name, label: 'Lock', detail: 'Skipped' }),
      },
    })
  } else {
    const row = await db.callCenterLead.findFirst({
      where: { id: leadId, organizationId },
      select: { lockedBy: true },
    })
    if (!row) return { ok: false, error: 'Lead not found' }
    if (row.lockedBy && row.lockedBy !== actor.id) return { ok: false, error: 'Another rep has this lead' }
  }
  const lead = await publicLead(organizationId, actor.id, leadId)
  return lead ? { ok: true, lead } : { ok: false, error: 'Lead not found' }
}

type HeldRow = {
  id: string
  pageId: string | null
  source: 'FORM' | 'INBOUND'
  language: 'EN' | 'ES'
  status: 'WAITING' | 'INBOUND' | 'MISSED' | 'BOOKED'
  tries: number
  nextAttemptAt: Date | null
  lockedBy: string | null
  doNotCallAt: Date | null
  phoneLast4: string | null
  createdAt: Date
  intakeLinkSentAt: Date | null
  timeZone: string | null
  events: { type: string; body: string; createdAt: Date }[]
}

type HeldLead =
  | { ok: false; error: string }
  | { ok: true; row: HeldRow; lead: CallLead }

async function heldLead(organizationId: string, actor: DeskActor, leadId: string): Promise<HeldLead> {
  const row = await db.callCenterLead.findFirst({
    where: { id: leadId, organizationId },
    select: {
      id: true,
      pageId: true,
      source: true,
      language: true,
      status: true,
      tries: true,
      nextAttemptAt: true,
      lockedBy: true,
      doNotCallAt: true,
      phoneLast4: true,
      createdAt: true,
      intakeLinkSentAt: true,
      // The cadence and the callback picker work in the lead's own zone.
      timeZone: true,
      events: { orderBy: { createdAt: 'asc' as const }, select: { type: true, body: true, createdAt: true } },
    },
  })
  if (!row) return { ok: false, error: 'Lead not found' }
  if (row.lockedBy !== actor.id) return { ok: false, error: 'Another rep has this lead' }
  const names = await lockNames(organizationId, [actor.id])
  const lead = callLeadsForDesk([toStored(row)], actor.id, names)[0]
  if (!lead) return { ok: false, error: 'Lead not found' }
  return { ok: true, row, lead }
}

function trailKey(event: TrailEvent): string {
  return JSON.stringify([event.kind, event.at, event.label, event.detail])
}

/** A new event can sort ahead of a row saved later, so the tail is not the new set. */
function addedTrailEvents(before: CallLead, after: CallLead): TrailEvent[] {
  const remaining = new Map<string, number>()
  for (const event of before.trail) {
    const key = trailKey(event)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  const added: TrailEvent[] = []
  for (const event of after.trail) {
    const key = trailKey(event)
    const count = remaining.get(key) ?? 0
    if (count > 0) remaining.set(key, count - 1)
    else added.push(event)
  }
  return added
}

async function writeTrail(
  organizationId: string,
  actor: DeskActor,
  leadId: string,
  before: CallLead,
  after: CallLead,
  at: Date,
  extra: { doNotCallAt?: Date | null; intakeLinkSentAt?: Date | null } = {},
): Promise<DeskResult> {
  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.callCenterLead.updateMany({
        where: { id: leadId, organizationId, lockedBy: actor.id },
        data: {
          tries: after.tries,
          nextAttemptAt: after.nextAttemptAt ? new Date(after.nextAttemptAt) : null,
          status: dbStatus(after),
          doNotCallAt: extra.doNotCallAt === undefined ? undefined : extra.doNotCallAt,
          intakeLinkSentAt: extra.intakeLinkSentAt === undefined ? undefined : extra.intakeLinkSentAt,
        },
      })
      if (updated.count !== 1) throw new Error('LOCK_LOST')
      for (const event of addedTrailEvents(before, after)) {
        await tx.callCenterEvent.create({
          data: { leadId, type: eventType(event.kind), body: eventBody(event), createdAt: at },
        })
      }
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'LOCK_LOST') return { ok: false, error: 'Another rep has this lead' }
    throw err
  }
  const lead = await publicLead(organizationId, actor.id, leadId)
  return lead ? { ok: true, lead } : { ok: false, error: 'Lead not found' }
}

export async function recordCallCenterOutcomeFor(
  organizationId: string,
  actor: DeskActor,
  leadId: string,
  outcome: DeskOutcome,
  at = new Date(),
  options: { callbackAt?: string | null } = {},
): Promise<DeskResult> {
  if (!isOutcome(outcome)) return { ok: false, error: 'Not allowed' }
  let callbackAt: string | null = null
  if (options.callbackAt != null) {
    if (outcome !== 'callback') return { ok: false, error: 'Not allowed' }
    const checked = validateCallbackAt(options.callbackAt, at)
    if (!checked.ok) return { ok: false, error: checked.error }
    callbackAt = checked.at.toISOString()
  }
  const held = await heldLead(organizationId, actor, leadId)
  if (!held.ok) return { ok: false, error: held.error }
  if (held.row.doNotCallAt) return { ok: false, error: 'Do not call' }
  const stamp = at.toISOString()
  const after = applyOutcome(held.lead, outcome, stamp, actor.id, { callbackAt })
  if (after === held.lead) return { ok: false, error: 'Not allowed' }
  const result = await writeTrail(organizationId, actor, leadId, held.lead, after, at, {
    doNotCallAt: after.dnc ? held.row.doNotCallAt ?? at : null,
  })
  if (result.ok && outcome === 'do_not_call') await suppressLeadNumber(organizationId, leadId, actor.id, at)
  return result
}

/**
 * "Do not call" puts the NUMBER on the org's do-not-contact list (calls and
 * texts), not only the lead row — so a second lead, a client, or an inbound
 * caller with the same number is blocked too. A save failure is reported to
 * the admins rather than dropped.
 */
async function suppressLeadNumber(organizationId: string, leadId: string, userId: string, at: Date): Promise<void> {
  try {
    const row = await db.callCenterLead.findFirst({
      where: { id: leadId, organizationId },
      select: { phoneSecret: true, phoneHash: true, phoneLast4: true },
    })
    const phone = readSecret(row?.phoneSecret)
    const hash = row?.phoneHash ?? phoneHashOrNull(phone)
    if (!hash) throw new Error('No phone hash for this lead.')
    const { blockNumber } = await import('@/lib/telephony/suppressions')
    await blockNumber(
      {
        organizationId,
        numberHash: hash,
        last4: row?.phoneLast4 ?? last4Of(phone),
        sms: 'call_center',
        call: 'call_center',
        reason: 'Do not call (Call Center)',
        createdById: userId,
      },
      at,
    )
    await db.auditEvent.create({
      data: {
        organizationId,
        actorId: userId,
        actorLabel: 'Call Center',
        action: 'telephony.suppression_added',
        entityType: 'CallCenterLead',
        entityId: leadId,
        summary: `Number ending ${row?.phoneLast4 ?? '····'} added to the do-not-call list`,
        after: { source: 'call_center', last4: row?.phoneLast4 ?? null },
      },
    })
  } catch {
    const admins = await db.user.findMany({
      where: { organizationId, isActive: true, deletedAt: null, role: { key: 'SUPER_ADMIN' } },
      select: { id: true },
    })
    if (admins.length) {
      await db.notification.createMany({
        data: admins.map((a) => ({
          organizationId,
          userId: a.id,
          kind: 'SYSTEM' as const,
          title: 'Do-not-call not saved',
          body: 'A Call Center "Do not call" could not be added to the list. Add it by hand under Phone setup.',
          href: '/call-center',
        })),
      })
    }
  }
}

export async function recordCallCenterNoteFor(
  organizationId: string,
  actor: DeskActor,
  leadId: string,
  text: string,
  at = new Date(),
): Promise<DeskResult> {
  const held = await heldLead(organizationId, actor, leadId)
  if (!held.ok) return { ok: false, error: held.error }
  const after = saveNote(held.lead, text, at.toISOString(), actor.id)
  if (after === held.lead) return { ok: false, error: 'Not allowed' }
  return writeTrail(organizationId, actor, leadId, held.lead, after, at)
}

export async function sendCallCenterIntakeFor(
  organizationId: string,
  actor: DeskActor,
  leadId: string,
  at = new Date(),
): Promise<DeskResult> {
  const held = await heldLead(organizationId, actor, leadId)
  if (!held.ok) return { ok: false, error: held.error }
  if (held.row.doNotCallAt) return { ok: false, error: 'Do not call' }
  const after = sendIntakeLink(held.lead, at.toISOString(), actor.id)
  if (after === held.lead) return { ok: false, error: 'Not allowed' }
  return writeTrail(organizationId, actor, leadId, held.lead, after, at, {
    intakeLinkSentAt: held.row.intakeLinkSentAt ?? at,
  })
}

export async function recordCallCenterAttemptFor(
  organizationId: string,
  actor: DeskActor,
  leadId: string,
  at = new Date(),
): Promise<DeskResult> {
  const held = await heldLead(organizationId, actor, leadId)
  if (!held.ok) return { ok: false, error: held.error }
  if (held.row.doNotCallAt) return { ok: false, error: 'Do not call' }
  const stamp = at.toISOString()
  const dialled = applyLeadAction(held.lead, 'call', stamp, actor.id)
  if (dialled === held.lead) return { ok: false, error: 'Not allowed' }
  // The tel: flow dials from the rep's own phone: say so, not "preview".
  const after = {
    ...dialled,
    trail: dialled.trail.map((event) =>
      event.kind === 'call' && event.at === stamp && event.detail === PREVIEW_BANNER ? { ...event, detail: TEL_DIAL_DETAIL } : event,
    ),
  }
  return writeTrail(organizationId, actor, leadId, held.lead, after, at)
}

/**
 * A real carrier call to a lead (P0b browser calls). System write — the
 * webhook has no session — of a CALL event with what actually happened, plus
 * the cadence rule in carrier.ts: an unanswered call (or one answered for
 * under 20 s) advances the no-answer cadence; a longer one marks the lead
 * reached and clears a cadence-only follow-up.
 *
 * Once per call: the event carries the call's id under a unique
 * (voiceCallId, type) key and the lead update rides in the same transaction,
 * so when two callbacks finish the same call at once the second insert fails
 * and its whole transaction (the cadence step too) rolls back.
 *
 * A call whose result never arrived (the sweep's give-up: status 'unknown',
 * no outcome) is not guessed at: the trail says "Call result unknown" and the
 * lead's tries, next attempt and status stay as they were, for a rep to set.
 */
export { CALL_RESULT_UNKNOWN }

export async function recordCarrierCallFor(
  organizationId: string,
  leadId: string,
  voiceCall: Pick<VoiceCall, 'id' | 'outcome' | 'status' | 'talkSeconds' | 'endedAt' | 'userId'> &
    Partial<Pick<VoiceCall, 'startedAt'>>,
  at = new Date(),
): Promise<void> {
  const marker = `"voiceCallId":"${voiceCall.id}"`
  const already = await db.callCenterEvent.findFirst({
    where: { leadId, type: 'CALL', OR: [{ voiceCallId: voiceCall.id }, { body: { contains: marker } }] },
    select: { id: true },
  })
  if (already) return
  const row = await db.callCenterLead.findFirst({
    where: { id: leadId, organizationId },
    select: {
      id: true,
      pageId: true,
      source: true,
      language: true,
      status: true,
      tries: true,
      nextAttemptAt: true,
      lockedBy: true,
      doNotCallAt: true,
      phoneLast4: true,
      createdAt: true,
      timeZone: true,
      events: { orderBy: { createdAt: 'asc' as const }, select: { type: true, body: true, createdAt: true } },
    },
  })
  if (!row) return
  // The trail says whether the follow-up is a callback and whether the rep
  // already counted this call; the plan reads both from the desk's own lead.
  const lead = callLeadsForDesk([toStored(row)], null)[0]
  if (!lead) return
  const plan = planCarrierCall(
    lead,
    row,
    {
      outcome: voiceCall.outcome,
      status: voiceCall.status,
      talkSeconds: voiceCall.talkSeconds,
      startedAt: voiceCall.startedAt ?? null,
      endedAt: voiceCall.endedAt,
    },
    at,
  )
  const event = db.callCenterEvent.create({
    data: {
      leadId,
      type: 'CALL',
      voiceCallId: voiceCall.id,
      createdAt: voiceCall.endedAt ?? at,
      body: JSON.stringify({
        label: 'Call',
        detail: plan.detail,
        voiceCallId: voiceCall.id,
        userId: voiceCall.userId ?? undefined,
        ...(plan.followUp ? { followUp: plan.followUp } : {}),
        ...(plan.connected ? { connected: true } : {}),
      }),
    },
  })
  try {
    if (plan.update) {
      await db.$transaction([event, db.callCenterLead.update({ where: { id: leadId }, data: plan.update })])
    } else {
      await event
    }
  } catch (err) {
    // Another callback already recorded this call: nothing more to write.
    if (!isUniqueViolation(err)) throw err
  }
}

export async function recordCallCenterTextFor(
  organizationId: string,
  actor: DeskActor,
  leadId: string,
  at = new Date(),
): Promise<DeskResult> {
  const held = await heldLead(organizationId, actor, leadId)
  if (!held.ok) return { ok: false, error: held.error }
  if (held.row.doNotCallAt) return { ok: false, error: 'Do not call' }
  const stamp = at.toISOString()
  const after = applyLeadAction(held.lead, 'text', stamp, actor.id)
  if (after === held.lead) return { ok: false, error: 'Not allowed' }
  return writeTrail(organizationId, actor, leadId, held.lead, after, at)
}

export { missingRelation }
