import 'server-only'
import { AppointmentStatus, AppointmentType, type IntakeSource, type Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export type IntakeBooking = {
  startsAt: Date
  endsAt: Date
  timezone: string
  externalEventId: string | null
  meetingUrl: string | null
}

/** Pull a booking window from an SCS (or other) inbound packet. Missing time → null. */
export function parseIntakeBooking(raw: unknown): IntakeBooking | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const packet = raw as Record<string, unknown>
  const data = packet.data && typeof packet.data === 'object' && !Array.isArray(packet.data)
    ? (packet.data as Record<string, unknown>)
    : {}
  const booking = data.booking && typeof data.booking === 'object' && !Array.isArray(data.booking)
    ? (data.booking as Record<string, unknown>)
    : {}
  const startRaw = [booking.scheduled_at, booking.starts_at, packet.scheduled_at].find((v) => typeof v === 'string') as
    | string
    | undefined
  if (!startRaw) return null
  const startsAt = new Date(startRaw)
  if (!Number.isFinite(startsAt.getTime())) return null
  const endRaw = [booking.ends_at, packet.ends_at].find((v) => typeof v === 'string') as string | undefined
  const endsAt = endRaw && Number.isFinite(new Date(endRaw).getTime())
    ? new Date(endRaw)
    : new Date(startsAt.getTime() + 60 * 60 * 1000)
  const timezone = typeof booking.timezone === 'string' && booking.timezone ? booking.timezone : 'America/Los_Angeles'
  const uri = [booking.calendly_event_uri, booking.event_uri, packet.calendly_event_uri].find((v) => typeof v === 'string') as
    | string
    | undefined
  const meetingUrl = typeof booking.meeting_url === 'string' ? booking.meeting_url : null
  return {
    startsAt,
    endsAt,
    timezone,
    externalEventId: uri ? uri.slice(0, 190) : null,
    meetingUrl,
  }
}

/**
 * Put a booked SCS call on the Daily Desk calendar. Idempotent on
 * externalEventId (Calendly URI). Does not create clients.
 */
export async function upsertIntakeAppointment(opts: {
  source: IntakeSource
  clientId: string
  rawPayload: unknown
  store?: Prisma.TransactionClient
}): Promise<{ id: string } | null> {
  const booking = parseIntakeBooking(opts.rawPayload)
  if (!booking) return null
  const store = opts.store ?? db

  const client = await store.client.findFirst({
    where: { id: opts.clientId, organizationId: opts.source.organizationId, deletedAt: null },
    select: { id: true, ownerId: true },
  })
  if (!client) return null

  let ownerId = client.ownerId ?? opts.source.defaultOwnerId
  if (!ownerId) {
    const staff = await store.user.findFirst({
      where: {
        organizationId: opts.source.organizationId,
        deletedAt: null,
        isActive: true,
        role: { key: { in: ['SUPER_ADMIN', 'ADMIN', 'CLOSER'] } },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    ownerId = staff?.id ?? null
  }
  if (!ownerId) return null

  const existing = booking.externalEventId
    ? await store.appointment.findFirst({
        where: { clientId: client.id, externalEventId: booking.externalEventId },
      })
    : await store.appointment.findFirst({
        where: {
          clientId: client.id,
          status: { in: ['SCHEDULED', 'CONFIRMED'] },
          startsAt: booking.startsAt,
        },
      })

  const data = {
    ownerId,
    type: AppointmentType.PRESENTATION,
    status: AppointmentStatus.SCHEDULED,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    timezone: booking.timezone,
    meetingUrl: booking.meetingUrl,
    externalEventId: booking.externalEventId,
    cancelledAt: null,
    noShowRecordedAt: null,
  }

  if (existing) {
    return store.appointment.update({ where: { id: existing.id }, data, select: { id: true } })
  }
  return store.appointment.create({
    data: { clientId: client.id, ...data },
    select: { id: true },
  })
}
