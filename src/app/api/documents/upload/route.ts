import { z } from 'zod'
import { db } from '@/lib/db'
import { can, findClientInScope, getSessionUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { getFileStorage } from '@/lib/storage'
import { sha256, validateUpload } from '@/lib/extraction/sniff'
import { planUpload } from '@/lib/extraction/versioning'
import { runExtraction } from '@/lib/extraction/run'

/**
 * Secure document upload. Acceptance is decided by magic-byte sniffing against
 * the requirement's allow-list; a re-upload becomes version N+1 superseding the
 * previous version, never an overwrite. Extraction runs before the response so
 * the caller immediately sees PROCESSING resolve into a review state.
 */

const fieldsSchema = z.object({
  clientId: z.string().min(1, 'clientId is required'),
  requirementId: z.string().min(1).optional(),
  label: z.string().max(120).optional(),
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function POST(request: Request) {
  const user = await getSessionUser()
  if (!user) return json(401, { error: 'Unauthorized' })
  if (!can(user, 'documents:upload')) return json(403, { error: 'You do not have permission to upload documents.' })

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return json(400, { error: 'Expected multipart/form-data.' })
  }

  const parsed = fieldsSchema.safeParse({
    clientId: form.get('clientId') ?? undefined,
    requirementId: form.get('requirementId') || undefined,
    label: form.get('label') || undefined,
  })
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {}
    for (const issue of parsed.error.issues) {
      const k = issue.path.join('.') || '_'
      ;(fieldErrors[k] ??= []).push(issue.message)
    }
    return json(400, { error: 'Invalid upload request.', fieldErrors })
  }
  const { clientId, requirementId, label } = parsed.data

  const file = form.get('file')
  if (!(file instanceof File)) return json(400, { error: 'A file is required.' })

  const client = await findClientInScope(user, clientId)
  if (!client) return json(403, { error: 'Client not found or outside your scope.' })

  const requirement = requirementId
    ? await db.documentRequirement.findFirst({
        where: { id: requirementId, package: { organizationId: user.organizationId } },
      })
    : null
  if (requirementId && !requirement) return json(400, { error: 'Unknown document requirement.' })

  const buffer = Buffer.from(await file.arrayBuffer())
  const validation = validateUpload({
    buffer,
    declaredMime: file.type,
    maxSizeMb: requirement?.maxSizeMb ?? 25,
    allowedMimeTypes: requirement?.allowedMimeTypes ?? [],
  })
  if (!validation.ok) return json(422, { error: validation.reason })

  const checksum = sha256(buffer)

  // Version chain: everything ever uploaded against this requirement for this client.
  const existing = requirement
    ? await db.clientDocument.findMany({
        where: { clientId, requirementId: requirement.id },
        select: { id: true, version: true, status: true, storageKey: true },
        orderBy: { version: 'asc' },
      })
    : []
  const plan = planUpload(existing)

  const { key } = await getFileStorage().put(buffer, {
    fileName: file.name,
    mimeType: validation.mimeType,
    clientId,
  })

  const data = {
    status: 'RECEIVED' as const,
    fileName: file.name.slice(0, 255),
    storageKey: key,
    mimeType: validation.mimeType,
    sizeBytes: buffer.length,
    checksum,
    scanStatus: 'clean',
    label: label ?? requirement?.name ?? file.name.slice(0, 120),
    receivedAt: new Date(),
  }

  const doc =
    plan.mode === 'fill'
      ? await db.clientDocument.update({ where: { id: plan.documentId }, data })
      : await db.clientDocument.create({
          data: {
            ...data,
            clientId,
            requirementId: requirement?.id ?? null,
            version: plan.version,
            supersedesId: plan.supersedesId,
          },
        })

  await recordAudit(user, {
    action: 'document.uploaded',
    entityType: 'ClientDocument',
    entityId: doc.id,
    summary: `Uploaded ${requirement?.name ?? 'document'} v${doc.version} (${validation.mimeType}, ${(buffer.length / 1024).toFixed(0)} KB) for ${client.firstName} ${client.lastName}`,
    after: { fileName: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes, checksum, version: doc.version, supersedesId: doc.supersedesId },
  })

  // Extraction failure must not fail the upload — it is recorded on the
  // extraction row and the document falls back to RECEIVED.
  const extraction = await runExtraction(doc.id).catch((e: Error) => ({
    extractionId: null,
    status: 'FAILED' as const,
    documentStatus: doc.status,
    missingFieldKeys: [] as string[],
    error: e.message,
  }))

  return json(200, {
    documentId: doc.id,
    version: doc.version,
    checksum,
    extraction: {
      id: extraction.extractionId,
      status: extraction.status,
      documentStatus: extraction.documentStatus,
      missingFieldKeys: extraction.missingFieldKeys,
      ...(extraction.error ? { error: extraction.error } : {}),
    },
  })
}
