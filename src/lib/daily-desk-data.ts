import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { matchDocKind } from '@/lib/daily-desk-docs'
import { can, clientScope, type SessionUser } from '@/lib/rbac'
import { DESK_TIMEZONE, civilDate, monthGrid, monthTitle, parseMonth, timeLabel, zonedDate, type DeskBoard, type DeskChip } from '@/lib/daily-desk'

export function canReadDesk(user: SessionUser): boolean {
  return can(user, 'appointments:read')
}

export async function loadDeskBoard(user: SessionUser, monthRaw?: string): Promise<DeskBoard> {
  const organization = await db.organization.findUnique({ where: { id: user.organizationId }, select: { timezone: true } })
  const timezone = organization?.timezone || DESK_TIMEZONE
  const now = new Date()
  const today = civilDate(now, timezone)
  const { year, monthIndex, key } = parseMonth(monthRaw || today.slice(0, 7))
  const cells = monthGrid(year, monthIndex)
  const rangeStart = zonedDate(cells[0]!.iso, '00:00', timezone)
  const lastDay = new Date(`${cells.at(-1)!.iso}T12:00:00Z`)
  lastDay.setUTCDate(lastDay.getUTCDate() + 1)
  const rangeEnd = zonedDate(lastDay.toISOString().slice(0, 10), '00:00', timezone)
  const scope = clientScope(user)
  const canAssign = user.role === 'SUPER_ADMIN'
  const clientSelect = {
    id: true, firstName: true, lastName: true, email: true, phone: true,
    owner: { select: { name: true } },
    documents: { where: { status: { notIn: ['REJECTED', 'EXPIRED'] }, NOT: { storageKey: null } }, select: { requirement: { select: { key: true } } } },
  } satisfies Prisma.ClientSelect
  const [requirements, closers, appointments, unscheduledRows, unassignedCount] = await Promise.all([
    db.documentRequirement.findMany({ where: { isRequired: true, package: { organizationId: user.organizationId, isDefault: true } }, select: { key: true } }),
    canAssign ? db.user.findMany({ where: { organizationId: user.organizationId, role: { key: 'CLOSER' }, deletedAt: null, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : Promise.resolve([]),
    db.appointment.findMany({
      where: { client: scope, startsAt: { gte: rangeStart, lt: rangeEnd }, ...(user.role === 'CLOSER' ? { ownerId: user.id } : {}) },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: { id: true, startsAt: true, status: true, owner: { select: { name: true } }, client: { select: clientSelect } },
    }),
    db.client.findMany({
      where: { AND: [scope, { status: 'ACTIVE', appointments: { none: { status: { in: ['SCHEDULED', 'CONFIRMED'] }, startsAt: { gte: now } } } }] },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'asc' }], select: clientSelect,
    }),
    canAssign ? db.client.count({ where: { AND: [scope, { ownerId: null, status: 'ACTIVE' }] } }) : Promise.resolve(0),
  ])
  const canonicalKey = (key: string) => matchDocKind(key)?.key ?? key
  const requiredKeys = new Set(requirements.map(requirement => canonicalKey(requirement.key)))
  const lead = (row: (typeof unscheduledRows)[number]) => ({
    clientId: row.id, firstName: row.firstName, lastName: row.lastName, email: row.email, phone: row.phone,
    ownerName: row.owner?.name ?? null,
    missingDocs: Math.max(0, requiredKeys.size - new Set(row.documents.map(doc => doc.requirement?.key ? canonicalKey(doc.requirement.key) : null).filter((key): key is string => Boolean(key && requiredKeys.has(key)))).size),
  })
  const chipsByDay = new Map<string, DeskChip[]>()
  for (const appointment of appointments) {
    const day = civilDate(appointment.startsAt, timezone)
    const chip: DeskChip = { ...lead(appointment.client), appointmentId: appointment.id, status: appointment.status,
      ownerName: appointment.owner?.name ?? null, timeLabel: timeLabel(appointment.startsAt, timezone), startsAt: appointment.startsAt.toISOString() }
    chipsByDay.set(day, [...(chipsByDay.get(day) ?? []), chip])
  }
  return {
    month: key, title: monthTitle(year, monthIndex), timezone, today,
    days: cells.map((cell) => ({ ...cell, isToday: cell.iso === today, chips: chipsByDay.get(cell.iso) ?? [] })),
    unscheduled: unscheduledRows.map(lead), closers, unassignedCount, canAssign, canBook: can(user, 'appointments:manage'),
  }
}
