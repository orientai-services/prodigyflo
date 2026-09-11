import 'server-only'
import { db } from '@/lib/db'
import { INTAKE_SURVEY_NAME } from '@/lib/org/bootstrap'
import { refreshCysMirror } from '@/lib/cys/data'
import { SCHEMA_VERSION, asRecord, str, type DocumentRef } from '@/lib/packet/schema'
import { sha256, validateUpload } from '@/lib/extraction/sniff'
import { getFileStorage } from '@/lib/storage'

const MAX_SCS_DOCUMENT_BYTES = 25 * 1024 * 1024
const SCS_DOWNLOAD_TIMEOUT_MS = 60_000

export function isSchema42Payload(raw: unknown): boolean {
  const top = asRecord(raw)
  const data = asRecord(top.data)
  return (
    str(data.schema_version) === SCHEMA_VERSION ||
    str(top.schema_version) === SCHEMA_VERSION ||
    Boolean(data.stage1_answers) ||
    Boolean(top.stage1_answers)
  )
}

function stage1From(raw: Record<string, unknown>) {
  const data = asRecord(raw.data)
  const answers = asRecord(raw.stage1_answers)
  const nested = asRecord(data.stage1_answers)
  return Object.keys(answers).length ? answers : nested
}

function documentsFrom(raw: Record<string, unknown>): DocumentRef[] {
  if (Array.isArray(raw.documents)) return raw.documents as DocumentRef[]
  const data = asRecord(raw.data)
  if (Array.isArray(data.documents)) return data.documents as DocumentRef[]
  const block = asRecord(data.documents)
  return Array.isArray(block.files) ? (block.files as DocumentRef[]) : []
}

type StoredScsDocument = {
  storageKey: string
  mimeType: string
  sizeBytes: number
  checksum: string
}

/**
 * SCS sends an expiring download URL. Consume it during the authenticated
 * handoff and retain an independent private copy in ProdigyFlo storage; never
 * make an expiring URL the only way to retrieve a homeowner document.
 */
async function storeScsDocument(clientId: string, ref: DocumentRef): Promise<StoredScsDocument> {
  const sourceUrl = str(ref.signed_get_url)
  if (!sourceUrl) {
    throw new Error(`SCS document "${str(ref.original_filename) || str(ref.id) || 'unknown'}" has no signed download URL.`)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SCS_DOWNLOAD_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(sourceUrl, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) throw new Error(`SCS document download failed (${response.status}).`)

  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SCS_DOCUMENT_BYTES) {
    throw new Error('SCS document exceeds the 25 MB intake limit.')
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  const validation = validateUpload({
    buffer: bytes,
    declaredMime: str(ref.mime) || response.headers.get('content-type') || '',
    maxSizeMb: 25,
    allowedMimeTypes: [],
  })
  if (!validation.ok) throw new Error(`SCS document was rejected: ${validation.reason}`)

  const fileName = (str(ref.original_filename) || str(ref.id) || 'scs-document').slice(0, 255)
  const { key } = await getFileStorage().put(bytes, {
    fileName,
    mimeType: validation.mimeType,
    clientId,
  })
  return { storageKey: key, mimeType: validation.mimeType, sizeBytes: bytes.length, checksum: sha256(bytes) }
}

export async function ingestScsPacket(opts: {
  organizationId: string
  clientId: string
  rawPayload: unknown
}): Promise<void> {
  const raw = asRecord(opts.rawPayload)
  const answers = stage1From(raw)
  if (Object.keys(answers).length === 0 && documentsFrom(raw).length === 0) return

  const survey = await db.survey.findFirst({
    where: { organizationId: opts.organizationId, name: INTAKE_SURVEY_NAME },
    select: { id: true },
  })
  if (survey && Object.keys(answers).length) {
    const existing = await db.surveyResponse.findFirst({
      where: { clientId: opts.clientId, surveyId: survey.id },
      orderBy: { updatedAt: 'desc' },
    })
    const identity =
      str(answers.first_name) &&
      str(answers.last_name) &&
      str(answers.phone) &&
      str(answers.email) &&
      str(answers.zip)
    if (existing) {
      await db.surveyResponse.update({
        where: { id: existing.id },
        data: {
          answers: answers as object,
          status: identity ? 'COMPLETED' : 'IN_PROGRESS',
          completedAt: identity ? new Date() : existing.completedAt,
        },
      })
    } else {
      await db.surveyResponse.create({
        data: {
          surveyId: survey.id,
          clientId: opts.clientId,
          answers: answers as object,
          status: identity ? 'COMPLETED' : 'IN_PROGRESS',
          completedAt: identity ? new Date() : null,
        },
      })
    }
  }

  const street = str(answers.property_street)
  const city = str(answers.city)
  if (street && city) {
    const has = await db.clientAddress.findFirst({ where: { clientId: opts.clientId } })
    if (!has) {
      await db.clientAddress.create({
        data: {
          clientId: opts.clientId,
          line1: street,
          city,
          state: str(answers.state),
          postalCode: str(answers.zip),
          isPrimary: true,
        },
      })
    }
  }

  const files = documentsFrom(raw)
  for (const f of files) {
    const fileName = str(f.original_filename) || str(f.id) || 'scs-document'
    const existing = await db.clientDocument.findFirst({
      where: { clientId: opts.clientId, fileName, label: str(f.doc_type) || undefined },
      select: { id: true, storageKey: true },
    })
    if (existing?.storageKey) continue

    // A path without a fresh URL means this handoff cannot retain its document.
    // Throwing returns a non-2xx response to SCS, whose outbox retries with a
    // newly minted URL instead of filing an unreadable metadata-only row.
    if (f.storage_path && !str(f.signed_get_url)) {
      throw new Error(`SCS document "${fileName}" has a storage path but no signed download URL.`)
    }
    const stored = await storeScsDocument(opts.clientId, f)
    const data = {
      status: 'RECEIVED' as const,
      fileName: fileName.slice(0, 255),
      storageKey: stored.storageKey,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
      scanStatus: 'clean',
      label: str(f.doc_type) || null,
      receivedAt: new Date(),
      internalComment: [
        f.storage_path ? `scs_path=${f.storage_path}` : '',
        f.id ? `scs_id=${f.id}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
    if (existing) {
      await db.clientDocument.update({ where: { id: existing.id }, data })
    } else {
      await db.clientDocument.create({ data: { clientId: opts.clientId, ...data } })
    }
  }

  try {
    await refreshCysMirror(opts.organizationId, opts.clientId)
  } catch (err) {
    console.error('[intake] cys mirror refresh failed', err)
  }
}
