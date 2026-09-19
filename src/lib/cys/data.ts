import 'server-only'
import { cache } from 'react'
import { randomUUID } from 'node:crypto'
import { type CysReadiness, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { classifyDeskKind } from '@/lib/daily-desk-docs'
import { asRecord, str } from '@/lib/packet/schema'
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
    orderBy: [{ position: 'asc' }, { key: 'asc' }],
  })
}

/** Assembles the pure SourceRecord the resolver reads from. */
export async function loadSources(clientId: string): Promise<SourceRecord> {
  return (await loadSourcesForClients([clientId])).get(clientId)!
}

/** Batch source loading keeps Queue resolution independent of client count. */
export async function loadSourcesForClients(clientIds: string[]): Promise<Map<string, SourceRecord>> {
  if (!clientIds.length) return new Map()
  const [clients, allDocuments, surveys] = await Promise.all([
    db.client.findMany({
      where: { id: { in: clientIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        preferredLanguage: true,
        addresses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 1 },
      },
    }),
    db.clientDocument.findMany({
      where: { clientId: { in: clientIds }, status: { notIn: ['REJECTED', 'EXPIRED'] } },
      select: {
        id: true, clientId: true,
        fileName: true,
        label: true,
        status: true, storageKey: true,
        requirement: { select: { name: true, key: true } },
        extractions: {
          where: { status: 'COMPLETED' },
          orderBy: { createdAt: 'desc' },
          select: { detectedTypeKey: true, fields: true },
        },
      },
    }),
    db.surveyResponse.findMany({
      where: { clientId: { in: clientIds }, status: 'COMPLETED' },
      distinct: ['clientId'],
      orderBy: { completedAt: 'desc' },
      select: { clientId: true, answers: true },
    }),
  ])

  const byClient = new Map(clients.map(client => [client.id, client]))
  const surveyByClient = new Map(surveys.map(survey => [survey.clientId, survey]))
  const docsByClient = new Map<string, typeof allDocuments>()
  for (const doc of allDocuments) docsByClient.set(doc.clientId, [...(docsByClient.get(doc.clientId) ?? []), doc])
  const result = new Map<string, SourceRecord>()
  for (const clientId of clientIds) {
    const client = byClient.get(clientId)
    const documents = docsByClient.get(clientId) ?? []
    const documentFields: DocumentFieldInput[] = []
    for (const doc of documents) {
      for (const extraction of doc.extractions) for (const field of extraction.fields) documentFields.push({
        key: field.key, documentTypeKey: extraction.detectedTypeKey, value: field.value,
        correctedValue: field.correctedValue, verification: field.verification, confidence: field.confidence,
        documentId: doc.id, extractedFieldId: field.id, documentLabel: doc.label ?? doc.fileName ?? doc.requirement?.name ?? 'Document', sourcePage: field.sourcePage,
      })
    }
    result.set(clientId, {
      client: client ? flattenClient(client) : {},
      address: client ? flattenAddress(client.addresses[0] ?? null) : null,
      survey: flattenSurveyAnswers(surveyByClient.get(clientId)?.answers), documentFields,
      surveyProvenance: Object.fromEntries(Object.entries(asRecord(asRecord(surveyByClient.get(clientId)?.answers)._scs_answer_provenance)).map(([key, value]) => [key, { source: str(asRecord(value).source) }])),
      documents: documents.filter(doc => Boolean(doc.storageKey)).map(doc => ({
        id: doc.id, kind: classifyDeskKind({ requirementKey: doc.requirement?.key, detectedType: doc.extractions[0]?.detectedTypeKey, label: doc.label, fileName: doc.fileName })?.key ?? 'other',
        label: doc.label || doc.fileName || 'Document', approved: doc.status === 'APPROVED',
      })),
    })
  }
  return result
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
  const [definitions, sources] = await Promise.all([loadDefinitions(organizationId), loadSources(clientId)])
  const resolved = resolveAll(definitions, sources)
  if (!resolved.length) return
  // One atomic batch upsert; the conflict predicate is checked while holding
  // each row lock, so imports cannot overwrite a concurrent staff correction.
  const rows = resolved.map(r => Prisma.sql`(${randomUUID()}, ${clientId}, ${r.fieldKey}, ${r.value}, ${r.status}::"CysValueStatus", ${r.confidence}, ${r.sourceLabel}, ${r.sourceDocumentId}, ${r.sourceExtractedFieldId}, ${r.conflictValue}, ${r.note}, NOW(), NOW())`)
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "CysFieldValue" (id,"clientId","fieldKey",value,status,confidence,"sourceLabel","sourceDocumentId","sourceExtractedFieldId","conflictValue",note,"createdAt","updatedAt") VALUES ${Prisma.join(rows)}
    ON CONFLICT ("clientId","fieldKey") DO UPDATE SET value=EXCLUDED.value,status=EXCLUDED.status,confidence=EXCLUDED.confidence,
      "sourceLabel"=EXCLUDED."sourceLabel","sourceDocumentId"=EXCLUDED."sourceDocumentId","sourceExtractedFieldId"=EXCLUDED."sourceExtractedFieldId",
      "conflictValue"=EXCLUDED."conflictValue",note=EXCLUDED.note,"updatedAt"=NOW()
    WHERE NOT ("CysFieldValue".status='VERIFIED' AND "CysFieldValue"."verifiedById" IS NOT NULL)
  `)
}

/** Read-only projection. Repeated server components share it within a request. */
export const resolveForClient = cache(async (
  user: SessionUser,
  clientId: string,
): Promise<ResolvedWorkspace> => {
  const client = await findClientInScope(user, clientId)
  if (!client) throw new ForbiddenError('Client not found or out of your scope.')
  const [definitions, sources, existing, savedReadiness] = await Promise.all([
    loadDefinitions(user.organizationId), loadSources(clientId),
    db.cysFieldValue.findMany({ where: { clientId }, include: CYS_VALUE_INCLUDE }),
    db.cysReadiness.findUnique({ where: { clientId } }),
  ])
  const byKey = new Map(existing.map((value) => [value.fieldKey, value]))
  const now = new Date()
  const values: CysValueRow[] = resolveAll(definitions, sources).map((resolved) => {
    const saved = byKey.get(resolved.fieldKey)
    if (saved?.verifiedById && saved.status === 'VERIFIED') return saved
    const source = sources.documentFields.find((field) => field.extractedFieldId === resolved.sourceExtractedFieldId)
    return {
      ...resolved,
      id: saved?.id ?? `projection:${clientId}:${resolved.fieldKey}`, clientId,
      verifiedById: null, verifiedAt: null, verifiedBy: null,
      createdAt: saved?.createdAt ?? now, updatedAt: saved?.updatedAt ?? now,
      sourceDocument: source ? { id: source.documentId, fileName: null, label: source.documentLabel } : null,
      sourceField: source ? { id: source.extractedFieldId, sourcePage: source.sourcePage } : null,
    }
  })
  const completion = computeCompletion(definitions, values)
  const checklist = buildChecklist(definitions, values)
  const blockers = approvalBlockers(definitions, values)
  const readiness: CysReadiness = {
    id: savedReadiness?.id ?? `projection:${clientId}`, clientId,
    packageJson: null, packageGeneratedAt: null, approvedById: null, approvedAt: null, approvalNote: null,
    createdAt: now, updatedAt: now, ...savedReadiness, ...completion, checklist,
  }
  return { definitions, values, completion, checklist, blockers, readiness }
})

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

  const { definitions, values, completion, checklist, blockers } = await resolveForClient(user, clientId)
  if (blockers.length) throw new PackageNotAllowedError()

  const citedIds = new Set(
    values.map((v) => v.sourceDocumentId).filter((id): id is string => id !== null),
  )
  const documents = await manifestDocuments(clientId, citedIds)

  const now = new Date()
  const confirmed = (key: string) => values.find(value => value.fieldKey === key && value.status === 'VERIFIED')?.value || ''
  const pkg = buildPackageDocument({
    client: { ...client, firstName: confirmed('first_name') || client.firstName, lastName: confirmed('last_name') || client.lastName, email: confirmed('email') || client.email },
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
      note: v.note,
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
