import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { getEmailProvider, getSmsProvider } from '@/lib/messaging'
import { decideOutbound } from '@/lib/telephony/compliance'
import { toE164 } from '@/lib/telephony/provider'
import { readSecret } from '../contact'
import { callLeadFromRow } from '../from-rows'
import { visibleOnGrid } from './planner'
import { autobookEnabled, calendarReps, VISIT_MINUTES, REP_GAP_MINUTES, MAX_DAYS_AHEAD } from './config'
import { bookingSkipReason } from './eligibility'
import { canConfirm, planOutcome, type CalendarOutcome, type SlotStatus } from './outcomes'
import { dueReminders, reminderMessage, type ReminderJob } from './reminders'
import { openSlots, slotProblem, type BusySlot, type RepHours } from './slots'

const MIN = 60_000
const ACTIVE: SlotStatus[] = ['HOLD', 'CONFIRMED']

async function loadHours(organizationId: string): Promise<RepHours> {
  const rows = await db.callCenterRepHours.findMany({ where: { organizationId } })
  const out: RepHours = {}
  for (const r of rows) (out[r.repKey] ??= {})[r.weekday] = { startMinute: r.startMinute, endMinute: r.endMinute, active: r.active }
  return out
}

async function loadBusy(organizationId: string, from: Date, to: Date): Promise<BusySlot[]> {
  return db.callCenterSlot.findMany({
    where: { organizationId, status: { in: ACTIVE }, startsAt: { gte: from, lte: to } },
    select: { repKey: true, startsAt: true },
  })
}

async function leadSkip(organizationId: string, leadId: string): Promise<{ skip: string | null; language: 'EN' | 'ES' }> {
  const lead = await db.callCenterLead.findFirst({
    where: { id: leadId, organizationId },
    select: { outOfArea: true, doNotCallAt: true, consentRevokedAt: true, phoneHash: true, language: true },
  })
  if (!lead) return { skip: 'not_found', language: 'EN' }
  const suppressed = lead.phoneHash
    ? Boolean(
        await db.callCenterSuppression.findFirst({
          where: { organizationId, numberHash: lead.phoneHash, removedAt: null, OR: [{ callBlockedAt: { not: null } }, { smsBlockedAt: { not: null } }] },
          select: { id: true },
        }),
      )
    : false
  return { skip: bookingSkipReason({ ...lead, suppressed }), language: lead.language }
}

export async function listOpenSlots(organizationId: string, now = new Date()) {
  const reps = calendarReps().map((r) => r.key)
  const busy = await loadBusy(organizationId, new Date(now.getTime() - REP_GAP_MINUTES * MIN), new Date(now.getTime() + (MAX_DAYS_AHEAD + 1) * 86_400_000))
  return openSlots({ reps, now, busy, hours: await loadHours(organizationId) })
}

export async function listCalendarSlots(organizationId: string, now = new Date()) {
  return db.callCenterSlot.findMany({
    where: { organizationId, startsAt: { gte: new Date(now.getTime() - 86_400_000) } },
    orderBy: { startsAt: 'asc' },
    select: { id: true, leadId: true, repKey: true, startsAt: true, endsAt: true, status: true },
    take: 200,
  })
}

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0]

type HoldInput = {
  organizationId: string
  leadId: string
  repKey: string
  startsAt: Date
  heldBy?: 'rep' | 'autobook'
  now?: Date
}

/** The hold itself, inside the caller's transaction: rep gap check, then the row and its trail line. */
async function holdWithin(
  tx: Tx,
  input: HoldInput,
  language: 'EN' | 'ES',
  now: Date,
): Promise<{ ok: true; slotId: string } | { ok: false; reason: string }> {
  const busy = await tx.callCenterSlot.findMany({
    where: {
      organizationId: input.organizationId,
      repKey: input.repKey,
      status: { in: ACTIVE },
      startsAt: { gt: new Date(input.startsAt.getTime() - REP_GAP_MINUTES * MIN), lt: new Date(input.startsAt.getTime() + REP_GAP_MINUTES * MIN) },
    },
    select: { repKey: true, startsAt: true },
  })
  const problem = slotProblem({ repKey: input.repKey, startsAt: input.startsAt, now, busy, hours: await loadHours(input.organizationId) })
  if (problem) return { ok: false, reason: problem }
  const slot = await tx.callCenterSlot.create({
    data: {
      organizationId: input.organizationId,
      leadId: input.leadId,
      repKey: input.repKey,
      startsAt: input.startsAt,
      endsAt: new Date(input.startsAt.getTime() + VISIT_MINUTES * MIN),
      status: 'HOLD',
      language,
      heldBy: input.heldBy ?? 'rep',
    },
    select: { id: true },
  })
  await tx.callCenterEvent.create({ data: { leadId: input.leadId, type: 'NOTE', body: `Calendar hold placed (${input.repKey})` } })
  return { ok: true, slotId: slot.id }
}

/** Place a HOLD. Never confirms. */
export async function holdSlot(input: HoldInput): Promise<{ ok: true; slotId: string } | { ok: false; reason: string }> {
  const now = input.now ?? new Date()
  if (!calendarReps().some((r) => r.key === input.repKey)) return { ok: false, reason: 'unknown rep' }
  const { skip, language } = await leadSkip(input.organizationId, input.leadId)
  if (skip) return { ok: false, reason: skip }
  return db.$transaction((tx) => holdWithin(tx, input, language, now))
}

/** The rep confirms the HOLD while on the call. Reuses the lead's BOOKED status. */
export async function confirmSlot(input: { organizationId: string; slotId: string; userId: string }) {
  const slot = await db.callCenterSlot.findFirst({ where: { id: input.slotId, organizationId: input.organizationId } })
  if (!slot || !canConfirm(slot.status as SlotStatus, 'rep')) return { ok: false as const, reason: 'not a hold' }
  await db.$transaction([
    db.callCenterSlot.update({ where: { id: slot.id }, data: { status: 'CONFIRMED', confirmedAt: new Date(), confirmedById: input.userId } }),
    db.callCenterLead.update({ where: { id: slot.leadId }, data: { status: 'BOOKED', nextAttemptAt: null } }),
    db.callCenterEvent.create({ data: { leadId: slot.leadId, type: 'OUTCOME', body: 'Calendar visit confirmed on the call' } }),
  ])
  return { ok: true as const }
}

export async function recordSlotOutcome(input: { organizationId: string; slotId: string; outcome: CalendarOutcome; now?: Date }) {
  const now = input.now ?? new Date()
  const slot = await db.callCenterSlot.findFirst({ where: { id: input.slotId, organizationId: input.organizationId } })
  if (!slot) return { ok: false as const, reason: 'not found' }
  const plan = planOutcome(slot.status as SlotStatus, input.outcome, now)
  if ('error' in plan) return { ok: false as const, reason: plan.error }
  await db.$transaction(async (tx) => {
    await tx.callCenterSlot.update({ where: { id: slot.id }, data: { status: plan.status, outcomeAt: now } })
    await tx.callCenterEvent.create({ data: { leadId: slot.leadId, type: 'OUTCOME', body: `Calendar visit: ${input.outcome}` } })
    if (plan.callbackAt) {
      // The call-back task: the lead returns to the desk queue 2h later.
      await tx.callCenterLead.update({ where: { id: slot.leadId }, data: { status: 'WAITING', nextAttemptAt: plan.callbackAt } })
      await tx.callCenterEvent.create({ data: { leadId: slot.leadId, type: 'NOTE', body: `Call back due ${plan.callbackAt.toISOString()}` } })
    } else if (plan.releasesLead) {
      const other = await tx.callCenterSlot.count({ where: { leadId: slot.leadId, id: { not: slot.id }, status: 'CONFIRMED' } })
      if (!other) await tx.callCenterLead.update({ where: { id: slot.leadId }, data: { status: 'WAITING' } })
    }
  })
  return { ok: true as const }
}

/** A refusal inside a transaction: thrown to roll it back, returned as a reason. */
class Refused extends Error {}

/**
 * Move a visit: RESCHEDULED on the old slot and a HOLD for the new time, in
 * one transaction, linked through `rescheduledToId`. The old slot stops
 * counting as busy before the gap check, so a rep's visit can move by 30
 * minutes. The new time passes every rule a fresh hold does.
 */
export async function rescheduleSlot(input: {
  organizationId: string
  slotId: string
  repKey: string
  startsAt: Date
  userId: string
  now?: Date
}): Promise<{ ok: true; slotId: string } | { ok: false; reason: string }> {
  const now = input.now ?? new Date()
  if (!calendarReps().some((r) => r.key === input.repKey)) return { ok: false, reason: 'unknown rep' }
  const old = await db.callCenterSlot.findFirst({ where: { id: input.slotId, organizationId: input.organizationId } })
  if (!old) return { ok: false, reason: 'not found' }
  const plan = planOutcome(old.status as SlotStatus, 'rescheduled', now)
  if ('error' in plan) return { ok: false, reason: plan.error }
  const { skip, language } = await leadSkip(input.organizationId, old.leadId)
  if (skip) return { ok: false, reason: skip }
  try {
    return await db.$transaction(async (tx) => {
      const moved = await tx.callCenterSlot.updateMany({
        where: { id: old.id, status: old.status },
        data: { status: plan.status, outcomeAt: now },
      })
      if (moved.count !== 1) throw new Refused('visit changed')
      const held = await holdWithin(
        tx,
        { organizationId: input.organizationId, leadId: old.leadId, repKey: input.repKey, startsAt: input.startsAt, heldBy: 'rep' },
        language,
        now,
      )
      if (!held.ok) throw new Refused(held.reason)
      await tx.callCenterSlot.update({ where: { id: old.id }, data: { rescheduledToId: held.slotId } })
      await tx.callCenterEvent.create({ data: { leadId: old.leadId, type: 'OUTCOME', body: 'Calendar visit: rescheduled' } })
      // Same rule as recordSlotOutcome: the new time is a hold, so the lead is
      // BOOKED again only once the rep confirms it on the call.
      const other = await tx.callCenterSlot.count({ where: { leadId: old.leadId, id: { not: old.id }, status: 'CONFIRMED' } })
      if (!other) await tx.callCenterLead.update({ where: { id: old.leadId }, data: { status: 'WAITING' } })
      return { ok: true as const, slotId: held.slotId }
    })
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message }
    throw err
  }
}

// ── Planner reads (docs/CALENDAR.md §4) ──────────────────────────────────────

const LEAD_FIELDS = {
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
} satisfies Prisma.CallCenterLeadSelect

type LeadRow = Prisma.CallCenterLeadGetPayload<{ select: typeof LEAD_FIELDS }>

/** The calendar's own trail lines are not the lead's note. */
const SYSTEM_NOTE = /^(Calendar |Call back due )/

/** Name, last four and last note the way the desk builds them (from-rows). */
function leadFacts(row: LeadRow): { name: string; last4: string | null; note: string | null; contacted: boolean } {
  const lead = callLeadFromRow(row)
  const note = [...lead.trail].reverse().find((event) => event.kind === 'note' && !SYSTEM_NOTE.test(event.detail))
  return { name: lead.name, last4: lead.last4, note: note?.detail.slice(0, 280) ?? null, contacted: lead.contacted }
}

export type CalendarVisit = {
  id: string
  leadId: string
  repKey: string
  startsAt: Date
  endsAt: Date
  status: SlotStatus
  outcomeAt: Date | null
  rescheduledToId: string | null
  language: 'EN' | 'ES'
  name: string
  last4: string | null
  note: string | null
}

/**
 * Visits starting in [from, to), oldest first, with the lead's name, last four
 * and last note. Rescheduled / cancelled visits stay listed for a day after
 * the change, then drop off the grid.
 */
export async function listSlotsBetween(
  organizationId: string,
  from: Date,
  to: Date,
  opts: { repKey?: string | null; now?: Date } = {},
): Promise<CalendarVisit[]> {
  const now = opts.now ?? new Date()
  const rows = await db.callCenterSlot.findMany({
    where: { organizationId, startsAt: { gte: from, lt: to }, ...(opts.repKey ? { repKey: opts.repKey } : {}) },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: 500,
    select: {
      id: true,
      leadId: true,
      repKey: true,
      startsAt: true,
      endsAt: true,
      status: true,
      outcomeAt: true,
      rescheduledToId: true,
      language: true,
      lead: { select: LEAD_FIELDS },
    },
  })
  return rows
    .filter((row) => visibleOnGrid(row.status as SlotStatus, row.outcomeAt, now))
    .map(({ lead, ...slot }) => {
      const facts = leadFacts(lead)
      return { ...slot, status: slot.status as SlotStatus, name: facts.name, last4: facts.last4, note: facts.note }
    })
}

export type RailLead = { id: string; name: string; last4: string | null; language: 'EN' | 'ES'; at: Date; contacted: boolean }

/**
 * Leads still to book, newest first: open on the desk (not booked), callable,
 * and with no HOLD or CONFIRMED visit. Leads the calendar would refuse
 * (out of state, do-not-call, opted out) are left out.
 */
export async function listToSchedule(organizationId: string, take = 50): Promise<RailLead[]> {
  const rows = await db.callCenterLead.findMany({
    where: {
      organizationId,
      status: { in: ['WAITING', 'INBOUND', 'MISSED'] },
      doNotCallAt: null,
      consentRevokedAt: null,
      outOfArea: false,
      calendarSlots: { none: { status: { in: ACTIVE } } },
    },
    orderBy: { createdAt: 'desc' },
    take,
    select: LEAD_FIELDS,
  })
  return rows.map((row) => {
    const facts = leadFacts(row)
    return { id: row.id, name: facts.name, last4: facts.last4, language: row.language, at: row.createdAt, contacted: facts.contacted }
  })
}

/** Leads with a next try in the next 24 hours, soonest first. */
export async function listFollowUps(organizationId: string, now = new Date(), take = 50): Promise<RailLead[]> {
  const rows = await db.callCenterLead.findMany({
    where: { organizationId, doNotCallAt: null, nextAttemptAt: { gte: now, lte: new Date(now.getTime() + 24 * 3_600_000) } },
    orderBy: { nextAttemptAt: 'asc' },
    take,
    select: LEAD_FIELDS,
  })
  return rows.map((row) => {
    const facts = leadFacts(row)
    return { id: row.id, name: facts.name, last4: facts.last4, language: row.language, at: row.nextAttemptAt ?? row.createdAt, contacted: facts.contacted }
  })
}

/** What the scheduler needs to show the same answers `holdSlot` will give. */
export async function schedulerInputs(organizationId: string, now = new Date()): Promise<{ busy: BusySlot[]; hours: RepHours }> {
  const [busy, hours] = await Promise.all([
    loadBusy(organizationId, new Date(now.getTime() - REP_GAP_MINUTES * MIN), new Date(now.getTime() + (MAX_DAYS_AHEAD + 2) * 86_400_000)),
    loadHours(organizationId),
  ])
  return { busy, hours }
}

/**
 * Autobook: for a brand-new lead, place a HOLD on the first open slot.
 * Never throws: lead creation must not break if booking fails.
 */
export async function tryAutobookHold(organizationId: string, leadId: string): Promise<void> {
  if (!autobookEnabled()) return
  try {
    const first = (await listOpenSlots(organizationId))[0]
    if (!first) return
    const res = await holdSlot({ organizationId, leadId, repKey: first.repKey, startsAt: first.startsAt, heldBy: 'autobook' })
    if (!res.ok) console.warn('[call-center-calendar] autobook skipped', { leadId, reason: res.reason })
  } catch (err) {
    console.error('[call-center-calendar] autobook failed', { leadId, error: err instanceof Error ? err.message : String(err) })
  }
}

function repEmail(repKey: string): string | null {
  for (const part of (process.env.CALL_CENTER_CALENDAR_REP_EMAILS ?? '').split(',')) {
    const [k, v] = part.split(':').map((s) => s?.trim())
    if (k?.toLowerCase() === repKey && v) return v
  }
  return null
}

/** Queued reminder job. Runs from /api/jobs/run when the calendar is on. */
export async function runCalendarReminders(now = new Date()): Promise<{ sent: number; failed: number }> {
  const slots = await db.callCenterSlot.findMany({
    where: { status: { in: ACTIVE }, startsAt: { gt: now, lte: new Date(now.getTime() + 24 * 3_600_000) } },
    include: { lead: { select: { emailSecret: true, phoneSecret: true, timeZone: true, leadAttribution: true, outOfArea: true } } },
    take: 200,
  })
  const byId = new Map(slots.map((s) => [s.id, s]))
  const totals = { sent: 0, failed: 0 }
  const reps = new Map(calendarReps().map((r) => [r.key, r.label]))
  for (const job of dueReminders(slots, now)) {
    const slot = byId.get(job.slotId)!
    try {
      const msg = reminderMessage(job, slot, reps.get(slot.repKey) ?? slot.repKey, slot.leadId)
      const result = await deliver(job, slot.organizationId, msg, slot.repKey, { id: slot.leadId, ...slot.lead }, now)
      if (result === 'SENT') {
        await db.callCenterSlot.update({ where: { id: slot.id }, data: { [job.kind]: now } })
        totals.sent += 1
      } else {
        await db.callCenterSlot.update({ where: { id: slot.id }, data: { reminderError: `${job.kind}: ${result}` } })
        totals.failed += 1
      }
    } catch (err) {
      totals.failed += 1
      console.error('[call-center-calendar] reminder failed', { slotId: slot.id, kind: job.kind, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return totals
}

type ReminderLead = {
  id: string
  emailSecret: unknown
  phoneSecret: unknown
  timeZone: string | null
  leadAttribution: unknown
  outOfArea: boolean
}

function attributionState(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const state = (raw as { state?: unknown }).state
  return typeof state === 'string' ? state : null
}

async function deliver(
  job: ReminderJob,
  organizationId: string,
  msg: { subject: string; body: string },
  repKey: string,
  lead: ReminderLead,
  now: Date,
): Promise<string> {
  if (job.to === 'rep') {
    const to = repEmail(repKey)
    if (!to) return 'no rep email'
    return (await getEmailProvider().send({ to, subject: msg.subject, body: msg.body, organizationId })).status
  }
  if (job.channel === 'SMS') {
    const to = readSecret(lead.phoneSecret)
    if (!to) return 'no phone'
    // Same gate as every other text: consent, STOP, suppression, do-not-call, quiet hours.
    const decision = await decideOutbound(
      {
        organizationId,
        channel: 'SMS',
        purpose: 'servicing',
        phone: to,
        leadId: lead.id,
        automated: true,
        zoneHints: { leadZone: lead.timeZone, states: [attributionState(lead.leadAttribution)], e164: toE164(to), outOfArea: lead.outOfArea },
      },
      { now },
    )
    if (!decision.allowed) return `blocked ${decision.code}`
    return (await getSmsProvider().send({ to: decision.e164, body: msg.body, organizationId })).status
  }
  const to = readSecret(lead.emailSecret)
  if (!to) return 'no email'
  return (await getEmailProvider().send({ to, subject: msg.subject, body: msg.body, organizationId })).status
}
