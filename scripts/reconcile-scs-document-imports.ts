/**
 * One-time reconciliation for SCS packets replayed before their stable case
 * identity was used. It chooses the newest ProdigyFlo client matched to each
 * SCS lead, retains one checksum-verified source copy, and suppresses only
 * redundant ledger rows. Run with --execute after reviewing the dry run.
 */
import { db } from '@/lib/db'
import { Client as PostgresClient } from 'pg'

const MAX_ATTEMPTS = 8
const execute = process.argv.includes('--execute')

type Totals = {
  sourceDocuments: number
  canonicalizable: number
  unchangedImported: number
  queuedForImport: number
  duplicateRowsToSuppress: number
  duplicateClientDocumentsToRemove: number
  movedClientDocuments: number
  unmatchedLead: number
  missingChecksum: number
  checksumConflict: number
  unmappedSourceDocument: number
  ambiguousClient: number
  humanReview: number
}

function newTotals(): Totals {
  return {
    sourceDocuments: 0,
    canonicalizable: 0,
    unchangedImported: 0,
    queuedForImport: 0,
    duplicateRowsToSuppress: 0,
    duplicateClientDocumentsToRemove: 0,
    movedClientDocuments: 0,
    unmatchedLead: 0,
    missingChecksum: 0,
    checksumConflict: 0,
    unmappedSourceDocument: 0,
    ambiguousClient: 0,
    humanReview: 0,
  }
}

function normalizeEmail(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized || null
}

function normalizePhone(value: string | null): string | null {
  const digits = value?.replace(/\D/g, '') ?? ''
  return digits.length >= 7 ? digits.slice(-10) : null
}

function contactFromPayload(raw: unknown): { email: string | null; phone: string | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { email: null, phone: null }
  const payload = raw as Record<string, unknown>
  const contact = payload.contact && typeof payload.contact === 'object' && !Array.isArray(payload.contact)
    ? payload.contact as Record<string, unknown>
    : {}
  return {
    email: typeof payload.email === 'string' ? payload.email : typeof contact.email === 'string' ? contact.email : null,
    phone: typeof payload.phone === 'string' ? payload.phone : typeof contact.phone === 'string' ? contact.phone : null,
  }
}

async function main() {
  const totals = newTotals()
  const scsDatabaseUrl = process.env.SCS_DATABASE_URL
  if (!scsDatabaseUrl) {
    throw new Error('SCS_DATABASE_URL is required. Load the SCS production database URL only for this reconciliation run.')
  }
  const scs = new PostgresClient({ connectionString: scsDatabaseUrl })
  await scs.connect()
  const sourceDocuments = await scs.query<{ id: string; lead_id: string; email: string | null; phone: string | null }>(
    `select d.id::text, d.lead_id::text, l.email, l.phone
     from documents d join leads l on l.id = d.lead_id
     where d.deleted_at is null`,
  )
  await scs.end()
  // SCS is the owner of document-to-lead assignment. Its document record is
  // therefore the authority for legacy ProdigyFlo rows that predate lead_id.
  const sourceLeadByDocument = new Map(sourceDocuments.rows.map((row) => [row.id, row]))
  const clients = await db.client.findMany({
    where: { deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, email: true, phone: true },
  })
  const clientsByEmail = new Map<string, string[]>()
  const clientsByPhone = new Map<string, string[]>()
  for (const client of clients) {
    const email = normalizeEmail(client.email)
    const phone = normalizePhone(client.phone)
    if (email) clientsByEmail.set(email, [...(clientsByEmail.get(email) ?? []), client.id])
    if (phone) clientsByPhone.set(phone, [...(clientsByPhone.get(phone) ?? []), client.id])
  }
  const submissions = await db.intakeSubmission.findMany({
    where: { source: { slug: 'scs-website' }, clientId: { not: null } },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    select: { clientId: true, updatedAt: true, rawPayload: true, mappedPayload: true },
  })
  function resolveClient(source: { email: string | null; phone: string | null }): string | null | 'ambiguous' {
    const email = normalizeEmail(source.email)
    const phone = normalizePhone(source.phone)
    const submissionMatches = submissions
      .map((submission) => {
        const raw = contactFromPayload(submission.rawPayload)
        const mapped = contactFromPayload(submission.mappedPayload)
        const emails = [normalizeEmail(raw.email), normalizeEmail(mapped.email)].filter(Boolean)
        const phones = [normalizePhone(raw.phone), normalizePhone(mapped.phone)].filter(Boolean)
        const score = Number(Boolean(email && emails.includes(email))) + Number(Boolean(phone && phones.includes(phone)))
        return { clientId: submission.clientId!, updatedAt: submission.updatedAt, score }
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime())
    // This is the legacy tie-breaker: retain the client linked to the latest
    // SCS submission whose contact identity matches the authoritative SCS lead.
    if (submissionMatches.length) return submissionMatches[0].clientId
    const emailMatches = email ? clientsByEmail.get(email) ?? [] : []
    const phoneMatches = phone ? clientsByPhone.get(phone) ?? [] : []
    if (emailMatches.length && phoneMatches.length) {
      const shared = emailMatches.filter((id) => phoneMatches.includes(id))
      return shared.length === 1 ? shared[0] : 'ambiguous'
    }
    const matches = emailMatches.length ? emailMatches : phoneMatches
    return matches.length === 1 ? matches[0] : matches.length ? 'ambiguous' : null
  }

  const rows = await db.externalDocumentImport.findMany({
    where: { intakeSubmission: { source: { slug: 'scs-website' } } },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    include: {
      intakeSubmission: { select: { rawPayload: true } },
      clientDocument: {
        select: {
          id: true,
          clientId: true,
          checksum: true,
          status: true,
          reviews: { select: { id: true }, take: 1 },
          cysValues: { select: { id: true }, take: 1 },
        },
      },
    },
  })
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const group = groups.get(row.sourceDocumentId) ?? []
    group.push(row)
    groups.set(row.sourceDocumentId, group)
  }

  for (const group of groups.values()) {
    totals.sourceDocuments++
    const source = sourceLeadByDocument.get(group[0].sourceDocumentId)
    if (!source) {
      totals.unmappedSourceDocument++
      continue
    }
    const clientResolution = resolveClient(source)
    if (clientResolution === 'ambiguous') {
      totals.ambiguousClient++
      continue
    }
    if (!clientResolution) {
      totals.unmatchedLead++
      continue
    }
    const canonicalClientId = clientResolution
    const leadId = source.lead_id

    const imported = group.filter((row) => row.status === 'IMPORTED' && row.clientDocument)
    const checksums = new Set(
      imported
        .map((row) => row.importedChecksum ?? row.clientDocument?.checksum)
        .filter((checksum): checksum is string => Boolean(checksum)),
    )
    if (imported.length && checksums.size === 0) {
      totals.missingChecksum++
      continue
    }
    if (checksums.size > 1) {
      totals.checksumConflict++
      continue
    }
    if (imported.some((row) =>
      row.clientDocument && (
        row.clientDocument.reviews.length > 0 ||
        row.clientDocument.cysValues.length > 0 ||
        row.clientDocument.status === 'APPROVED' ||
        row.clientDocument.status === 'REJECTED'
      ),
    )) {
      totals.humanReview++
      continue
    }

    const canonical =
      imported.find((row) => row.clientId === canonicalClientId) ??
      imported[0] ??
      group.find((row) => row.clientId === canonicalClientId) ??
      group[0]
    const duplicates = group.filter((row) => row.id !== canonical.id)
    const duplicateDocuments = duplicates
      .map((row) => row.clientDocument)
      .filter((document): document is NonNullable<typeof document> => Boolean(document))

    totals.canonicalizable++
    totals.duplicateRowsToSuppress += duplicates.length
    totals.duplicateClientDocumentsToRemove += duplicateDocuments.length
    if (canonical.clientDocument && canonical.clientDocument.clientId !== canonicalClientId) {
      totals.movedClientDocuments++
    }
    if (canonical.clientDocument) totals.unchangedImported++
    else totals.queuedForImport++

    if (!execute) continue
    const duplicateIds = duplicates.map((row) => row.id)
    const duplicateDocumentIds = duplicateDocuments.map((document) => document.id)
    await db.$transaction(async (tx) => {
      if (duplicateDocumentIds.length) {
        await tx.clientDocument.deleteMany({ where: { id: { in: duplicateDocumentIds } } })
      }
      await tx.externalDocumentImport.update({
        where: { id: canonical.id },
        data: canonical.clientDocument
          ? {
              clientId: canonicalClientId,
              sourceLeadId: leadId,
              status: 'IMPORTED',
              lastError: null,
            }
          : {
              clientId: canonicalClientId,
              sourceLeadId: leadId,
              status: 'PENDING',
              attempts: 0,
              lastError: null,
              clientDocumentId: null,
            },
      })
      if (canonical.clientDocument && canonical.clientDocument.clientId !== canonicalClientId) {
        await tx.clientDocument.update({
          where: { id: canonical.clientDocument.id },
          data: { clientId: canonicalClientId },
        })
      }
      if (duplicateIds.length) {
        await tx.externalDocumentImport.updateMany({
          where: { id: { in: duplicateIds } },
          data: {
            clientId: canonicalClientId,
            sourceLeadId: leadId,
            status: 'FAILED',
            attempts: MAX_ATTEMPTS,
            clientDocumentId: null,
            lastError: `Superseded by canonical SCS import ledger row ${canonical.id}.`,
          },
        })
      }
      await tx.auditEvent.create({
        data: {
          organizationId: canonical.organizationId,
          actorLabel: 'SCS document reconciliation',
          action: 'scs.document_reconciled',
          entityType: 'ExternalDocumentImport',
          entityId: canonical.id,
          summary: 'Reconciled duplicate SCS source-document ledger rows to the current matched client.',
          after: {
            sourceDocumentId: canonical.sourceDocumentId,
            sourceLeadId: canonical.sourceLeadId,
            duplicateRowsSuppressed: duplicateIds.length,
            duplicateClientDocumentsRemoved: duplicateDocumentIds.length,
            canonicalClientDocumentRetained: Boolean(canonical.clientDocument),
          },
        },
      })
    })
  }

  console.log(JSON.stringify({ mode: execute ? 'execute' : 'dry-run', ...totals }))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
