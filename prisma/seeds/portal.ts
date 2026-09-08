import type { PrismaClient } from '@prisma/client'

type SeedCtx = {
  organizationId: string
  users: { id: string; email: string; role: string }[]
  clientIds: string[]
}

/**
 * Demo rows for the client portal so client@prodigyflo.ai signs in to a lived-in
 * experience: a short visible message thread and an upcoming appointment on the
 * portal-linked client. Idempotent via externalRef / externalEventId markers;
 * synthetic only. Documents need no seeding — the demo client sits in
 * DOCUMENT_COLLECTION and already carries requested requirements from the core seed.
 */
export async function seedPortal(db: PrismaClient, ctx: SeedCtx) {
  const client = await db.client.findFirst({
    where: { organizationId: ctx.organizationId, portalUserId: { not: null } },
    select: { id: true, firstName: true, ownerId: true, portalUserId: true },
  })
  if (!client) return

  const advisorId =
    client.ownerId ?? ctx.users.find((u) => u.role !== 'CLIENT')?.id ?? null

  // ── Visible message thread ─────────────────────────────────
  const thread = [
    {
      ref: 'seed:portal:welcome',
      direction: 'OUTBOUND' as const,
      userId: advisorId,
      subject: 'Welcome to your portal',
      body: `Hi ${client.firstName}, welcome aboard! You can track your progress, upload documents, and message us right here. Reach out any time.`,
      minutesAgo: 60 * 26,
    },
    {
      ref: 'seed:portal:client-question',
      direction: 'INBOUND' as const,
      userId: client.portalUserId,
      subject: 'Portal message',
      body: 'Thank you! Quick question — is a phone photo of my utility bill okay, or do you need a scan?',
      minutesAgo: 60 * 20,
    },
    {
      ref: 'seed:portal:answer',
      direction: 'OUTBOUND' as const,
      userId: advisorId,
      subject: null,
      body: 'A clear phone photo works great — just make sure all four corners are in frame and the text is readable.',
      minutesAgo: 60 * 19,
    },
  ]

  for (const m of thread) {
    const existing = await db.communication.findFirst({
      where: { clientId: client.id, externalRef: m.ref },
      select: { id: true },
    })
    if (existing) continue
    await db.communication.create({
      data: {
        clientId: client.id,
        userId: m.userId,
        channel: 'PORTAL_MESSAGE',
        direction: m.direction,
        status: m.direction === 'INBOUND' ? 'RECEIVED' : 'SENT',
        subject: m.subject,
        body: m.body,
        isInternal: false,
        externalRef: m.ref,
        occurredAt: new Date(Date.now() - m.minutesAgo * 60_000),
      },
    })
  }

  // ── Upcoming appointment ───────────────────────────────────
  if (advisorId) {
    const marker = 'seed-portal-appointment'
    const existing = await db.appointment.findFirst({
      where: { clientId: client.id, externalEventId: marker },
      select: { id: true, startsAt: true },
    })
    const startsAt = new Date(Date.now() + 3 * 24 * 60 * 60_000)
    startsAt.setMinutes(0, 0, 0)
    const endsAt = new Date(startsAt.getTime() + 45 * 60_000)

    if (!existing) {
      await db.appointment.create({
        data: {
          clientId: client.id,
          ownerId: advisorId,
          type: 'DOCUMENT_REVIEW',
          status: 'CONFIRMED',
          startsAt,
          endsAt,
          timezone: 'America/Los_Angeles',
          meetingUrl: 'https://meet.example.com/prodigyflo-demo',
          externalEventId: marker,
          confirmedAt: new Date(),
        },
      })
    } else if (existing.startsAt < new Date()) {
      // Keep the demo appointment in the future on every reseed.
      await db.appointment.update({
        where: { id: existing.id },
        data: { startsAt, endsAt, status: 'CONFIRMED', cancelledAt: null },
      })
    }
  }
}
