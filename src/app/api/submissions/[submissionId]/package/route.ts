import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { canAny, clientScope, getSessionUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'

type ManifestEntry = { id?: string; checksum?: string | null; version?: number; name?: string }

/**
 * Immutable, admin-authenticated case packet. This is deliberately a manifest
 * and reviewed data export: original evidence remains in private storage and
 * is accessed through the normal document route with a fresh user session.
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ submissionId: string }> }) {
  const user = await getSessionUser()
  if (!user) return new Response('Unauthorized', { status: 401 })
  if (!canAny(user, ['submissions:read', 'submissions:prepare'])) return new Response('Forbidden', { status: 403 })
  const { submissionId } = await ctx.params
  const submission = await db.submission.findFirst({
    where: { id: submissionId, client: clientScope(user) },
    include: {
      client: {
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true,
          addresses: { select: { line1: true, line2: true, city: true, state: true, postalCode: true, isPrimary: true } },
          surveyResponses: { orderBy: { updatedAt: 'desc' }, take: 1, select: { answers: true, completedAt: true } },
        },
      },
    },
  })
  if (!submission) return new Response('Not found', { status: 404 })
  if (!submission.approvedAt) return new Response('This package has not been approved.', { status: 409 })

  const manifest = (Array.isArray(submission.packageManifest) ? submission.packageManifest : []) as ManifestEntry[]
  const ids = manifest.map((d) => d.id).filter((id): id is string => Boolean(id))
  const documents = ids.length
    ? await db.clientDocument.findMany({
        where: { id: { in: ids }, clientId: submission.clientId },
        include: { extractions: { where: { status: 'COMPLETED' }, orderBy: { createdAt: 'desc' }, take: 1, include: { fields: true } } },
      })
    : []
  const packet = {
    schemaVersion: 'prodigyflo.case-package.v1',
    generatedAt: new Date().toISOString(),
    submission: {
      id: submission.id, destination: submission.destination, attemptNumber: submission.attemptNumber,
      approvedAt: submission.approvedAt.toISOString(), validationReport: submission.validationReport,
      manifest,
    },
    client: submission.client,
    documents: documents.map((doc) => ({
      id: doc.id, name: doc.label ?? doc.fileName ?? 'Document', version: doc.version,
      checksum: doc.checksum, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes, status: doc.status,
      extraction: doc.extractions[0] ? {
        detectedType: doc.extractions[0].detectedTypeLabel,
        summary: doc.extractions[0].summary,
        fields: doc.extractions[0].fields.map((field) => ({
          key: field.key, label: field.label, value: field.correctedValue ?? field.value,
          verification: field.verification, confidence: field.confidence,
          sourcePage: field.sourcePage, sourceSnippet: field.sourceSnippet,
        })),
      } : null,
    })),
  }
  await recordAudit(user, {
    action: 'submission.package_downloaded', entityType: 'Submission', entityId: submission.id,
    summary: `Downloaded approved ${submission.destination.toLowerCase()} case package.`,
    after: { documentCount: documents.length, manifestCount: manifest.length },
  })
  return Response.json(packet, {
    headers: {
      'Content-Disposition': `attachment; filename="case-package-${submission.id}.json"`,
      'Cache-Control': 'no-store',
    },
  })
}
