'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/rbac'
import { writeAssignedCalendar } from '@/lib/sunoff-bridge/assigned-calendar-write'
import { leadIdParam } from '../lead-link'
import { calendarEnabled, calendarReps, repColor } from './config'
import { isOutcome } from './outcomes'
import type { SchedulerData } from './planner'
import { confirmSlot, holdSlot, recordSlotOutcome, rescheduleSlot, schedulerInputs } from './service'

/** Every calendar action answers with a result the UI can show. */
export type CalendarResult = { ok: true; slotId?: string } | { ok: false; reason: string }

const SLOT_ID = /^(?:[A-Za-z0-9_-]{1,64}|sunoff:[A-Za-z0-9:_-]{1,260}:visit)$/

async function actor() {
  if (!calendarEnabled()) return null
  return requireUser()
}

function when(iso: unknown): Date | null {
  if (typeof iso !== 'string' || iso.length > 40) return null
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : at
}

function rep(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/.test(value) ? value : null
}

const OFF: CalendarResult = { ok: false, reason: 'The Call Center Calendar is off.' }

/**
 * Place a hold. With `confirm` (the scheduler's "Hold and confirm", offered only
 * while the rep is on a call with that lead) the hold is confirmed right after.
 */
export async function holdCalendarSlot(input: { leadId: string; repKey: string; startsAt: string; confirm?: boolean }): Promise<CalendarResult> {
  const user = await actor()
  if (!user) return OFF
  const leadId = leadIdParam(input?.leadId)
  const repKey = rep(input?.repKey)
  const startsAt = when(input?.startsAt)
  if (!leadId || !repKey || !startsAt) return { ok: false, reason: 'Pick a rep and a time.' }
  const external = await writeAssignedCalendar(user, { leadId }, { type: 'booking', at: startsAt.getTime(), confirm: input.confirm === true }, repKey)
  if (external) { revalidatePath('/call-center'); revalidatePath('/board'); return external }
  const held = await holdSlot({ organizationId: user.organizationId, leadId, repKey, startsAt, heldBy: 'rep' })
  if (!held.ok) {
    console.warn('[call-center-calendar] hold refused', { reason: held.reason })
    return held
  }
  if (input.confirm) {
    const confirmed = await confirmSlot({ organizationId: user.organizationId, slotId: held.slotId, userId: user.id })
    revalidatePath('/call-center')
    if (!confirmed.ok) return { ok: false, reason: `Hold placed, but not confirmed: ${confirmed.reason}` }
    return { ok: true, slotId: held.slotId }
  }
  revalidatePath('/call-center')
  return { ok: true, slotId: held.slotId }
}

export async function confirmCalendarSlot(slotId: string): Promise<CalendarResult> {
  const user = await actor()
  if (!user) return OFF
  if (typeof slotId !== 'string' || !SLOT_ID.test(slotId)) return { ok: false, reason: 'not found' }
  const external = await writeAssignedCalendar(user, { slotId }, { type: 'confirm' })
  if (external) { revalidatePath('/call-center'); revalidatePath('/board'); return external }
  const res = await confirmSlot({ organizationId: user.organizationId, slotId, userId: user.id })
  revalidatePath('/call-center')
  return res
}

export async function saveCalendarOutcome(slotId: string, outcome: string): Promise<CalendarResult> {
  const user = await actor()
  if (!user) return OFF
  if (typeof slotId !== 'string' || !SLOT_ID.test(slotId)) return { ok: false, reason: 'not found' }
  if (typeof outcome !== 'string' || !isOutcome(outcome)) return { ok: false, reason: 'Pick a result.' }
  const external = await writeAssignedCalendar(user, { slotId }, { type: 'visit', outcome })
  if (external) { revalidatePath('/call-center'); revalidatePath('/board'); return external }
  const res = await recordSlotOutcome({ organizationId: user.organizationId, slotId, outcome })
  revalidatePath('/call-center')
  return res
}

export async function rescheduleCalendarSlot(input: { slotId: string; repKey: string; startsAt: string }): Promise<CalendarResult> {
  const user = await actor()
  if (!user) return OFF
  const repKey = rep(input?.repKey)
  const startsAt = when(input?.startsAt)
  if (typeof input?.slotId !== 'string' || !SLOT_ID.test(input.slotId)) return { ok: false, reason: 'not found' }
  if (!repKey || !startsAt) return { ok: false, reason: 'Pick a rep and a time.' }
  const external = await writeAssignedCalendar(user, { slotId: input.slotId }, { type: 'booking', at: startsAt.getTime() }, repKey)
  if (external) { revalidatePath('/call-center'); revalidatePath('/board'); return external }
  const res = await rescheduleSlot({ organizationId: user.organizationId, slotId: input.slotId, repKey, startsAt, userId: user.id })
  revalidatePath('/call-center')
  return res
}

/** The scheduler's data when it opens outside the Calendar tab (the lead's Book visit). */
export async function loadCalendarScheduler(): Promise<SchedulerData | null> {
  const user = await actor()
  if (!user) return null
  const now = new Date()
  const reps = calendarReps()
  const { busy, hours } = await schedulerInputs(user.organizationId, now)
  return {
    now: now.toISOString(),
    reps: reps.map((r) => ({ key: r.key, label: r.label, color: repColor(r.key, reps) })),
    busy: busy.map((b) => ({ repKey: b.repKey, startsAt: b.startsAt.toISOString() })),
    hours,
  }
}
