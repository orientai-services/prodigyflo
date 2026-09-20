import 'server-only'
import { type IntakeSource, type Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { scheduleAppointment, type SchedulingResult } from '@/lib/scheduling'

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
}): Promise<({ id?: string } & SchedulingResult) | null> {
  const booking = parseIntakeBooking(opts.rawPayload)
  if (!booking) return null
  if (!opts.store) return db.$transaction((store) => upsertIntakeAppointment({ ...opts, store }))
  const result = await scheduleAppointment(opts.store, {
    organizationId: opts.source.organizationId, clientId: opts.clientId,
    scope: { organizationId: opts.source.organizationId }, imported: true,
    requestKey: `external:${booking.externalEventId ?? booking.startsAt.toISOString()}`,
    ...booking,
  })
  return { ...result, id: result.appointmentId }
}
