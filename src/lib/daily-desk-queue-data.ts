import 'server-only'
import { db } from '@/lib/db'
import { can, clientScope, type SessionUser } from '@/lib/rbac'
import { deskVisibleClientWhere } from '@/lib/intake/scs-desk'
import { loadDefinitions } from '@/lib/cys/data'
import { approvalBlockers } from '@/lib/cys/readiness'
import { CASE_DOC_KINDS, matchDocKind } from '@/lib/daily-desk-docs'
import {
  QUEUE_BUCKET_META,
  QUEUE_BUCKETS,
  missingPacketKinds,
  queueReasons,
  type QueueBucketKey,
} from '@/lib/daily-desk-queue'

const CAP = 50

export type DeskQueueRow = {
  clientId: string
  name: string
  why: string
  ownerName: string | null
  missingRequirementIds: string[]
}

export type DeskQueueBucket = {
  key: QueueBucketKey
  title: string
  description: string
  total: number
  rows: DeskQueueRow[]
}

export type DeskQueue = {
  buckets: DeskQueueBucket[]
  closers: { id: string; name: string }[]
  canAssign: boolean
  canBook: boolean
  canRequest: boolean
  /** Client.isTest is not in this schema — no hide filter, no migration. */
  isTestHidden: false
}

export async function loadDeskQueue(user: SessionUser): Promise<DeskQueue> {
  const now = new Date()
  const [clients, requirements, definitions, closers] = await Promise.all([
    db.client.findMany({
      where: { AND: [clientScope(user), deskVisibleClientWhere(), { status: 'ACTIVE', deletedAt: null }] },
      orderBy: { lastActivityAt: 'desc' },
      take: 400,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        ownerId: true,
        owner: { select: { name: true } },
        appointments: {
          where: { status: { in: ['SCHEDULED', 'CONFIRMED'] }, startsAt: { gte: now } },
          select: { id: true },
          take: 1,
        },
        documents: {
          where: { status: { notIn: ['REJECTED', 'EXPIRED'] } },
          select: {
            storageKey: true,
            label: true,
            requirement: { select: { key: true } },
            extractions: { orderBy: { createdAt: 'desc' }, take: 1, select: { detectedTypeKey: true } },
          },
        },
        cysFieldValues: { select: { fieldKey: true, status: true } },
      },
    }),
    db.documentRequirement.findMany({
      where: { package: { organizationId: user.organizationId } },
      select: { id: true, key: true },
    }),
    loadDefinitions(user.organizationId),
    db.user.findMany({
      where: { organizationId: user.organizationId, role: { key: 'CLOSER' }, deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const reqByKind = new Map<string, string>()
  for (const r of requirements) {
    const kind = matchDocKind(r.key)
    if (kind && !reqByKind.has(kind.key)) reqByKind.set(kind.key, r.id)
  }

  const cysDefs = definitions.map((d) => ({
    key: d.key,
    label: d.label,
    groupName: d.groupName,
    position: d.position,
    isRequired: d.isRequired,
    dataType: d.dataType,
    sourceType: d.sourceType,
    sourcePath: d.sourcePath,
  }))

  const buckets: Record<QueueBucketKey, DeskQueueRow[]> = {
    unassigned: [],
    unscheduled: [],
    missing_docs: [],
    cys: [],
  }
  const totals: Record<QueueBucketKey, number> = {
    unassigned: 0,
    unscheduled: 0,
    missing_docs: 0,
    cys: 0,
  }

  for (const row of clients) {
    const missingLabels = missingPacketKinds(
      row.documents.map((d) => ({
        requirementKey: d.requirement?.key ?? null,
        detectedTypeKey: d.extractions[0]?.detectedTypeKey ?? null,
        label: d.label,
        hasFile: Boolean(d.storageKey),
      })),
    )
    const missingKeys = CASE_DOC_KINDS.filter((k) => missingLabels.includes(k.label)).map((k) => k.key)
    const missingRequirementIds = missingKeys.map((k) => reqByKind.get(k)).filter((id): id is string => Boolean(id))
    const blockers = cysDefs.length
      ? approvalBlockers(cysDefs, row.cysFieldValues.map((v) => ({ fieldKey: v.fieldKey, status: v.status })))
      : []
    const reasons = queueReasons({
      ownerId: row.ownerId,
      hasUpcomingAppointment: row.appointments.length > 0,
      missingDocLabels: missingLabels,
      cysBlockers: blockers,
    })
    const name = `${row.firstName} ${row.lastName}`
    for (const reason of reasons) {
      totals[reason.bucket] += 1
      if (buckets[reason.bucket].length >= CAP) continue
      buckets[reason.bucket].push({
        clientId: row.id,
        name,
        why: reason.why,
        ownerName: row.owner?.name ?? null,
        missingRequirementIds,
      })
    }
  }

  return {
    buckets: QUEUE_BUCKETS.map((key) => ({
      key,
      title: QUEUE_BUCKET_META[key].title,
      description: QUEUE_BUCKET_META[key].description,
      total: totals[key],
      rows: buckets[key],
    })),
    closers,
    canAssign: can(user, 'clients:reassign'),
    canBook: can(user, 'appointments:manage'),
    canRequest: can(user, 'documents:request'),
    isTestHidden: false,
  }
}
