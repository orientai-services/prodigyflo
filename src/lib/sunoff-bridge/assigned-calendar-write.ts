import 'server-only'
import { db } from '@/lib/db'
import type { SessionUser } from '@/lib/rbac'
import { sourceMeta, SUNOFF_PARTNERS } from './assigned-model'
import { writeAssignedLead, type AssignedChange, type AssignedWriteResult } from './assigned-write'
import { schedulerInputs } from '@/lib/call-center/calendar/service'
import { slotProblem } from '@/lib/call-center/calendar/slots'
import { planOutcome, canConfirm, type SlotStatus } from '@/lib/call-center/calendar/outcomes'
import { bookingSkipReason } from '@/lib/call-center/calendar/eligibility'

/** null means native ProdigyFlo lead/visit: leave its established service untouched. */
export async function writeAssignedCalendar(user: SessionUser, target: { leadId: string } | { slotId: string }, change: AssignedChange,
  repKey?: string): Promise<(AssignedWriteResult & { slotId?: string }) | null> {
  const slot = 'slotId' in target ? await db.callCenterSlot.findFirst({ where: { id: target.slotId, organizationId: user.organizationId } }) : null
  const leadId = 'leadId' in target ? target.leadId : slot?.leadId
  if (!leadId) return 'slotId' in target && target.slotId.startsWith('sunoff:') ? { ok: false, reason: 'not found' } : null
  const row = await db.callCenterLead.findFirst({ where: { id: leadId, organizationId: user.organizationId } })
  const m = sourceMeta(row?.leadAttribution)
  if (!row || !m) return null
  const suppressed = row.phoneHash ? await db.callCenterSuppression.findFirst({ where: { organizationId: user.organizationId,
    numberHash: row.phoneHash, removedAt: null, OR: [{ callBlockedAt: { not: null } }, { smsBlockedAt: { not: null } }] } }) : null
  const skipped = bookingSkipReason({ ...row, suppressed: !!suppressed })
  if (skipped) return { ok: false, reason: skipped }
  const partner = SUNOFF_PARTNERS[String(m.userId) as keyof typeof SUNOFF_PARTNERS]
  if (!partner) return { ok: false, reason: 'not found' }
  const slotId = `sunoff:${user.organizationId}:${m.id}:visit`
  if (change.type === 'booking') {
    if (repKey !== partner.key) return { ok: false, reason: 'Keep the assigned SunOff rep for this visit. Change the lead assignment in SunOff first.' }
    const now = new Date(), startsAt = new Date(change.at)
    const [{ hours }, busy] = await Promise.all([schedulerInputs(user.organizationId, now),
      db.callCenterSlot.findMany({ where: { organizationId: user.organizationId, id: { not: slotId }, status: { in: ['HOLD','CONFIRMED'] } }, select: { repKey: true, startsAt: true } })])
    const problem = slotProblem({ repKey: partner.key, startsAt, now, busy, hours })
    if (problem) return { ok: false, reason: problem }
  }
  if (change.type === 'confirm' && (!slot || !canConfirm(slot.status as SlotStatus, 'rep'))) return { ok: false, reason: 'not a hold' }
  if (change.type === 'visit') {
    if (!slot) return { ok: false, reason: 'not found' }
    const plan = planOutcome(slot.status as SlotStatus, change.outcome, new Date())
    if ('error' in plan) return { ok: false, reason: plan.error }
  }
  const result = await writeAssignedLead(user.organizationId, { id: user.id, name: user.name, role: user.role }, leadId, change)
  return result.ok ? { ok: true, slotId } : result
}
