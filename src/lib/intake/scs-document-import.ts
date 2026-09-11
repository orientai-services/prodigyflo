import 'server-only'
import { db } from '@/lib/db'
import { getFileStorage } from '@/lib/storage'
import { runExtraction } from '@/lib/extraction/run'
import { sha256, validateUpload } from '@/lib/extraction/sniff'
import type { DocumentRef } from '@/lib/packet/schema'

const MAX_IMPORT_MB = 25
const MAX_ATTEMPTS = 8

function value(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function exportUrl(sourceDocumentId: string): string {
  const base = process.env.SCS_DOCUMENT_EXPORT_BASE_URL?.replace(/\/$/, '')
  if (!base) throw new Error('SCS_DOCUMENT_EXPORT_BASE_URL is not configured.')
  return `${base}/api/internal/prodigyflo/documents/${encodeURIComponent(sourceDocumentId)}`
}

function exportToken(): string {
  const token = process.env.SCS_DOCUMENT_EXPORT_TOKEN
  if (!token) throw new Error('SCS_DOCUMENT_EXPORT_TOKEN is not configured.')
  return token
}

/** File document metadata from the SCS event in a durable, retryable ledger. */
export async function queueScsDocumentImports(args: {
  organizationId: string
  clientId: string
  intakeSubmissionId: string
  sourceLeadId: string | null
  documents: DocumentRef[]
}): Promise<void> {
  for (const doc of args.documents) {
    const sourceDocumentId = value(doc.id)
    if (!sourceDocumentId) continue
    await db.externalDocumentImport.upsert({
      where: {
        intakeSubmissionId_sourceDocumentId: {
          intakeSubmissionId: args.intakeSubmissionId,
          sourceDocumentId,
        },
      },
      create: {
        organizationId: args.organizationId,
        intakeSubmissionId: args.intakeSubmissionId,
        clientId: args.clientId,
        sourceDocumentId,
        sourceLeadId: args.sourceLeadId,
        sourceFileName: value(doc.original_filename),
        sourceDocumentType: value(doc.doc_type),
        sourceMimeType: value(doc.mime),
        sourceSizeBytes: typeof doc.size_bytes === 'number' ? doc.size_bytes : null,
      },
      update: {
        sourceFileName: value(doc.original_filename),
        sourceDocumentType: value(doc.doc_type),
        sourceMimeType: value(doc.mime),
        sourceSizeBytes: typeof doc.size_bytes === 'number' ? doc.size_bytes : null,
      },
    })
  }
}

async function fail(id: string, error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown SCS document import error.'
  await db.externalDocumentImport.updateMany({
    where: { id, status: 'IMPORTING' },
    data: { status: 'FAILED', lastError: message.slice(0, 1000) },
  })
}

async function importOne(id: string): Promise<'imported' | 'failed' | 'skipped'> {
  let stage = 'claiming the import row'
  const claim = await db.externalDocumentImport.updateMany({
    where: { id, status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: MAX_ATTEMPTS } },
    data: { status: 'IMPORTING', attempts: { increment: 1 }, lastError: null },
  })
  if (claim.count !== 1) return 'skipped'

  try {
    stage = 'loading the import row'
    const row = await db.externalDocumentImport.findUnique({ where: { id } })
    if (!row) return 'skipped'

    stage = 'fetching the authenticated SCS export'
    const response = await fetch(exportUrl(row.sourceDocumentId), {
      headers: { 'X-SCS-Export-Token': exportToken() },
      cache: 'no-store',
      signal: AbortSignal.timeout(55_000),
    })
    if (!response.ok) throw new Error(`SCS export returned ${response.status}.`)
    if (response.headers.get('x-scs-document-id') !== row.sourceDocumentId) {
      throw new Error('SCS export document identity did not match the requested import.')
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > MAX_IMPORT_MB * 1024 * 1024) throw new Error(`SCS document exceeds ${MAX_IMPORT_MB} MB import limit.`)
    stage = 'reading and validating the exported bytes'
    const bytes = Buffer.from(await response.arrayBuffer())
    const declaredMime = response.headers.get('content-type') ?? row.sourceMimeType ?? ''
    const validation = validateUpload({
      buffer: bytes,
      declaredMime,
      maxSizeMb: MAX_IMPORT_MB,
      allowedMimeTypes: [],
    })
    if (!validation.ok) throw new Error(`SCS document was rejected: ${validation.reason}`)

    const checksum = sha256(bytes)
    const sourceChecksum = response.headers.get('x-scs-sha256')
    if (sourceChecksum && sourceChecksum !== checksum) throw new Error('SCS document checksum mismatch.')
    stage = 'copying the file into private storage'
    const { key } = await getFileStorage().put(bytes, {
      fileName: row.sourceFileName ?? 'scs-document',
      mimeType: validation.mimeType,
      clientId: row.clientId,
    })
    const now = new Date()
    stage = 'persisting the imported document'
    const doc = await db.$transaction(async (tx): Promise<{ id: string }> => {
      const imported = await tx.clientDocument.create({
        data: {
          clientId: row.clientId,
          status: 'RECEIVED',
          fileName: (row.sourceFileName ?? 'scs-document').slice(0, 255),
          storageKey: key,
          mimeType: validation.mimeType,
          sizeBytes: bytes.length,
          checksum,
          scanStatus: 'clean',
          label: (row.sourceDocumentType ?? row.sourceFileName ?? 'SCS document').slice(0, 120),
          receivedAt: now,
          internalComment: `Imported from SCS document ${row.sourceDocumentId}${row.sourceLeadId ? ` for lead ${row.sourceLeadId}` : ''}.`,
        },
      })
      await tx.externalDocumentImport.update({
        where: { id: row.id },
        data: {
          status: 'IMPORTED', clientDocumentId: doc.id, sourceChecksum,
          importedChecksum: checksum, importedAt: now, lastError: null,
        },
      })
      await tx.auditEvent.create({
        data: {
          organizationId: row.organizationId,
          actorLabel: 'SCS document importer',
          action: 'scs.document_imported',
          entityType: 'ClientDocument',
          entityId: doc.id,
          summary: `Imported SCS document ${row.sourceDocumentType ?? row.sourceFileName ?? row.sourceDocumentId}.`,
          after: { sourceDocumentId: row.sourceDocumentId, sourceLeadId: row.sourceLeadId, checksum, sizeBytes: bytes.length },
        },
      })
      return doc
    })
    // Extraction failure is retained on its own immutable run and never throws
    // away a successfully copied source file.
    await runExtraction(doc.id).catch(() => undefined)
    return 'imported'
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown SCS document import error.'
    await fail(id, new Error(`SCS import failed while ${stage}: ${detail}`))
    return 'failed'
  }
}

/** Bounded worker used by the existing Vercel five-minute job runner. */
export async function runPendingScsDocumentImports(limit = 5) {
  const rows = await db.externalDocumentImport.findMany({
    where: { status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  })
  const result = { attempted: rows.length, imported: 0, failed: 0, skipped: 0 }
  for (const row of rows) {
    const outcome = await importOne(row.id)
    if (outcome === 'imported') result.imported++
    else if (outcome === 'failed') result.failed++
    else result.skipped++
  }
  return result
}
