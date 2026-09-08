import { z } from 'zod'
import { db } from '@/lib/db'
import { can, getSessionUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { getFileStorage } from '@/lib/storage'
import { sha256, validateUpload } from '@/lib/extraction/sniff'
import { planUpload } from '@/lib/extraction/versioning'
import { runExtraction } from '@/lib/extraction/run'
import { portalUploadTarget } from '@/lib/portal'

/**
 * Portal-scoped document upload. The staff endpoint (/api/documents/upload)
 * requires 'documents:upload', which CLIENT deliberately lacks — this route is
 * the client's only way in, and it is narrower, not weaker:
 *
 *  - the session must be a CLIENT with a linked portal client ('portal:self')
 *  - the requirement must have been requested from THAT client (ownership)
 *  - identical validation, versioning, storage, extraction, and audit as the
 *    staff route — the same helpers, so the two paths can never drift.
 */

const fieldsSchema = z.object({
  requirementId: z.string().min(1, 'requirementId is required'),
})

/**
 * Re-upload ceiling per requirement. While a document sits in RECEIVED the
 * client may replace it, but every replacement writes storage and re-runs
 * extraction — without a cap that is an unbounded resource sink. Ten genuine
 * corrections is far beyond any real-world case; past it, staff takes over.
 */
const MAX_VERSIONS_PER_REQUIREMENT = 10

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(request: Request) {
  const user = await getSessionUser()
  if (!user) return json(401, { error: 'Please sign in again.' })
  if (!can(user, 'portal:self')) return json(403, { error: 'This upload is only available inside the client portal.' })

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return json(400, { error: 'Expected multipart/form-data.' })
  }

  const parsed = fieldsSchema.safeParse({ requirementId: form.get('requirementId') ?? undefined })
  if (!parsed.success) return json(400, { error: 'Invalid upload request.' })

  const file = form.get('file')
  if (!(file instanceof File)) return json(400, { error: 'A file is required.' })

  // Scope + ownership + status gates all live in one testable helper.
  const target = await portalUploadTarget(user, parsed.data.requirementId)
  if (!target.ok) return json(target.status, { error: target.error })
  const { client, requirement } = target

  const buffer = Buffer.from(await file.arrayBuffer())
  const validation = validateUpload({
    buffer,
    declaredMime: file.type,
    maxSizeMb: requirement.maxSizeMb,
    allowedMimeTypes: requirement.allowedMimeTypes,
  })
  if (!validation.ok) return json(422, { error: validation.reason })

  const checksum = sha256(buffer)

  // Version chain: a re-upload becomes version N+1 superseding the previous
  // version — identical planning to the staff route, never an overwrite.
  const existing = await db.clientDocument.findMany({
    where: { clientId: client.id, requirementId: requirement.id },
    select: { id: true, version: true, status: true, storageKey: true, checksum: true },
    orderBy: { version: 'asc' },
  })

  // A byte-identical re-send of the current latest file is a no-op dressed as
  // a new version — reject it before it costs storage and an extraction run.
  const latestWithFile = [...existing].reverse().find((d) => d.storageKey)
  if (latestWithFile?.checksum === checksum) {
    return json(409, { error: 'We already have this exact file — no need to upload it again.' })
  }

  const plan = planUpload(existing)
  if (plan.version > MAX_VERSIONS_PER_REQUIREMENT) {
    return json(429, { error: 'This document has been replaced too many times — please message your team so they can help directly.' })
  }

  const { key } = await getFileStorage().put(buffer, {
    fileName: file.name,
    mimeType: validation.mimeType,
    clientId: client.id,
  })

  const data = {
    status: 'RECEIVED' as const,
    fileName: file.name.slice(0, 255),
    storageKey: key,
    mimeType: validation.mimeType,
    sizeBytes: buffer.length,
    checksum,
    scanStatus: 'clean',
    label: requirement.name,
    receivedAt: new Date(),
  }

  const doc =
    plan.mode === 'fill'
      ? await db.clientDocument.update({ where: { id: plan.documentId }, data })
      : await db.clientDocument.create({
          data: {
            ...data,
            clientId: client.id,
            requirementId: requirement.id,
            version: plan.version,
            supersedesId: plan.supersedesId,
          },
        })

  await recordAudit(user, {
    action: 'document.uploaded',
    entityType: 'ClientDocument',
    entityId: doc.id,
    summary: `Client uploaded ${requirement.name} v${doc.version} via portal (${validation.mimeType}, ${(buffer.length / 1024).toFixed(0)} KB) for ${client.firstName} ${client.lastName}`,
    after: {
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      checksum,
      version: doc.version,
      supersedesId: doc.supersedesId,
      source: 'portal',
    },
  })

  // Extraction failure must not fail the upload — staff sees the outcome in
  // review; the client only needs to know their file arrived safely.
  await runExtraction(doc.id).catch(() => null)

  return json(200, { documentId: doc.id, version: doc.version })
}
