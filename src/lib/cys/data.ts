import 'server-only'
import type { CysReadiness, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { ForbiddenError, findClientInScope, type SessionUser } from '@/lib/rbac'
import {
  flattenAddress,
  flattenClient,
  flattenSurveyAnswers,
  resolveAll,
  type CysDefinitionInput,
  type DocumentFieldInput,
  type SourceRecord,
} from '@/lib/cys/resolve'
import {
  approvalBlockers,
  buildChecklist,
  computeCompletion,
  type ChecklistItem,
  type CompletionSummary,
} from '@/lib/cys/readiness'
import {
  assertPackageAllowed,
  buildPackageDocument,
  PackageNotAllowedError,
  type PackageManifestDocument,
} from '@/lib/cys/package'

const APP_VERSION = process.env.APP_VERSION ?? 'prodigyflo-dev'

export const CYS_VALUE_INCLUDE = {
  verifiedBy: { select: { id: true, name: true } },
  sourceDocument: { select: { id: true, fileName: true, label: true } },
  sourceField: { select: { id: true, sourcePage: true } },
} satisfies Prisma.CysFieldValueInclude

export type CysValueRow = Prisma.CysFieldValueGetPayload<{ include: typeof CYS_VALUE_INCLUDE }>

export async function loadDefinitions(
  organizationId: string,
  opts: { activeOnly?: boolean } = {},
) {
  return db.cysFieldDefinition.findMany({
    where: { organizationId, ...(opts.activeOnly === false ? {} : { isActive: true }) },
    orderBy: [{ groupName: 'asc' }, { position: 'asc' }, { key: 'asc' }],
  })
}

/** Assembles the pure SourceRecord the resolver reads from. */
export async function loadSources(clientId: string): Promise<SourceRecord> {
  const [client, documents, survey] = await Promise.all([
    db.client.findUnique({
      where: { id: clientId },
      select: {
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        preferredLanguage: true,
        addresses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 1 },
      },
    }),
    db.clientDocument.findMany({
      where: { clientId, status: { notIn: ['REJECTED', 'EXPIRED'] } },
      select: {
        id: true,
        fileName: true,
        label: true,
        requirement: { select: { name: true } },
        extractions: {
          where: { status: 'COMPLETED' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { detectedTypeKey: true, fields: true },
        },
      },
    }),
    db.surveyResponse.findFirst({
      where: { clientId, status: 'COMPLETED' },
      orderBy: { completedAt: 'desc' },
      select: { answers: true },
    }),
  ])

  const documentFields: DocumentFieldInput[] = []
  for (const doc of documents) {
    const extraction = doc.extractions[0]
    if (!extraction) continue
    const documentLabel = doc.label ?? doc.fileName ?? doc.requirement?.name ?? 'Document'
    for (const field of extraction.fields) {
      documentFields.push({
        key: field.key,
        documentTypeKey: extraction.detectedTypeKey,
        value: field.value,
        correctedValue: field.correctedValue,
        verification: field.verification,
        confidence: field.confidence,
        documentId: doc.id,
        extractedFieldId: field.id,
        documentLabel,
        sourcePage: field.sourcePage,
      })
    }
  }

  return {
    client: client ? flattenClient(client) : {},
    address: client ? flattenAddress(client.addresses[0] ?? null) : null,
    survey: flattenSurveyAnswers(survey?.answers),
    documentFields,
  }
}

export type ResolvedWorkspace = {
  definitions: CysDefinitionInput[]
  values: CysValueRow[]
  completion: CompletionSummary
  checklist: ChecklistItem[]
  blockers: string[]
  readiness: CysReadiness
}

/**
 * Re-resolves every active definition for one client and persists the result.
 * A row a human already verified in the workspace is never clobbered by
 * re-resolution — their decision outranks whatever the sources now say.
 */
/** Re-resolve the CYS mirror without a staff session — used by SCS ingest. */
export async function refreshCysMirror(organizationId: string, clientId: string): Promise<void> {
  const [definitions, sources, existing] = await Promise.all([
    loadDefinitions(organizationId),
    loadSources(clientId),
    db.cysFieldValue.findMany({ where: { clientId } }),
  ])
  const humanVerified = new Set(
    existing.filter((v) => v.verifiedById !== null && v.status === 'VERIFIED').map((v) => v.fieldKey),
  )
  const resolved = resolveAll(definitions, sources).filter((r) => !humanVerified.has(r.fieldKey))
  await db.$transaction(
    resolved.map((r) =>
      db.cysFieldValue.upsert({
        where: { clientId_fieldKey: { clientId, fieldKey: r.fieldKey } },
        create: {
          clientId,
          fieldKey: r.fieldKey,
          value: r.value,
          status: r.status,
          confidence: r.confidence,
          sourceLabel: r.sourceLabel,
          sourceDocumentId: r.sourceDocumentId,
          sourceExtractedFieldId: r.sourceExtractedFieldId,
          conflictValue: r.conflictValue,
          note: r.note,
        },
        update: {
          value: r.value,
          status: r.status,
          confidence: r.confidence,
          sourceLabel: r.sourceLabel,
          sourceDocumentId: r.sourceDocumentId,
          sourceExtractedFieldId: r.sourceExtractedFieldId,
          conflictValue: r.conflictValue,
          note: r.note,
        },
      }),
    ),
  )
}

export async function resolveForClient(
  user: SessionUser,
  clientId: string,
): Promise<ResolvedWorkspace> {
  const client = await findClientInScope(user, clientId)
  if (!client) throw new ForbiddenError('Client not found or out of your scope.')

  const [definitions, sources, existing] = await Promise.all([
    loadDefinitions(user.organizationId),
    loadSources(clientId),
    db.cysFieldValue.findMany({ where: { clientId } }),
  ])

  const humanVerified = new Set(
    existing.filter((v) => v.verifiedById !== null && v.status === 'VERIFIED').map((v) => v.fieldKey),
  )

  const resolved = resolveAll(definitions, sources).filter((r) => !humanVerified.has(r.fieldKey))

  await db.$transaction(
    resolved.map((r) =>
      db.cysFieldValue.upsert({
        where: { clientId_fieldKey: { clientId, fieldKey: r.fieldKey } },
        create: {
          clientId,
          fieldKey: r.fieldKey,
          value: r.value,
          status: r.status,
          confidence: r.confidence,
          sourceLabel: r.sourceLabel,
          sourceDocumentId: r.sourceDocumentId,
          sourceExtractedFieldId: r.sourceExtractedFieldId,
          conflictValue: r.conflictValue,
          note: r.note,
        },
        update: {
          value: r.value,
          status: r.status,
          confidence: r.confidence,
          sourceLabel: r.sourceLabel,
          sourceDocumentId: r.sourceDocumentId,
          sourceExtractedFieldId: r.sourceExtractedFieldId,
          conflictValue: r.conflictValue,
          note: r.note,
          verifiedById: null,
          verifiedAt: null,
        },
      }),
    ),
  )

  const values = await db.cysFieldValue.findMany({
    where: { clientId },
    include: CYS_VALUE_INCLUDE,
  })

  const completion = computeCompletion(definitions, values)
  const checklist = buildChecklist(definitions, values)
  const blockers = approvalBlockers(definitions, values)

  const readiness = await db.cysReadiness.upsert({
    where: { clientId },
    create: { clientId, ...completion, checklist },
    update: {
      completionPct: completion.completionPct,
      requiredTotal: completion.requiredTotal,
      requiredVerified: completion.requiredVerified,
      checklist,
    },
  })

  return { definitions, values, completion, checklist, blockers, readiness }
}

/** Documents that back the package: everything approved plus every cited source. */
async function manifestDocuments(
  clientId: string,
  citedIds: Set<string>,
): Promise<PackageManifestDocument[]> {
  const docs = await db.clientDocument.findMany({
    where: {
      clientId,
      OR: [{ status: 'APPROVED' }, { id: { in: [...citedIds] } }],
    },
    select: {
      id: true,
      fileName: true,
      label: true,
      mimeType: true,
      sizeBytes: true,
      checksum: true,
      version: true,
      status: true,
      requirement: { select: { name: true, category: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  return docs.map((d) => ({
    id: d.id,
    name: d.label ?? d.fileName ?? d.requirement?.name ?? 'Document',
    type: d.requirement?.category ?? 'OTHER',
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    checksum: d.checksum,
    version: d.version,
    status: d.status,
  }))
}

/**
 * Builds and stores the CYS handover package, and keeps exactly one DRAFT
 * Submission row pointing at it. Refuses (server-side) before approval.
 */
export async function generateCysPackage(user: SessionUser, clientId: string) {
  const client = await findClientInScope(user, clientId)
  if (!client) throw new ForbiddenError('Client not found or out of your scope.')

  const readiness = await db.cysReadiness.findUnique({
    where: { clientId },
    include: { approvedBy: { select: { name: true } } },
  })
  assertPackageAllowed(readiness)
  if (!readiness) throw new PackageNotAllowedError()

  const { definitions, values, completion, checklist } = await resolveForClient(user, clientId)

  const citedIds = new Set(
    values.map((v) => v.sourceDocumentId).filter((id): id is string => id !== null),
  )
  const documents = await manifestDocuments(clientId, citedIds)

  const now = new Date()
  const pkg = buildPackageDocument({
    client,
    generatedBy: { id: user.id, name: user.name },
    generatedAt: now,
    appVersion: APP_VERSION,
    approval: {
      approvedByName: readiness.approvedBy?.name ?? null,
      approvedAt: readiness.approvedAt,
      note: readiness.approvalNote,
    },
    completion,
    checklist,
    definitions,
    values: values.map((v) => ({
      fieldKey: v.fieldKey,
      value: v.value,
      status: v.status,
      confidence: v.confidence,
      sourceLabel: v.sourceLabel,
      sourceDocumentId: v.sourceDocumentId,
      sourcePage: v.sourceField?.sourcePage ?? null,
      verifiedByName: v.verifiedBy?.name ?? null,
      verifiedAt: v.verifiedAt,
    })),
    documents,
  })

  const validationReport = {
    generatedAt: now.toISOString(),
    completionPct: completion.completionPct,
    requiredTotal: completion.requiredTotal,
    requiredVerified: completion.requiredVerified,
    checklist,
  }

  const [, submission] = await db.$transaction(async (tx) => {
    const updatedReadiness = await tx.cysReadiness.update({
      where: { clientId },
      data: { packageJson: pkg as never, packageGeneratedAt: now },
    })

    const draft = await tx.submission.findFirst({
      where: { clientId, destination: 'CYS', status: 'DRAFT' },
    })
    const submissionData = {
      packageManifest: documents as never,
      validationReport: validationReport as never,
      approvedById: readiness.approvedById,
      approvedAt: readiness.approvedAt,
    }
    const submission = draft
      ? await tx.submission.update({ where: { id: draft.id }, data: submissionData })
      : await tx.submission.create({
          data: {
            clientId,
            destination: 'CYS',
            status: 'DRAFT',
            attemptNumber:
              (await tx.submission.count({ where: { clientId, destination: 'CYS' } })) + 1,
            ...submissionData,
          },
        })
    return [updatedReadiness, submission] as const
  })

  await recordAudit(user, {
    action: 'cys.package_generated',
    entityType: 'Client',
    entityId: clientId,
    summary: `Generated CYS package v${pkg.packageVersion} (${documents.length} documents, ${completion.completionPct}% complete)`,
    after: { submissionId: submission.id, completion, documentCount: documents.length },
  })

  return { pkg, submissionId: submission.id }
}
