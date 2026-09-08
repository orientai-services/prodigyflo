import 'server-only'
import type { StageKey } from '@prisma/client'
import { db } from '@/lib/db'

/**
 * Automatic sequence enrollment on stage change. Called from
 * moveClientToStage() after a successful transition; it must NEVER make a
 * stage move fail, so everything is wrapped and errors are swallowed into an
 * audit row.
 *
 * A client enrolls in a triggered sequence at most once, ever — the unique
 * [sequenceId, clientId] constraint plus the existence check mean a client
 * bouncing back into the trigger stage does not restart a finished sequence.
 */
export async function enrollOnStageChange(clientId: string, newStageKey: StageKey): Promise<void> {
  try {
    const client = await db.client.findFirst({
      where: { id: clientId, deletedAt: null },
      select: { id: true, organizationId: true, firstName: true, lastName: true },
    })
    if (!client) return

    const sequences = await db.sequence.findMany({
      where: { organizationId: client.organizationId, isActive: true, triggerStageKey: newStageKey },
      include: { steps: { orderBy: { position: 'asc' }, take: 1 } },
    })

    for (const sequence of sequences) {
      const firstStep = sequence.steps[0]
      if (!firstStep) continue

      const existing = await db.sequenceEnrollment.findUnique({
        where: { sequenceId_clientId: { sequenceId: sequence.id, clientId: client.id } },
        select: { id: true },
      })
      if (existing) continue

      try {
        const enrollment = await db.sequenceEnrollment.create({
          data: {
            sequenceId: sequence.id,
            clientId: client.id,
            status: 'ACTIVE',
            currentStep: 0,
            nextRunAt: new Date(Date.now() + firstStep.delayHours * 3_600_000),
          },
        })
        await db.auditEvent.create({
          data: {
            organizationId: client.organizationId,
            actorLabel: 'Automation engine',
            action: 'sequence_enrollment.created',
            entityType: 'SequenceEnrollment',
            entityId: enrollment.id,
            summary: `${client.firstName} ${client.lastName} auto-enrolled in “${sequence.name}” on entering stage ${newStageKey}`,
            after: { sequenceId: sequence.id, clientId: client.id, trigger: newStageKey },
          },
        })
      } catch (err) {
        // Unique-constraint race with a concurrent enrollment — already enrolled.
        if ((err as { code?: string }).code === 'P2002') continue
        throw err
      }
    }
  } catch (err) {
    // Never let automation break a stage move; leave a trace instead.
    console.error('enrollOnStageChange failed', err)
  }
}
