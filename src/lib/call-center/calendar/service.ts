import 'server-only'
import { db } from '@/lib/db'
import { getEmailProvider, getSmsProvider } from '@/lib/messaging'
import { readSecret } from '../contact'
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
  for (const r of rows) (out[r.repKey] ??= {})[r.weekday] = r
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

/** Place a HOLD. Never confirms. */
export async function holdSlot(input: {
  organizationId: string
  leadId: string
  repKey: string
  startsAt: Date
  heldBy?: 'rep' | 'autobook'
  now?: Date
}): Promise<{ ok: true; slotId: string } | { ok: false; reason: string }> {
  const now = input.now ?? new Date()
  if (!calendarReps().some((r) => r.key === input.repKey)) return { ok: false, reason: 'unknown rep' }
  const { skip, language } = await leadSkip(input.organizationId, input.leadId)
  if (skip) return { ok: false, reason: skip }
  return db.$transaction(async (tx) => {
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
    if (problem) return { ok: false as const, reason: problem }
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
    return { ok: true as const, slotId: slot.id }
  })
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
    include: { lead: { select: { emailSecret: true, phoneSecret: true } } },
    take: 200,
  })
  const byId = new Map(slots.map((s) => [s.id, s]))
  const totals = { sent: 0, failed: 0 }
  const reps = new Map(calendarReps().map((r) => [r.key, r.label]))
  for (const job of dueReminders(slots, now)) {
    const slot = byId.get(job.slotId)!
    try {
      const msg = reminderMessage(job, slot, reps.get(slot.repKey) ?? slot.repKey, slot.leadId)
      const result = await deliver(job, slot.organizationId, msg, slot.repKey, slot.lead)
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

async function deliver(
  job: ReminderJob,
  organizationId: string,
  msg: { subject: string; body: string },
  repKey: string,
  lead: { emailSecret: unknown; phoneSecret: unknown },
): Promise<string> {
  if (job.to === 'rep') {
    const to = repEmail(repKey)
    if (!to) return 'no rep email'
    return (await getEmailProvider().send({ to, subject: msg.subject, body: msg.body, organizationId })).status
  }
  if (job.channel === 'SMS') {
    const to = readSecret(lead.phoneSecret)
    if (!to) return 'no phone'
    return (await getSmsProvider().send({ to, body: msg.body, organizationId })).status
  }
  const to = readSecret(lead.emailSecret)
  if (!to) return 'no email'
  return (await getEmailProvider().send({ to, subject: msg.subject, body: msg.body, organizationId })).status
}
