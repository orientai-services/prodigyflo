import 'server-only'
import { AppointmentStatus, DocumentStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { can, clientScope, type SessionUser } from '@/lib/rbac'
import { deskVisibleClientWhere } from '@/lib/intake/scs-desk'
import {
  DESK_TIMEZONE,
  civilDate,
  monthGrid,
  monthTitle,
  parseMonth,
  timeLabel,
  type DeskBoard,
  type DeskChip,
  type DeskLead,
} from '@/lib/daily-desk'

const LIVE_APPOINTMENTS: AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED']

/** A file is "on the desk" once bytes landed, even if review is still open. */
const ON_FILE: DocumentStatus[] = [
  'RECEIVED',
  'PROCESSING',
  'UNDER_REVIEW',
  'MISSING_INFORMATION',
  'APPROVED',
]

const CLIENT_READ = [
  'clients:read_assigned',
  'clients:read_team',
  'clients:read_region',
  'clients:read_all',
] as const

export function canReadDesk(user: SessionUser): boolean {
  return CLIENT_READ.some((p) => user.permissions.has(p))
}

export async function loadDeskBoard(user: SessionUser, monthRaw?: string): Promise<DeskBoard> {
  const { year, monthIndex, key } = parseMonth(monthRaw)
  const cells = monthGrid(year, monthIndex)
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: DESK_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

  const rangeStart = new Date(`${cells[0]!.iso}T00:00:00.000Z`)
  const last = cells.at(-1)!.iso
  const rangeEnd = new Date(`${last}T23:59:59.999Z`)
  // Civil dates are interpreted in the desk zone when chips are placed; the
  // UTC window above is a wide net so a late-evening PT appointment still lands.

  const [requiredCount, closers, rows] = await Promise.all([
    countRequiredDocs(user.organizationId),
    db.user.findMany({
      where: { organizationId: user.organizationId, role: { key: 'CLOSER' }, deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.client.findMany({
      where: { AND: [clientScope(user), deskVisibleClientWhere(), { status: 'ACTIVE', deletedAt: null }] },
      orderBy: { lastActivityAt: 'desc' },
      take: 600,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        ownerId: true,
        owner: { select: { name: true } },
        appointments: {
          where: {
            status: { in: LIVE_APPOINTMENTS },
            startsAt: { gte: rangeStart, lte: rangeEnd },
          },
          orderBy: { startsAt: 'asc' },
          select: { startsAt: true, timezone: true },
        },
        documents: {
          where: {
            requirement: { isRequired: true },
            status: { in: ON_FILE },
            NOT: { storageKey: null },
          },
          select: { requirementId: true },
        },
      },
    }),
  ])

  const chipsByDay = new Map<string, DeskChip[]>()
  const unscheduled: DeskLead[] = []
  let unassignedCount = 0

  for (const row of rows) {
    if (!row.ownerId) unassignedCount += 1
    const present = new Set(row.documents.map((d) => d.requirementId).filter(Boolean)).size
    const missingDocs = Math.max(0, requiredCount - present)
    const base = {
      clientId: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      ownerName: row.owner?.name ?? null,
      missingDocs,
      email: row.email,
      phone: row.phone,
    }

    if (row.appointments.length === 0) {
      unscheduled.push(base)
      continue
    }

    for (const appt of row.appointments) {
      const tz = appt.timezone || DESK_TIMEZONE
      const iso = civilDate(appt.startsAt, tz)
      const chip: DeskChip = {
        ...base,
        timeLabel: timeLabel(appt.startsAt, tz),
      }
      const list = chipsByDay.get(iso) ?? []
      list.push(chip)
      chipsByDay.set(iso, list)
    }
  }

  return {
    month: key,
    title: monthTitle(year, monthIndex),
    today,
    days: cells.map((cell) => ({
      ...cell,
      isToday: cell.iso === today,
      chips: chipsByDay.get(cell.iso) ?? [],
    })),
    unscheduled,
    closers,
    unassignedCount,
    canAssign: can(user, 'clients:reassign'),
    canBook: can(user, 'appointments:manage'),
  }
}

async function countRequiredDocs(organizationId: string): Promise<number> {
  const n = await db.documentRequirement.count({
    where: { isRequired: true, package: { organizationId, isDefault: true } },
  })
  return n > 0 ? n : 12
}
