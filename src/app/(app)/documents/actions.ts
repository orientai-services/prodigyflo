'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { FieldVerification } from '@prisma/client'
import { db } from '@/lib/db'
import { can, getSessionUser, type SessionUser } from '@/lib/rbac'
import type { PermissionKey } from '@/lib/permissions'
import { recordAudit } from '@/lib/audit'
import { clientScope } from '@/lib/rbac'
import { documentScope } from '@/lib/storage/access'
import { runExtraction } from '@/lib/extraction/run'
import {
  BULK_VERIFY_THRESHOLD,
  canApproveDocument,
  computeMissingFieldKeys,
  documentStatusAfterExtraction,
  effectiveFieldValue,
  specForType,
  type ReviewableField,
} from '@/lib/extraction/spec'

/**
 * Every mutation in the document review flow. Each one re-checks permission
 * and client scope, writes an audit event, and — for review decisions — a
 * DocumentReview row. AI values only ever change verification state through
 * these actions, with a named reviewer and timestamp.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

async function actor(permission: PermissionKey): Promise<SessionUser | null> {
  const user = await getSessionUser()
  if (!user || !can(user, permission)) return null
  return user
}

const forbidden: ActionResult = { ok: false, error: 'You do not have permission to do that.' }

function revalidate(clientId: string, documentId?: string) {
  revalidatePath('/documents')
  if (documentId) revalidatePath(`/documents/${documentId}`)
  revalidatePath(`/clients/${clientId}`)
}

/** Loads a field with its document, inside the caller's client scope. */
async function fieldInScope(user: SessionUser, fieldId: string) {
  return db.extractedField.findFirst({
    where: { id: fieldId, extraction: { document: { client: clientScope(user) } } },
    include: { extraction: { include: { document: { select: { id: true, clientId: true, label: true, version: true } } } } },
  })
}

/**
 * After field-level review the document may cross between MISSING_INFORMATION
 * and UNDER_REVIEW. Terminal and pre-review states are never touched here.
 */
async function recomputeDocumentStatus(documentId: string) {
  const doc = await db.clientDocument.findUnique({
    where: { id: documentId },
    include: {
      extractions: {
        where: { status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { fields: true },
      },
    },
  })
  const extraction = doc?.extractions[0]
  if (!doc || !extraction) return
  if (doc.status !== 'UNDER_REVIEW' && doc.status !== 'MISSING_INFORMATION') return

  const spec = specForType(extraction.detectedTypeKey)
  // A human decision counts as full confidence; otherwise the AI confidence stands.
  const fields = extraction.fields.map((f) => ({
    key: f.key,
    value: f.verification === 'REJECTED' ? null : effectiveFieldValue(f),
    confidence: f.verification === 'VERIFIED' || f.verification === 'CORRECTED' ? 100 : f.confidence,
  }))
  const missing = computeMissingFieldKeys(spec, fields)
  const next = documentStatusAfterExtraction(missing)
  if (next !== doc.status) {
    await db.clientDocument.update({ where: { id: doc.id }, data: { status: next } })
  }
}

// ── Field-level review ───────────────────────────────────────────

async function setFieldVerification(
  fieldId: string,
  verification: FieldVerification,
  opts: { correctedValue?: string; note?: string },
): Promise<ActionResult> {
  const user = await actor('documents:review')
  if (!user) return forbidden

  const field = await fieldInScope(user, fieldId)
  if (!field) return { ok: false, error: 'Field not found or outside your scope.' }

  if (verification === 'VERIFIED' && !field.value?.trim() && !field.correctedValue?.trim()) {
    return { ok: false, error: 'This field has no value to verify — use Correct to enter one.' }
  }

  await db.extractedField.update({
    where: { id: field.id },
    data: {
      verification,
      correctedValue: verification === 'CORRECTED' ? opts.correctedValue : field.correctedValue,
      reviewerNote: opts.note?.trim() || field.reviewerNote,
      verifiedById: user.id,
      verifiedAt: new Date(),
    },
  })

  const docLabel = `${field.extraction.document.label ?? 'document'} v${field.extraction.document.version}`
  await recordAudit(user, {
    action: `document.field_${verification.toLowerCase()}`,
    entityType: 'ExtractedField',
    entityId: field.id,
    summary: `${verification === 'CORRECTED' ? 'Corrected' : verification === 'VERIFIED' ? 'Verified' : 'Rejected'} "${field.label}" on ${docLabel}`,
    before: { verification: field.verification, confidence: field.confidence },
    after: { verification, hasCorrection: verification === 'CORRECTED' },
  })

  await recomputeDocumentStatus(field.extraction.document.id)
  revalidate(field.extraction.document.clientId, field.extraction.document.id)
  return { ok: true }
}

export async function verifyField(fieldId: string): Promise<ActionResult> {
  const parsed = z.string().min(1).safeParse(fieldId)
  if (!parsed.success) return { ok: false, error: 'Invalid field.' }
  return setFieldVerification(parsed.data, 'VERIFIED', {})
}

const correctSchema = z.object({
  fieldId: z.string().min(1),
  value: z.string().trim().min(1, 'A corrected value is required.').max(200),
  note: z.string().max(500).optional(),
})

export async function correctField(input: { fieldId: string; value: string; note?: string }): Promise<ActionResult> {
  const parsed = correctSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid correction.' }
  return setFieldVerification(parsed.data.fieldId, 'CORRECTED', {
    correctedValue: parsed.data.value,
    note: parsed.data.note,
  })
}

const rejectFieldSchema = z.object({ fieldId: z.string().min(1), note: z.string().max(500).optional() })

export async function rejectField(input: { fieldId: string; note?: string }): Promise<ActionResult> {
  const parsed = rejectFieldSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }
  return setFieldVerification(parsed.data.fieldId, 'REJECTED', { note: parsed.data.note })
}

/**
 * Verifies every still-unverified field at or above the confidence threshold —
 * except fields carrying a conflict note, which always need human eyes.
 */
export async function bulkVerifyHighConfidence(documentId: string): Promise<ActionResult> {
  const user = await actor('documents:review')
  if (!user) return forbidden

  const doc = await db.clientDocument.findFirst({
    where: { AND: [documentScope(user), { id: documentId }] },
    include: {
      extractions: { where: { status: 'COMPLETED' }, orderBy: { createdAt: 'desc' }, take: 1, include: { fields: true } },
    },
  })
  const extraction = doc?.extractions[0]
  if (!doc || !extraction) return { ok: false, error: 'Document not found or has no completed extraction.' }

  const eligible = extraction.fields.filter(
    (f) =>
      f.verification === 'UNVERIFIED' &&
      f.confidence >= BULK_VERIFY_THRESHOLD &&
      f.value?.trim() &&
      !f.conflictNote,
  )
  if (eligible.length === 0) {
    return { ok: false, error: `No unverified, conflict-free fields at ${BULK_VERIFY_THRESHOLD}%+ confidence.` }
  }

  await db.extractedField.updateMany({
    where: { id: { in: eligible.map((f) => f.id) } },
    data: { verification: 'VERIFIED', verifiedById: user.id, verifiedAt: new Date() },
  })

  await recordAudit(user, {
    action: 'document.fields_bulk_verified',
    entityType: 'ClientDocument',
    entityId: doc.id,
    summary: `Bulk-verified ${eligible.length} field(s) at ≥${BULK_VERIFY_THRESHOLD}% confidence on ${doc.label ?? 'document'} v${doc.version}`,
    after: { fieldKeys: eligible.map((f) => f.key), threshold: BULK_VERIFY_THRESHOLD },
  })

  await recomputeDocumentStatus(doc.id)
  revalidate(doc.clientId, doc.id)
  return { ok: true, message: `Verified ${eligible.length} field(s).` }
}

// ── Document-level decisions ─────────────────────────────────────

export async function approveDocument(documentId: string): Promise<ActionResult> {
  const user = await actor('documents:review')
  if (!user) return forbidden

  const doc = await db.clientDocument.findFirst({
    where: { AND: [documentScope(user), { id: documentId }] },
    include: {
      extractions: { where: { status: 'COMPLETED' }, orderBy: { createdAt: 'desc' }, take: 1, include: { fields: true } },
    },
  })
  if (!doc) return { ok: false, error: 'Document not found or outside your scope.' }
  if (doc.status !== 'UNDER_REVIEW' && doc.status !== 'MISSING_INFORMATION') {
    return { ok: false, error: `A document in status ${doc.status} cannot be approved.` }
  }

  const extraction = doc.extractions[0]
  if (!extraction) return { ok: false, error: 'This document has no completed extraction to review.' }

  const spec = specForType(extraction.detectedTypeKey)
  const check = canApproveDocument(spec, extraction.fields as ReviewableField[])
  if (!check.ok) {
    return {
      ok: false,
      error: `Cannot approve yet — ${check.blocking.map((b) => `${b.label} ${b.reason}`).join('; ')}.`,
    }
  }

  await db.$transaction([
    db.clientDocument.update({ where: { id: doc.id }, data: { status: 'APPROVED' } }),
    db.documentReview.create({ data: { documentId: doc.id, reviewerId: user.id, decision: 'APPROVED' } }),
  ])
  await recordAudit(user, {
    action: 'document.approved',
    entityType: 'ClientDocument',
    entityId: doc.id,
    summary: `Approved ${doc.label ?? 'document'} v${doc.version} (${spec.label})`,
    before: { status: doc.status },
    after: { status: 'APPROVED', verifiedRequiredFields: spec.fields.filter((f) => f.required).map((f) => f.key) },
  })
  revalidate(doc.clientId, doc.id)
  return { ok: true, message: 'Document approved.' }
}

const rejectDocSchema = z.object({
  documentId: z.string().min(1),
  reason: z.string().trim().min(5, 'A rejection reason is required (at least 5 characters).').max(500),
})

export async function rejectDocument(input: { documentId: string; reason: string }): Promise<ActionResult> {
  const parsed = rejectDocSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }

  const user = await actor('documents:review')
  if (!user) return forbidden

  const doc = await db.clientDocument.findFirst({ where: { AND: [documentScope(user), { id: parsed.data.documentId }] } })
  if (!doc) return { ok: false, error: 'Document not found or outside your scope.' }
  if (doc.status === 'APPROVED' || doc.status === 'REJECTED') {
    return { ok: false, error: `This document is already ${doc.status.toLowerCase()}.` }
  }

  await db.$transaction([
    db.clientDocument.update({
      where: { id: doc.id },
      data: { status: 'REJECTED', rejectionReason: parsed.data.reason },
    }),
    db.documentReview.create({
      data: { documentId: doc.id, reviewerId: user.id, decision: 'REJECTED', reason: parsed.data.reason },
    }),
  ])
  await recordAudit(user, {
    action: 'document.rejected',
    entityType: 'ClientDocument',
    entityId: doc.id,
    summary: `Rejected ${doc.label ?? 'document'} v${doc.version}: ${parsed.data.reason}`,
    before: { status: doc.status },
    after: { status: 'REJECTED', reason: parsed.data.reason },
  })
  revalidate(doc.clientId, doc.id)
  return { ok: true, message: 'Document rejected.' }
}

const reuploadSchema = z.object({ documentId: z.string().min(1), note: z.string().max(500).optional() })

/**
 * Parks the current version as MISSING_INFORMATION and opens a REQUESTED
 * version N+1 the client (or a collector) can fulfil. The old file and its
 * review trail stay intact.
 */
export async function requestReupload(input: { documentId: string; note?: string }): Promise<ActionResult> {
  const parsed = reuploadSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const user = await actor('documents:review')
  if (!user) return forbidden

  const doc = await db.clientDocument.findFirst({ where: { AND: [documentScope(user), { id: parsed.data.documentId }] } })
  if (!doc) return { ok: false, error: 'Document not found or outside your scope.' }
  if (doc.status === 'APPROVED') return { ok: false, error: 'An approved document cannot be sent back for re-upload.' }
  if (!doc.storageKey) return { ok: false, error: 'This entry has no uploaded file yet — it is already awaiting upload.' }

  const openRequest = await db.clientDocument.findFirst({
    where: { clientId: doc.clientId, requirementId: doc.requirementId, status: 'REQUESTED', storageKey: null },
  })
  if (openRequest) return { ok: false, error: 'A re-upload of this document is already pending.' }

  const note = parsed.data.note?.trim() || null
  const [, requested] = await db.$transaction([
    db.clientDocument.update({ where: { id: doc.id }, data: { status: 'MISSING_INFORMATION' } }),
    db.clientDocument.create({
      data: {
        clientId: doc.clientId,
        requirementId: doc.requirementId,
        collectorId: doc.collectorId,
        status: 'REQUESTED',
        version: doc.version + 1,
        supersedesId: doc.id,
        label: doc.label,
        clientVisibleComment: note,
        slaDueAt: new Date(Date.now() + 72 * 3600_000),
      },
    }),
    db.documentReview.create({
      data: { documentId: doc.id, reviewerId: user.id, decision: 'REQUESTED', reason: note ?? 'Re-upload requested' },
    }),
  ])
  await recordAudit(user, {
    action: 'document.reupload_requested',
    entityType: 'ClientDocument',
    entityId: doc.id,
    summary: `Requested re-upload of ${doc.label ?? 'document'} (v${doc.version} → v${requested.version})${note ? `: ${note}` : ''}`,
    after: { requestedDocumentId: requested.id, note },
  })
  revalidate(doc.clientId, doc.id)
  return { ok: true, message: 'Re-upload requested.' }
}

/** Re-runs the extraction pipeline (new append-only DocumentExtraction row). */
export async function rerunExtraction(documentId: string): Promise<ActionResult> {
  const user = await actor('documents:review')
  if (!user) return forbidden

  const doc = await db.clientDocument.findFirst({ where: { AND: [documentScope(user), { id: documentId }] } })
  if (!doc) return { ok: false, error: 'Document not found or outside your scope.' }
  if (!doc.storageKey) return { ok: false, error: 'No file to extract from.' }
  if (doc.status === 'APPROVED' || doc.status === 'REJECTED') {
    return { ok: false, error: 'Finished documents are not re-extracted.' }
  }

  const result = await runExtraction(doc.id)
  await recordAudit(user, {
    action: 'document.extraction_rerun',
    entityType: 'ClientDocument',
    entityId: doc.id,
    summary: `Re-ran extraction on ${doc.label ?? 'document'} v${doc.version} — ${result.status}`,
    after: { extractionId: result.extractionId, status: result.status },
  })
  revalidate(doc.clientId, doc.id)
  return result.status === 'COMPLETED'
    ? { ok: true, message: 'Extraction completed.' }
    : { ok: false, error: result.error ?? 'Extraction failed.' }
}

// ── Requesting documents ─────────────────────────────────────────

const requestDocsSchema = z.object({
  clientId: z.string().min(1),
  requirementIds: z.array(z.string().min(1)).min(1, 'Select at least one document.'),
  collectorId: z.string().min(1).optional(),
  dueDays: z.number().int().min(1).max(60).default(3),
})

export async function requestDocuments(input: {
  clientId: string
  requirementIds: string[]
  collectorId?: string
  dueDays?: number
}): Promise<ActionResult> {
  const parsed = requestDocsSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid request.' }

  const user = await actor('documents:request')
  if (!user) return forbidden
  if (parsed.data.collectorId && !can(user, 'documents:assign_collector')) {
    return { ok: false, error: 'You cannot assign a document collector.' }
  }

  const client = await db.client.findFirst({ where: { AND: [clientScope(user), { id: parsed.data.clientId }] } })
  if (!client) return { ok: false, error: 'Client not found or outside your scope.' }

  const requirements = await db.documentRequirement.findMany({
    where: { id: { in: parsed.data.requirementIds }, package: { organizationId: user.organizationId } },
  })
  if (requirements.length !== parsed.data.requirementIds.length) {
    return { ok: false, error: 'One or more selected documents are unknown.' }
  }

  if (parsed.data.collectorId) {
    const collector = await db.user.findFirst({
      where: { id: parsed.data.collectorId, organizationId: user.organizationId, deletedAt: null, isActive: true },
    })
    if (!collector) return { ok: false, error: 'Unknown collector.' }
  }

  const slaDueAt = new Date(Date.now() + parsed.data.dueDays * 24 * 3600_000)
  let created = 0
  for (const req of requirements) {
    const open = await db.clientDocument.findFirst({
      where: { clientId: client.id, requirementId: req.id, status: { notIn: ['REJECTED', 'EXPIRED'] } },
      orderBy: { version: 'desc' },
    })
    // Already requested, uploaded, or approved — do not duplicate the ask.
    if (open) continue
    const last = await db.clientDocument.findFirst({
      where: { clientId: client.id, requirementId: req.id },
      orderBy: { version: 'desc' },
    })
    await db.clientDocument.create({
      data: {
        clientId: client.id,
        requirementId: req.id,
        collectorId: parsed.data.collectorId ?? null,
        status: 'REQUESTED',
        version: (last?.version ?? 0) + 1,
        supersedesId: last?.id ?? null,
        label: req.name,
        slaDueAt,
      },
    })
    created++
  }

  if (created === 0) return { ok: false, error: 'Each selected document is already requested or on file.' }

  await recordAudit(user, {
    action: 'document.requested',
    entityType: 'Client',
    entityId: client.id,
    summary: `Requested ${created} document(s) from ${client.firstName} ${client.lastName}${parsed.data.collectorId ? ' (collector assigned)' : ''}`,
    after: {
      requirementKeys: requirements.map((r) => r.key),
      collectorId: parsed.data.collectorId ?? null,
      dueDays: parsed.data.dueDays,
    },
  })
  revalidate(client.id)
  return { ok: true, message: `Requested ${created} document(s).` }
}
