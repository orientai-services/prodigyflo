import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit, redactForAudit } from '@/lib/audit'
import { normaliseEmail, normalisePhone } from '@/lib/dedupe'
import { ForbiddenError, type SessionUser } from '@/lib/rbac'

/** The organization's default pipeline and its entry stage. */
export async function getDefaultPipeline(organizationId: string) {
  const pipeline = await db.pipeline.findFirst({
    where: { organizationId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    include: { stages: { orderBy: { position: 'asc' } } },
  })
  if (!pipeline || pipeline.stages.length === 0) {
    throw new Error('This organization has no pipeline configured.')
  }
  const firstStage = pipeline.stages.find((s) => s.key === 'NEW_LEAD') ?? pipeline.stages[0]
  return { pipeline, firstStage }
}

export type NewClientData = {
  firstName: string
  lastName: string
  email: string
  phone: string
  preferredLanguage?: string
  preferredContact?: string
  ownerId?: string | null
  leadSourceId?: string | null
  estimatedValue?: number | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  address?: {
    line1: string
    line2?: string | null
    city: string
    state: string
    postalCode: string
  } | null
  note?: string | null
}

/**
 * Creates a client in the caller's organization on the default pipeline's
 * entry stage, with the opening StageHistory row and an audit event — the one
 * write path shared by the manual form and the CSV importer.
 */
export async function createClientRecord(user: SessionUser, data: NewClientData, source = 'manual') {
  if (user.role !== 'SUPER_ADMIN') throw new ForbiddenError()
  const { pipeline, firstStage } = await getDefaultPipeline(user.organizationId)

  const client = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff:${user.organizationId}`}))`
    if (data.ownerId && !await tx.user.findFirst({ where: { id: data.ownerId, organizationId: user.organizationId, isActive: true, deletedAt: null, role: { key: 'CLOSER' } } })) throw new ForbiddenError('Assign an active Closer from this workspace.')
    const created = await tx.client.create({
      data: {
        organizationId: user.organizationId,
        pipelineId: pipeline.id,
        currentStageId: firstStage.id,
        regionId: user.regionId,
        teamId: user.teamId,
        ownerId: data.ownerId ?? null,
        firstName: data.firstName.trim(),
        lastName: data.lastName.trim(),
        email: normaliseEmail(data.email),
        phone: normalisePhone(data.phone),
        preferredLanguage: data.preferredLanguage || 'en',
        preferredContact: data.preferredContact || 'phone',
        leadSourceId: data.leadSourceId ?? null,
        estimatedValue: data.estimatedValue ?? null,
        utmSource: data.utmSource || null,
        utmMedium: data.utmMedium || null,
        utmCampaign: data.utmCampaign || null,
      },
    })

    await tx.stageHistory.create({
      data: {
        clientId: created.id,
        stageId: firstStage.id,
        fromKey: null,
        toKey: firstStage.key,
        changedById: user.id,
        reason: source === 'manual' ? 'Created manually' : `Created via ${source}`,
      },
    })

    if (data.address?.line1) {
      await tx.clientAddress.create({
        data: {
          clientId: created.id,
          line1: data.address.line1,
          line2: data.address.line2 || null,
          city: data.address.city,
          state: data.address.state,
          postalCode: data.address.postalCode,
          isPrimary: true,
        },
      })
    }

    if (data.note?.trim()) {
      await tx.note.create({
        data: { clientId: created.id, authorId: user.id, body: data.note.trim(), isInternal: true },
      })
    }

    return created
  })

  await recordAudit(user, {
    action: 'client.created',
    entityType: 'Client',
    entityId: client.id,
    summary: `Created ${client.firstName} ${client.lastName} (${source})`,
    after: redactForAudit({
      firstName: client.firstName,
      lastName: client.lastName,
      email: client.email,
      phone: client.phone,
      stage: firstStage.key,
      source,
    }),
  })

  return client
}

/** Merge-updates an existing client from an import row and audits the change. */
export async function updateClientRecord(
  user: SessionUser,
  clientId: string,
  changes: Prisma.ClientUpdateInput,
  summary: string,
  before: Record<string, unknown>,
) {
  const updated = await db.client.update({
    where: { id: clientId },
    data: { ...changes, lastActivityAt: new Date() },
  })
  await recordAudit(user, {
    action: 'client.updated',
    entityType: 'Client',
    entityId: clientId,
    summary,
    before: redactForAudit(before),
    after: redactForAudit(changes as Record<string, unknown>),
  })
  return updated
}
