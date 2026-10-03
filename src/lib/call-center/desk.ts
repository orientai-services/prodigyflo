import 'server-only'
import type { CallCenterEventType, CallCenterLeadStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { readSecret } from './contact'
import { callLeadsForDesk, type StoredCallCenterLead } from './from-rows'
import {
  applyLeadAction,
  applyOutcome,
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
  return /CallCenterLead/i.test(message) && /does not exist|undefined_table|P2021|P2022/i.test(message)
}

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
}): StoredCallCenterLead {
  return row
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
      events: { orderBy: { createdAt: 'asc' }, select: { type: true, body: true, createdAt: true } },
    },
  })
  const names = await lockNames(organizationId, rows.map((row) => row.lockedBy || ''))
  return callLeadsForDesk(rows.map(toStored), viewerId, names)
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
      for (const event of after.trail.slice(before.trail.length)) {
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
): Promise<DeskResult> {
  const held = await heldLead(organizationId, actor, leadId)
  if (!held.ok) return { ok: false, error: held.error }
  if (held.row.doNotCallAt) return { ok: false, error: 'Do not call' }
  const stamp = at.toISOString()
  const after = applyOutcome(held.lead, outcome, stamp, actor.id)
  if (after === held.lead) return { ok: false, error: 'Not allowed' }
  return writeTrail(organizationId, actor, leadId, held.lead, after, at, {
    doNotCallAt: after.dnc ? held.row.doNotCallAt ?? at : null,
  })
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
  const after = applyLeadAction(held.lead, 'call', at.toISOString(), actor.id)
  if (after === held.lead) return { ok: false, error: 'Not allowed' }
  return writeTrail(organizationId, actor, leadId, held.lead, after, at)
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
