import type { PrismaClient } from '@prisma/client'

type SeedCtx = {
  organizationId: string
  users: { id: string; email: string; role: string }[]
  clientIds: string[]
}

/**
 * Demo data for the messaging-automation slice: one triggered follow-up
 * sequence, one manual-only nurture sequence, a demo enrollment, and a
 * pending scheduled message. Idempotent — sequences are looked up by
 * (organizationId, name) and steps are replaced in full.
 *
 * Step templates deliberately use only follow_up_* keys: those templates
 * resolve from base client variables alone, so an automated send never dies
 * on an unresolved {{document_name}}-style placeholder.
 */
export async function seedAutomation(db: PrismaClient, ctx: SeedCtx): Promise<void> {
  const author =
    ctx.users.find((u) => u.role === 'ADMIN') ?? ctx.users.find((u) => u.role === 'SUPER_ADMIN') ?? ctx.users[0]

  const SEQUENCES: {
    name: string
    description: string
    triggerStageKey: 'NEW_LEAD' | null
    steps: { delayHours: number; channel: 'EMAIL' | 'SMS'; templateKey: string; stopIfReplied: boolean }[]
  }[] = [
    {
      name: 'New-lead follow-up',
      description: 'Three touches over five days for every brand-new lead. Stops the moment the client replies.',
      triggerStageKey: 'NEW_LEAD',
      steps: [
        { delayHours: 1, channel: 'EMAIL', templateKey: 'follow_up_email', stopIfReplied: true },
        { delayHours: 48, channel: 'SMS', templateKey: 'follow_up_sms', stopIfReplied: true },
        { delayHours: 72, channel: 'EMAIL', templateKey: 'follow_up_email', stopIfReplied: true },
      ],
    },
    {
      name: 'Gentle re-engage',
      description: 'Manual-enrollment nurture for quiet files: two spaced check-ins a week apart.',
      triggerStageKey: null,
      steps: [
        { delayHours: 24, channel: 'EMAIL', templateKey: 'follow_up_email', stopIfReplied: true },
        { delayHours: 168, channel: 'SMS', templateKey: 'follow_up_sms', stopIfReplied: true },
      ],
    },
  ]

  const sequenceIds: string[] = []
  for (const s of SEQUENCES) {
    const existing = await db.sequence.findFirst({
      where: { organizationId: ctx.organizationId, name: s.name },
      select: { id: true },
    })
    const sequence = existing
      ? await db.sequence.update({
          where: { id: existing.id },
          data: { description: s.description, isActive: true, triggerStageKey: s.triggerStageKey },
        })
      : await db.sequence.create({
          data: {
            organizationId: ctx.organizationId,
            name: s.name,
            description: s.description,
            isActive: true,
            triggerStageKey: s.triggerStageKey,
            createdById: author?.id ?? null,
          },
        })
    sequenceIds.push(sequence.id)

    await db.sequenceStep.deleteMany({ where: { sequenceId: sequence.id } })
    await db.sequenceStep.createMany({
      data: s.steps.map((st, position) => ({ sequenceId: sequence.id, position, ...st })),
    })
  }

  // One demo enrollment in the nurture sequence, due on the next job run.
  const demoClientId = ctx.clientIds[0]
  if (demoClientId && sequenceIds[1]) {
    await db.sequenceEnrollment.upsert({
      where: { sequenceId_clientId: { sequenceId: sequenceIds[1], clientId: demoClientId } },
      update: {},
      create: {
        sequenceId: sequenceIds[1],
        clientId: demoClientId,
        status: 'ACTIVE',
        currentStep: 0,
        nextRunAt: new Date(Date.now() + 60 * 60_000),
        enrolledById: author?.id ?? null,
      },
    })
  }

  // One pending scheduled message, visible in the client's "Scheduled" strip.
  const scheduledClientId = ctx.clientIds[1] ?? demoClientId
  if (scheduledClientId) {
    const existing = await db.scheduledMessage.findFirst({
      where: { clientId: scheduledClientId, templateKey: 'follow_up_email', status: 'PENDING' },
      select: { id: true },
    })
    if (!existing) {
      const tomorrow9 = new Date(Date.now() + 86_400_000)
      tomorrow9.setHours(9, 0, 0, 0)
      await db.scheduledMessage.create({
        data: {
          organizationId: ctx.organizationId,
          clientId: scheduledClientId,
          userId: author?.id ?? null,
          channel: 'EMAIL',
          templateKey: 'follow_up_email',
          sendAt: tomorrow9,
        },
      })
    }
  }
}
