import { selectCohort } from './cohort'
import { readRestorationPolicy, policyKey, validAdmission } from './restoration-policy'
import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { getFileStorage } from '@/lib/storage'
import { runExtraction } from '@/lib/extraction/run'
import { sha256, validateUpload } from '@/lib/extraction/sniff'
import type { DocumentRef } from '@/lib/packet/schema'
import { scsRequirementId } from './scs-document-requirements'

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
}, store: Prisma.TransactionClient = db): Promise<void> {
  for (const doc of args.documents) {
    const sourceDocumentId = value(doc.id)
    if (!sourceDocumentId) continue

    const restoration = readRestorationPolicy()
    if (restoration?.excludedDocumentIds.includes(sourceDocumentId)) {
      // A held metadata entry preserves the receipt without attaching/moving
      // any existing ClientDocument or changing historical import rows.
      await store.externalDocumentImport.upsert({
        where:{intakeSubmissionId_sourceDocumentId:{intakeSubmissionId:args.intakeSubmissionId,sourceDocumentId}},
        create:{organizationId:args.organizationId,clientId:args.clientId,intakeSubmissionId:args.intakeSubmissionId,
          sourceLeadId:args.sourceLeadId,sourceDocumentId,status:'FAILED',
          lastError:'RESTORATION HOLD: historical document excluded; separate verification required.'},
        update:{},
      })
      continue
    }

    // SCS source document IDs are durable case-file provenance. A refresh may
    // arrive with a different delivery/submission id, but it must not make a
    // second client document for the same source file.
    const known = await store.externalDocumentImport.findFirst({
      where: { organizationId: args.organizationId, sourceDocumentId },
      select: { id: true, clientId: true, sourceLeadId: true },
    })
    if (known) {
      if (known.clientId !== args.clientId || (known.sourceLeadId && args.sourceLeadId && known.sourceLeadId !== args.sourceLeadId)) {
        throw new Error('Source document is already linked to another case; manual reconciliation required.')
      }
      if (!known.sourceLeadId && args.sourceLeadId) {
        await store.externalDocumentImport.update({ where: { id: known.id }, data: { sourceLeadId: args.sourceLeadId } })
      }
      continue
    }

    await store.externalDocumentImport.upsert({
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

async function fail(id: string, error: unknown, attempts?: number) {
  const message = error instanceof Error ? error.message : 'Unknown SCS document import error.'
  await db.externalDocumentImport.updateMany({
    where: { id, status: 'IMPORTING', ...(attempts === undefined ? {} : { attempts }) },
    data: { status: 'FAILED', lastError: message.slice(0, 1000) },
  })
}

async function importOne(id: string, scope: Prisma.ExternalDocumentImportWhereInput = {}): Promise<'imported' | 'failed' | 'skipped'> {
  let stage = 'claiming the import row'
  let claimedAttempts: number | undefined
  let storedKey: string | undefined
  const claim = await db.externalDocumentImport.updateMany({
    where: { ...scope, id, status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: MAX_ATTEMPTS }, NOT: {AND:[{lastError:{not:null}},{lastError:{startsWith:'RESTORATION HOLD:'}}]} },
    data: { status: 'IMPORTING', attempts: { increment: 1 }, lastError: null },
  })
  if (claim.count !== 1) return 'skipped'

  try {
    stage = 'loading the import row'
    const row = await db.externalDocumentImport.findUnique({ where: { id } })
    if (!row) return 'skipped'
    claimedAttempts = row.attempts

    // Historical replay packets could create several ledger rows for one SCS
    // source document. Once any one row has copied that durable source file,
    // suppress later rows before they can create duplicate case-file cards.
    const priorImport = await db.externalDocumentImport.findFirst({
      where: {
        organizationId: row.organizationId,
        sourceDocumentId: row.sourceDocumentId,
        status: 'IMPORTED',
        id: { not: row.id },
      },
      select: { id: true },
    })
    if (priorImport) {
      await db.externalDocumentImport.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          attempts: MAX_ATTEMPTS,
          lastError: `Duplicate SCS source document; already imported by ledger row ${priorImport.id}.`,
        },
      })
      return 'skipped'
    }

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
    if (row.sourceLeadId && response.headers.get('x-scs-lead-id') !== row.sourceLeadId) {
      throw new Error('SCS export case identity did not match the requested import.')
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > MAX_IMPORT_MB * 1024 * 1024) throw new Error(`SCS document exceeds ${MAX_IMPORT_MB} MB import limit.`)
    stage = 'reading and validating the exported bytes'
    const bytes = Buffer.from(await response.arrayBuffer())
    const p = readRestorationPolicy()
    if (p?.excludedChecksums.includes(sha256(bytes))) {
      await db.externalDocumentImport.updateMany({where:{id,status:'IMPORTING',attempts:claimedAttempts},data:{status:'FAILED',lastError:'RESTORATION HOLD: disputed document content; manual decision required.'}})
      return 'skipped'
    }
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
    stage = 'resolving the SCS upload area'
    const requirementId = await scsRequirementId(row.organizationId, row.sourceDocumentType)
    stage = 'copying the file into private storage'
    const { key } = await getFileStorage().put(bytes, {
      fileName: row.sourceFileName ?? 'scs-document',
      mimeType: validation.mimeType,
      clientId: row.clientId,
    })
    storedKey = key
    const now = new Date()
    stage = 'persisting the imported document'
    const documentId = randomUUID()
    await db.$transaction(async (store) => {
      await store.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${row.organizationId + ':' + row.sourceDocumentId}, 0))::text`
      const claim = await store.$queryRaw<{ id: string }[]>`SELECT id FROM "ExternalDocumentImport" WHERE id=${id} AND status='IMPORTING' AND attempts=${claimedAttempts} FOR UPDATE`
      if (!claim.length) throw new Error('Import lease was superseded.')
      const duplicate = await store.externalDocumentImport.findFirst({ where: {
        organizationId: row.organizationId, sourceDocumentId: row.sourceDocumentId, status: 'IMPORTED', id: { not: id },
      } })
      if (duplicate) throw new Error('Source document already imported; reconcile duplicate ledger.')
      await store.clientDocument.create({
        data: {
          id: documentId,
          clientId: row.clientId,
          requirementId,
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
      await store.externalDocumentImport.update({
        where: { id: row.id },
        data: {
          status: 'IMPORTED', clientDocumentId: documentId, sourceChecksum,
          importedChecksum: checksum, importedAt: now, lastError: null,
        },
      })
      await store.auditEvent.create({
        data: {
          organizationId: row.organizationId,
          actorLabel: 'SCS document importer',
          action: 'scs.document_imported',
          entityType: 'ClientDocument',
          entityId: documentId,
          summary: `Imported SCS document ${row.sourceDocumentType ?? row.sourceFileName ?? row.sourceDocumentId}.`,
          after: { sourceDocumentId: row.sourceDocumentId, sourceLeadId: row.sourceLeadId, checksum, sizeBytes: bytes.length },
        },
      })
    })
    storedKey = undefined
    // The copy is now durable and visible in the client's Documents tab. Do
    // not hold the import worker hostage to an AI extraction request: the
    // separately bounded extraction worker below picks this IMPORTED row up.
    // That keeps a slow model call from starving the rest of the case-file
    // backlog or making a copied document look absent.
    return 'imported'
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown SCS document import error.'
    if (storedKey) {
      try { await getFileStorage().delete(storedKey) } catch { /* isolated orphan: retain for storage reconciliation */ }
    }
    await fail(id, new Error(`SCS import failed while ${stage}: ${detail}`), claimedAttempts)
    return 'failed'
  }
}

/**
 * Build the only scope allowed through the paused one-case route. This does
 * not accept an approval from the request: the receipt must already carry a
 * valid post-cutoff admission under the active restoration policy.
 */
async function exactAdmittedScope(
  restoration: NonNullable<ReturnType<typeof readRestorationPolicy>>,
  exact: { leadId: string; documentId: string },
): Promise<Prisma.ExternalDocumentImportWhereInput> {
  if (restoration.excludedCaseIds.includes(exact.leadId) || restoration.excludedDocumentIds.includes(exact.documentId)) {
    throw new Error('Exact case or document is excluded from restoration.')
  }

  const admission = await db.externalDocumentImport.findFirst({
    where: {
      organizationId: restoration.organizationId,
      sourceLeadId: exact.leadId,
      sourceDocumentId: exact.documentId,
      intakeSubmission: { sourceId: restoration.sourceId },
    },
    select: { intakeSubmission: { select: { rawPayload: true } } },
  })
  const payload = admission?.intakeSubmission.rawPayload
  const recordedAdmission = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>).restoration_admission
    : undefined
  if (!validAdmission(restoration, recordedAdmission, exact.leadId)) {
    throw new Error('Exact case does not have a valid post-cutoff restoration admission.')
  }

  return {
    organizationId: restoration.organizationId,
    sourceLeadId: exact.leadId,
    sourceDocumentId: exact.documentId,
    intakeSubmission: {
      sourceId: restoration.sourceId,
      rawPayload: { path: ['restoration_admission', 'policy'], equals: policyKey(restoration) },
    },
  }
}

/** Bounded worker used by the existing Vercel five-minute job runner. */
export async function runPendingScsDocumentImports(limit = 5, exact?: { leadId: string; documentId: string }) {
  // Receipt and document metadata queueing remain enabled during repair.
  const restoration = readRestorationPolicy()
  if (restoration && !exact && process.env.SCS_DOCUMENT_IMPORTS_PAUSED === 'true') return {attempted:0,imported:0,failed:0,skipped:0}
  let scope: Prisma.ExternalDocumentImportWhereInput
  if (exact) {
    if (!restoration) throw new Error('Restoration policy required for one-case execution.')
    scope = await exactAdmittedScope(restoration, exact)
  } else {
    const cohort = selectCohort(process.env.SCS_IMPORT_EXECUTION_COHORT, process.env.SCS_DOCUMENT_IMPORTS_PAUSED === 'true')
    if (!restoration && process.env.SCS_IMPORT_REQUIRE_COHORT === 'true' && cohort === undefined) throw Error('Execution cohort required');
    if (cohort === null) return { attempted: 0, imported: 0, failed: 0, skipped: 0 }
    if (cohort && (!cohort.organizationId || !cohort.sourceId)) throw Error('Organization and source required')
    scope = cohort ? { organizationId: cohort.organizationId, intakeSubmission: { sourceId: cohort.sourceId }, OR: cohort.cases.map(x => ({ sourceLeadId: x.leadId, sourceDocumentId: { in: x.documentIds } })) } : {}
  }
  if (restoration && !exact) {
    const prior = {...scope}
    Object.keys(scope).forEach(k => delete (scope as Record<string,unknown>)[k])
    scope.AND = [prior,{organizationId:restoration.organizationId,sourceLeadId:{notIn:restoration.excludedCaseIds},sourceDocumentId:{notIn:restoration.excludedDocumentIds},
      intakeSubmission:{sourceId:restoration.sourceId,rawPayload:{path:['restoration_admission','policy'],equals:policyKey(restoration)}}}]
  }
  // Older than the maximum serverless invocation: reclaim only abandoned
  // claims. Exhausted work remains FAILED and requires an explicit decision.
  await db.externalDocumentImport.updateMany({
    where: { ...scope, status: 'IMPORTING', updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    data: { status: 'FAILED', lastError: 'Import worker interrupted; bounded retry pending.' },
  })
  const rows = await db.externalDocumentImport.findMany({
    where: { ...scope, status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: MAX_ATTEMPTS }, NOT: {AND:[{lastError:{not:null}},{lastError:{startsWith:'RESTORATION HOLD:'}}]} },
    // New customer uploads are time-sensitive. Prioritize fresh documents and
    // newest first-attempt work; failed rows remain retryable behind it.
    orderBy: [{ attempts: 'asc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(limit, 1), 5),
    select: { id: true },
  })
  const result = { attempted: rows.length, imported: 0, failed: 0, skipped: 0 }
  for (const row of rows) {
    if (!exact && selectCohort(process.env.SCS_IMPORT_EXECUTION_COHORT, process.env.SCS_DOCUMENT_IMPORTS_PAUSED === 'true') === null) break
    if (restoration && policyKey(readRestorationPolicy()!) !== policyKey(restoration)) throw Error('Restoration policy changed')
    const outcome = await importOne(row.id, scope)
    if (outcome === 'imported') result.imported++
    else if (outcome === 'failed') result.failed++
    else result.skipped++
  }
  return result
}

/**
 * Backfill documents imported while extraction was running in labelled mock
 * mode. This is deliberately narrow: only SCS imports whose document has no
 * Anthropic result are eligible, and finalized review decisions are never
 * changed. Each call to runExtraction creates a new immutable run, preserving
 * the original mock result for audit.
 */
export async function runPendingScsDocumentExtractions(limit = 5) {
  const staleBefore = new Date(Date.now() - 5 * 60_000)
  // A serverless invocation can end after the model call was started. Release
  // that durable claim so the document is not stranded in RUNNING forever.
  await db.documentExtraction.updateMany({
    where: {
      provider: 'anthropic',
      status: 'RUNNING',
      startedAt: { lt: staleBefore },
    },
    data: {
      status: 'FAILED',
      error: 'Anthropic document extraction exceeded the bounded worker timeout; retry scheduled.',
      completedAt: new Date(),
    },
  })

  const rows = await db.externalDocumentImport.findMany({
    where: {
      status: 'IMPORTED',
      clientDocumentId: { not: null },
      clientDocument: {
        status: { notIn: ['APPROVED', 'REJECTED'] },
        AND: [
          // A failed run is retryable; completed and currently-running runs
          // are not. The stale-run sweep above releases abandoned claims.
          { extractions: { none: { provider: 'anthropic', status: { in: ['COMPLETED', 'RUNNING'] } } } },
          {
            OR: [
              { extractions: { none: {} } },
              { extractions: { some: { provider: 'mock' } } },
            ],
          },
        ],
      },
    },
    // A fresh upload should never wait behind an old mock-only backlog.
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { clientDocumentId: true },
  })

  const result = { attempted: rows.length, completed: 0, failed: 0, skipped: 0 }
  for (const row of rows) {
    if (!row.clientDocumentId) {
      result.skipped++
      continue
    }
    try {
      const extraction = await runExtraction(row.clientDocumentId)
      if (extraction.status === 'COMPLETED') result.completed++
      else result.failed++
    } catch {
      result.failed++
    }
  }
  return result
}
