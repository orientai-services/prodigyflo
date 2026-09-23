import 'server-only'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'

export const activeAppointmentWhere = (now = new Date()) => ({
  status: { in: ['SCHEDULED', 'CONFIRMED'] as ('SCHEDULED' | 'CONFIRMED')[] }, endsAt: { gt: now },
})
export const appointmentKey = (organizationId: string, clientId: string, key: string) =>
  createHash('sha256').update(JSON.stringify([organizationId, clientId, key])).digest('hex')

export type SchedulingResult = {
  ok: boolean; outcome: 'SAVED' | 'REPLAYED' | 'CONFLICT'; error?: string;
  appointmentId?: string; clientId?: string; startsAt?: string; endsAt?: string;
  timezone?: string; updatedAt?: string; status?: string;
}

/** Every writer calls this inside its transaction, including inbound intake. */
export async function scheduleAppointment(tx: Prisma.TransactionClient, input: {
  organizationId: string; clientId: string; scope: Prisma.ClientWhereInput;
  requestKey: string; startsAt: Date; endsAt: Date; timezone: string;
  appointmentId?: string; expectedUpdatedAt?: string; externalEventId?: string | null;
  meetingUrl?: string | null; imported?: boolean;
}): Promise<SchedulingResult> {
  if (input.imported && input.externalEventId) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.organizationId, input.externalEventId])}, 0))`
  await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${input.clientId} FOR UPDATE`
  const client = await tx.client.findFirst({ where: { AND: [input.scope, { id: input.clientId, organizationId: input.organizationId, deletedAt: null }] }, select: { id: true, ownerId: true } })
  if (!client) return { ok: false, outcome: 'CONFLICT', error: 'Client not found or no longer assigned to you.' }
  const key = appointmentKey(input.organizationId, input.imported && input.externalEventId ? '' : client.id, input.requestKey)
  const receipt = await tx.appointmentReceipt.findUnique({ where: { id: key } })
  const current = async (id: string, outcome: 'SAVED' | 'REPLAYED'): Promise<SchedulingResult> => {
    const row = await tx.appointment.findFirst({ where: { id, clientId: client.id } })
    if (!row) return { ok: false, outcome: 'CONFLICT', error: 'The previous appointment is no longer available.' }
    return { ok: true, outcome, appointmentId: row.id, clientId: client.id, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), timezone: row.timezone, updatedAt: row.updatedAt.toISOString(), status: row.status }
  }
  if (receipt) {
    if (input.imported && receipt.outcome === 'CONFLICT' && !receipt.appointmentId) {
      await tx.appointmentReceipt.delete({ where: { id: key } })
    } else {
      return receipt.outcome === 'CONFLICT' || !receipt.appointmentId
        ? { ok: false, outcome: 'CONFLICT', error: 'This booking conflicted with an existing appointment. Use Reschedule.' }
        : current(receipt.appointmentId, 'REPLAYED')
    }
  }
  const remember = async (id: string | null, outcome: 'SAVED' | 'CONFLICT') => tx.appointmentReceipt.create({ data: { id: key, clientId: client.id, appointmentId: id, outcome } })
  const conflict = async (message: string): Promise<SchedulingResult> => { await remember(null, 'CONFLICT'); return { ok: false, outcome: 'CONFLICT', error: message } }
  // Old provider events never undo subsequent staff edits or terminal statuses.
  if (input.imported && input.externalEventId) {
    const existing = await tx.appointment.findFirst({ where: { client: { organizationId: input.organizationId }, externalEventId: input.externalEventId } })
    if (existing && existing.clientId !== client.id) return conflict('This booking event already belongs to another client.')
    if (existing) { await remember(existing.id, 'SAVED'); return current(existing.id, 'REPLAYED') }
  }
  const now = new Date()
  if (!Number.isFinite(input.startsAt.getTime()) || input.endsAt <= input.startsAt)
    return conflict('Invalid appointment window.')
  if (!input.imported && input.startsAt <= now) return conflict('Choose an appointment time in the future.')
  const active = await tx.appointment.findMany({ where: { clientId: client.id, ...activeAppointmentWhere(now) }, orderBy: { startsAt: 'asc' } })
  if (active.some(a => a.id !== input.appointmentId)) {
    // A provider may deliver the same call after a staff member placed it.
    const same = input.imported && active.length === 1 && active[0].startsAt.getTime() === input.startsAt.getTime() && (!active[0].externalEventId || active[0].externalEventId === input.externalEventId)
    if (same) {
      if (input.externalEventId && !active[0].externalEventId) await tx.appointment.update({ where: { id: active[0].id }, data: { externalEventId: input.externalEventId, meetingUrl: input.meetingUrl ?? undefined } })
      await remember(active[0].id, 'SAVED'); return current(active[0].id, 'REPLAYED')
    }
    return conflict('This client already has an upcoming appointment. Use Reschedule to change it.')
  }
  const data = { startsAt: input.startsAt, endsAt: input.endsAt, timezone: input.timezone, ownerId: client.ownerId }
  if (input.appointmentId) {
    const previous = await tx.appointment.findFirst({ where: { id: input.appointmentId, clientId: client.id, status: { in: ['SCHEDULED', 'CONFIRMED'] } } })
    if (!previous || !input.expectedUpdatedAt || previous.updatedAt.toISOString() !== input.expectedUpdatedAt)
      return conflict('This appointment changed. Refresh it before rescheduling.')
    await tx.appointment.update({ where: { id: previous.id }, data })
    await remember(previous.id, 'SAVED'); return current(previous.id, 'SAVED')
  }
  const row = await tx.appointment.create({ data: { ...data, clientId: client.id, type: 'PRESENTATION', status: 'SCHEDULED', externalEventId: input.externalEventId, meetingUrl: input.meetingUrl } })
  await remember(row.id, 'SAVED'); return current(row.id, 'SAVED')
}
