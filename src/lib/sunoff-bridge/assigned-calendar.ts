import 'server-only'
import { db } from '@/lib/db'
import type { SessionUser } from '@/lib/rbac'
import { civilDate, timeLabel, type DeskChip } from '@/lib/daily-desk'
import { callLeadFromRow } from '@/lib/call-center/from-rows'
import { sunoffActive } from './assigned-model'

export async function assignedCalendarChips(user: SessionUser, from: Date, to: Date, zone: string) {
  const rows = await db.callCenterSlot.findMany({
    where: { organizationId: user.organizationId, heldBy: 'sunoff', status: { in: ['HOLD', 'CONFIRMED'] }, startsAt: { gte: from, lt: to },
      lead: { pageId: 'sunoff', ...(user.role === 'SUPER_ADMIN' ? {} : { lockedBy: user.id }) } },
    include: { lead: { include: { events: { orderBy: { createdAt: 'asc' } } } } },
  })
  return rows.filter(s => sunoffActive(s.lead.leadAttribution)).map(s => {
    const lead = callLeadFromRow(s.lead), [firstName, ...rest] = lead.name.split(' ')
    const chip: DeskChip = { appointmentId: s.id, startsAt: s.startsAt.toISOString(), updatedAt: s.updatedAt.toISOString(), status: 'SCHEDULED',
      clientId: `sunoff-desk:${s.leadId}`, firstName, lastName: rest.join(' '), timeLabel: timeLabel(s.startsAt, zone),
      ownerName: s.repKey === 'gatsby' ? 'Gatsby' : 'Dakota', missingDocs: 0, email: '', phone: '',
      sourceBrand: 'SunOff', sourceLeadId: s.leadId }
    return { day: civilDate(s.startsAt, zone), chip }
  })
}
