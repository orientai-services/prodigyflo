import 'server-only'
import { IntakeStatus, Prisma, type IntakeSource, type IntakeSubmission } from '@prisma/client'
import { db } from '@/lib/db'
import { isRetiredIdentity, RetiredIntakeError } from '@/lib/retired-identities'
import { parseIntakeBooking } from '@/lib/intake/appointment'
import type { SchedulingResult } from '@/lib/scheduling'
import { redactForAudit } from '@/lib/audit'
import {
  applyMapping,
  missingRequiredFields,
  normalizePhone,
  type MappedLead,
} from '@/lib/intake/mapping'
import { getSheetsProvider } from '@/lib/intake/sheets'
import { isSchema42Payload, scsLeadId } from '@/lib/intake/scs-packet'
import type { DuplicateMatch } from '@/lib/intake/dedupe-bridge'

/** Who triggered the pipeline — null for the public webhook. */
export type IntakeActor = { id: string; name: string; roleName: string } | null

export type ApplyOutcome = {
  status: IntakeStatus
  clientId: string | null
  createdClient: boolean
  matchedOn: string | null
  mapped: MappedLead
  unmappedKeys: string[]
  error: string | null
}

/**
 * The shared CRM dedupe module is loaded lazily so intake keeps working (via
 * the local matcher below) if `@/lib/dedupe` is missing or incompatible.
 */
async function loadDedupeBridge() {
  try {
    return await import('@/lib/intake/dedupe-bridge')
  } catch {
    return null
  }
}

/** Conservative fallback matcher honouring the source's dedupe-key order. */
async function localFindDuplicates(
  organizationId: string,
  mapped: MappedLead,
  dedupeKeys: string[],
  store: Prisma.TransactionClient = db,
): Promise<DuplicateMatch[]> {
  for (const key of dedupeKeys) {
    if (key === 'email' && mapped.email) {
      const hit = await store.client.findFirst({
        where: { organizationId, deletedAt: null, email: { equals: mapped.email, mode: 'insensitive' } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      })
      if (hit) return [{ clientId: hit.id, matchedOn: 'email' }]
    }
    if (key === 'phone' && mapped.phone) {
      const digits = normalizePhone(mapped.phone)
      if (digits.length >= 7) {
        const rows = await store.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Client"
          WHERE "organizationId" = ${organizationId}
            AND "deletedAt" IS NULL
            AND regexp_replace(phone, '\\D', '', 'g') LIKE ${'%' + digits}
          ORDER BY "createdAt" ASC
          LIMIT 1`
        if (rows.length) return [{ clientId: rows[0].id, matchedOn: 'phone' }]
      }
    }
    if (key === 'name' && mapped.firstName && mapped.lastName) {
      const hit = await store.client.findFirst({
        where: {
          organizationId,
          deletedAt: null,
          firstName: { equals: mapped.firstName, mode: 'insensitive' },
          lastName: { equals: mapped.lastName, mode: 'insensitive' },
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      })
      if (hit) return [{ clientId: hit.id, matchedOn: 'name' }]
    }
  }
  return []
}

const MERGEABLE_FIELDS = [
  'firstName', 'lastName', 'email', 'phone', 'preferredLanguage',
  'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent',
] as const

/** Fill blanks only — inbound data never overwrites an existing value. */
function localMergeChanges(
  existing: Record<string, unknown>,
  mapped: MappedLead,
): Record<string, string> {
  const changes: Record<string, string> = {}
  for (const field of MERGEABLE_FIELDS) {
    const incoming = mapped[field as keyof MappedLead]
    const current = existing[field]
    if (incoming && (current === null || current === undefined || current === '')) {
      changes[field] = incoming
    }
  }
  return changes
}

function parseMoney(value: string | undefined): string | null {
  if (!value) return null
  const n = Number.parseFloat(value.replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n.toFixed(2) : null
}

async function writeAudit(
  organizationId: string,
  source: IntakeSource,
  actor: IntakeActor,
  input: { action: string; entityType: string; entityId?: string | null; summary: string; after?: Record<string, unknown> },
  store: Prisma.TransactionClient = db,
) {
  await store.auditEvent.create({
    data: {
      organizationId,
      actorId: actor?.id ?? null,
      actorLabel: actor ? `${actor.name} (${actor.roleName})` : `Intake: ${source.name}`,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary,
      after: (input.after ? redactForAudit(input.after) : undefined) as never,
    },
  })
}

/**
 * Map one raw payload and apply it to the CRM: update the matched client, or
 * create a new one on the default pipeline's first stage. Transactional callers
 * receive thrown failures so partial CRM changes cannot commit.
 */
export async function applyToCrm(
  source: IntakeSource,
  rawPayload: unknown,
  opts: { overrideMapping?: Record<string, string>; actor?: IntakeActor; clientId?: string | null; strictScs?: boolean } = {},
  store: Prisma.TransactionClient = db,
): Promise<ApplyOutcome> {
  const fieldMapping = {
    ...((source.fieldMapping ?? {}) as Record<string, string>),
    ...(opts.overrideMapping ?? {}),
  }
  const { mapped, unmappedKeys } = applyMapping(fieldMapping, rawPayload)
  const base = { mapped, unmappedKeys, createdClient: false, matchedOn: null, clientId: null }

  const missing = missingRequiredFields(mapped)
  if (missing.length) {
    return {
      ...base,
      status: IntakeStatus.NEEDS_MAPPING,
      error: `Missing required field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. Map the incoming keys that carry them, then retry.`,
    }
  }

  try {
    // Prefer the shared CRM dedupe; fall back to the local matcher when it is
    // unavailable or returns something unrecognisable.
    const bridge = await loadDedupeBridge()
    let matches: DuplicateMatch[] | null = null
    if (bridge) {
      matches = await bridge.sharedFindDuplicates({
        organizationId: source.organizationId,
        email: mapped.email,
        phone: mapped.phone,
        firstName: mapped.firstName,
        lastName: mapped.lastName,
        postalCode: mapped.postalCode,
        dedupeKeys: source.dedupeKeys,
      }, store)
    }
    if (matches === null) {
      matches = await localFindDuplicates(source.organizationId, mapped, source.dedupeKeys, store)
    }

    if (opts.clientId) {
      matches = [{ clientId: opts.clientId, matchedOn: 'source case id' }]
    } else if (opts.strictScs) {
      // Do not MERGE a property case on email/phone/name alone. Ignore those
      // hits and create a new Client (same path as no matches). Never attach
      // onto an existing id from contact similarity.
      matches = []
    }

    if (matches.length > 0) {
      const match = matches[0]
      const existing = await store.client.findFirst({
        where: { id: match.clientId, organizationId: source.organizationId, deletedAt: null },
      })
      if (existing) {
        let changes =
          (bridge && (await bridge.sharedMergeIncoming(existing as unknown as Record<string, unknown>, mapped))) ??
          localMergeChanges(existing as unknown as Record<string, unknown>, mapped)
        // Whatever produced the changes, never let inbound data clobber a value.
        changes = Object.fromEntries(
          Object.entries(changes).filter(([k, v]) => {
            // A connector bridge may return fields that belong to a related
            // record (for example city or addressLine1). Only columns on
            // Client may be sent to this update; address data is handled by
            // the dedicated ClientAddress path when a client is created.
            if (!MERGEABLE_FIELDS.includes(k as (typeof MERGEABLE_FIELDS)[number])) return false
            const current = (existing as unknown as Record<string, unknown>)[k]
            return typeof v === 'string' && (current === null || current === undefined || current === '')
          }),
        )
        await store.client.update({
          where: { id: existing.id },
          data: { ...(changes as Prisma.ClientUpdateInput), lastActivityAt: new Date() },
        })
        await writeAudit(source.organizationId, source, opts.actor ?? null, {
          action: 'intake.client_matched',
          entityType: 'Client',
          entityId: existing.id,
          summary: `Inbound lead from "${source.name}" matched existing client on ${match.matchedOn}${Object.keys(changes).length ? `; filled ${Object.keys(changes).join(', ')}` : ''}`,
          after: changes as Record<string, unknown>,
        }, store)
        return { ...base, status: IntakeStatus.DUPLICATE, clientId: existing.id, matchedOn: match.matchedOn, error: null }
      }
    }

    if (opts.clientId) throw new Error('Bound SCS client is unavailable; reconciliation required.')

    // Intake sources are tenant-scoped, but a relational foreign key alone
    // cannot prove a configured team belongs to the same tenant. Treat a
    // stale or cross-tenant ID as unassigned rather than leaking queue access.
    const defaultTeam = source.defaultTeamId
      ? await store.team.findFirst({
          where: { id: source.defaultTeamId, organizationId: source.organizationId, deletedAt: null },
          select: { id: true },
        })
      : null

    const defaultCloser = source.defaultOwnerId
      ? await store.user.findFirst({ where: { id: source.defaultOwnerId, organizationId: source.organizationId, isActive: true, deletedAt: null, role: { key: 'CLOSER' } }, select: { id: true } })
      : null

    const pipeline =
      (await store.pipeline.findFirst({
        where: { organizationId: source.organizationId, isDefault: true },
        include: { stages: { orderBy: { position: 'asc' }, take: 1 } },
      })) ??
      (await store.pipeline.findFirst({
        where: { organizationId: source.organizationId },
        include: { stages: { orderBy: { position: 'asc' }, take: 1 } },
      }))
    const firstStage = pipeline?.stages[0]
    if (!pipeline || !firstStage) {
      return { ...base, status: IntakeStatus.FAILED, error: 'No pipeline with stages exists for this organization.' }
    }

    const client = await store.client.create({
      data: {
        organizationId: source.organizationId,
        pipelineId: pipeline.id,
        currentStageId: firstStage.id,
        firstName: mapped.firstName!,
        lastName: mapped.lastName!,
        email: mapped.email ?? '',
        phone: mapped.phone ?? '',
        preferredLanguage: mapped.preferredLanguage?.toLowerCase().slice(0, 2) || 'en',
        ownerId: defaultCloser?.id ?? null,
        teamId: defaultTeam?.id ?? null,
        leadSourceId: source.defaultLeadSourceId,
        utmSource: mapped.utmSource ?? null,
        utmMedium: mapped.utmMedium ?? null,
        utmCampaign: mapped.utmCampaign ?? null,
        utmTerm: mapped.utmTerm ?? null,
        utmContent: mapped.utmContent ?? null,
        estimatedValue: parseMoney(mapped.estimatedValue),
        stageEnteredAt: new Date(),
        lastActivityAt: new Date(),
      },
    })

    await store.stageHistory.create({
      data: {
        clientId: client.id,
        stageId: firstStage.id,
        fromKey: null,
        toKey: firstStage.key,
        automated: true,
        reason: `Created by intake source "${source.name}"`,
        changedById: opts.actor?.id ?? null,
      },
    })

    if (mapped.addressLine1 && mapped.city) {
      await store.clientAddress.create({
        data: {
          clientId: client.id,
          line1: mapped.addressLine1,
          line2: mapped.addressLine2 ?? null,
          city: mapped.city,
          state: mapped.state ?? '',
          postalCode: mapped.postalCode ?? '',
        },
      })
    }

    if (mapped.note) {
      await store.note.create({
        data: { clientId: client.id, body: `From intake "${source.name}": ${mapped.note}`, isInternal: true },
      })
    }

    await writeAudit(source.organizationId, source, opts.actor ?? null, {
      action: 'intake.client_created',
      entityType: 'Client',
      entityId: client.id,
      summary: `Lead created from intake source "${source.name}"`,
      after: mapped as Record<string, unknown>,
    }, store)

    return { ...base, status: IntakeStatus.APPLIED, clientId: client.id, createdClient: true, error: null }
  } catch (error) {
    // A transaction must not commit a partially created client after a later
    // write fails. The sender retains its delivery until this transaction wins.
    if (store !== db) throw error
    return {
      ...base,
      status: IntakeStatus.FAILED,
      error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error applying submission.',
    }
  }
}

export type InboundResult = { duplicate: boolean; submission: IntakeSubmission; booking?: SchedulingResult | null }

/**
 * Idempotent entry point shared by the webhook and the sheet sync. Ordinary
 * replays are returned as-is; schema-42 SCS packets intentionally refresh the
 * same submission as their homeowner data and documents evolve.
 */
function sourceTime(packet: Record<string, unknown>): number | null {
  const data = packet.data as Record<string, unknown> | undefined
  const value = data?.last_activity_at
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

export async function processInbound(
  source: IntakeSource, externalId: string, rawPayload: unknown, actor: IntakeActor = null,
): Promise<InboundResult> {
  if (await isRetiredIdentity([['intake:'+source.id, externalId], ['scs-lead', source.slug === 'scs-website' ? scsLeadId(rawPayload) : null], ['calendly-event', parseIntakeBooking(rawPayload)?.externalEventId]])) throw new RetiredIntakeError()
  const result = source.slug === 'scs-website'
    ? await db.$transaction(
      store => processInboundLocked(source, externalId, rawPayload, actor, store),
      { timeout: 20_000, maxWait: 20_000 },
    )
    : await processInboundLocked(source, externalId, rawPayload, actor, db)
  if (!result.duplicate && result.submission.clientId && source.slug === 'scs-website') {
    const { refreshCysMirror } = await import('@/lib/cys/data')
    try { await refreshCysMirror(source.organizationId, result.submission.clientId) } catch { /* derived view; receipt is durable */ }
  }
  return result
}

async function processInboundLocked(
  source: IntakeSource,
  externalId: string,
  rawPayload: unknown,
  actor: IntakeActor,
  store: Prisma.TransactionClient,
): Promise<InboundResult> {
  // Transaction-scoped lock serializes this source's updates across processes.
  // No network, document copy or AI runs while the lock is held.
  if (store !== db) await store.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${source.id}, 0))::text`
  let booking: SchedulingResult | null = null
  const key = { sourceId_externalId: { sourceId: source.id, externalId } }
  // SCS emits a new packet as a homeowner adds documents or confirms extracted
  // values. Those packets share the lead ID, so they must refresh an existing
  // submission instead of being discarded as an ordinary webhook replay.
  const isScsPacket = source.slug === 'scs-website' && isSchema42Payload(rawPayload)

  let existing = await store.intakeSubmission.findUnique({ where: key })
  const packet = rawPayload as Record<string, unknown>
  let boundClientId = existing?.clientId ?? null
  if (isScsPacket && scsLeadId(rawPayload) && !existing) {
    // Upgrade only an exact prior delivery or exact authenticated portal link.
    // Never infer a property identity from email/phone or merge conflicting cases.
    const candidates = await store.intakeSubmission.findMany({
      where: { sourceId: source.id, OR: [
        ...(typeof packet.id === 'string' ? [{ externalId: packet.id }] : []),
        ...(typeof packet.portal_url === 'string' && packet.portal_url ? [{ rawPayload: { path: ['portal_url'], equals: packet.portal_url } }] : []),
      ] },
      orderBy: { createdAt: 'asc' },
    })
    const ids = new Set(candidates.map(row => row.clientId).filter(Boolean))
    if (ids.size > 1) throw new Error('Conflicting historical SCS bindings; reconcile before retry.')
    const incomingTime = sourceTime(packet)
    if (candidates.some(row => {
      const knownTime = sourceTime(row.rawPayload as Record<string, unknown>)
      return knownTime !== null && (incomingTime === null || knownTime > incomingTime)
    })) throw new Error('Stale historical SCS packet; reconcile the newest receipt before retry.')
    boundClientId = candidates.find(row => row.clientId)?.clientId ?? null
    // Reuse the earliest receipt, retaining first receipt time and document FKs.
    if (candidates.length) {
      existing = await store.intakeSubmission.update({ where: { id: candidates[0].id }, data: { externalId, clientId: boundClientId } })
    }
  }
  if (existing && isScsPacket) {
    const old = existing.rawPayload as Record<string, unknown>
    if (old.stage0_synthetic === true) packet.stage0_synthetic = true
    const oldTime = sourceTime(old)
    const newTime = sourceTime(packet)
    const completed = !['FAILED', 'RECEIVED', 'NEEDS_MAPPING'].includes(existing.status)
    if (oldTime !== null && (newTime === null || newTime < oldTime)) {
      if (existing.clientId) {
        const { upsertIntakeAppointment } = await import('@/lib/intake/appointment')
        booking = await upsertIntakeAppointment({ source, clientId: existing.clientId, rawPayload, store })
      }
      return { duplicate: true, submission: existing, booking }
    }
    if (completed && newTime === oldTime && typeof packet.id === 'string' && packet.id === old.id) {
      if (existing.clientId) {
        const { upsertIntakeAppointment } = await import('@/lib/intake/appointment')
        booking = await upsertIntakeAppointment({ source, clientId: existing.clientId, rawPayload, store })
      }
      return { duplicate: true, submission: existing, booking }
    }
  }
  // A failed SCS document copy must be resumeable. Treating it as a duplicate
  // would leave an otherwise valid packet stranded behind an expired source URL.
  // RECEIVED means a server was interrupted before it could record an outcome
  // (for example, while copying a large SCS document). It must resume on the
  // sender's retry, not be mistaken for a completed duplicate.
  if (
    existing &&
    !isScsPacket &&
    existing.status !== IntakeStatus.FAILED &&
    existing.status !== IntakeStatus.RECEIVED
  ) {
    return { duplicate: true, submission: existing, booking }
  }

  let submission: IntakeSubmission
  if (existing) {
    // Preserve the newest complete SCS packet as the durable intake record.
    // Its document URLs are short lived, but the packet's answers and document
    // provenance are retained while ingestScsPacket copies the actual bytes.
    submission = await store.intakeSubmission.update({
      where: { id: existing.id },
      data: {
        status: IntakeStatus.RECEIVED,
        rawPayload: rawPayload as Prisma.InputJsonValue,
        error: null,
        attemptCount: { increment: 1 },
      },
    })
  } else {
    try {
      submission = await store.intakeSubmission.create({
        data: {
          organizationId: source.organizationId,
          sourceId: source.id,
          externalId,
          status: IntakeStatus.RECEIVED,
          rawPayload: rawPayload as Prisma.InputJsonValue,
        },
      })
    } catch (error) {
      // Two concurrent deliveries of the same payload: the loser of the unique
      // race treats the row the winner created as the replay it is.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await store.intakeSubmission.findUnique({ where: key })
        if (raced) return { duplicate: true, submission: raced }
      }
      throw error
    }
  }

  try {
    const outcome = await applyToCrm(source, rawPayload, {
      actor, clientId: boundClientId, strictScs: isScsPacket && Boolean(scsLeadId(rawPayload)),
    }, store)
    if (outcome.clientId && isScsPacket) {
      const { ingestScsPacket } = await import('@/lib/intake/scs-packet')
      await ingestScsPacket({ organizationId: source.organizationId, clientId: outcome.clientId,
        intakeSubmissionId: submission.id, rawPayload }, store)
      const { upsertIntakeAppointment } = await import('@/lib/intake/appointment')
      booking = await upsertIntakeAppointment({ source, clientId: outcome.clientId, rawPayload, store })
    }
    submission = await store.intakeSubmission.update({
      where: { id: submission.id },
      data: {
        status: outcome.status,
        mappedPayload: outcome.mapped as Prisma.InputJsonValue,
        unmappedKeys: outcome.unmappedKeys,
        clientId: outcome.clientId,
        createdClient: outcome.createdClient,
        matchedOn: outcome.matchedOn,
        error: outcome.error,
        processedAt: new Date(),
      },
    })
  } catch (error) {
    await store.intakeSubmission.update({
      where: { id: submission.id },
      data: {
        status: IntakeStatus.FAILED,
        error: error instanceof Error ? error.message.slice(0, 500) : 'SCS packet ingest failed.',
        processedAt: new Date(),
      },
    })
    throw error
  }
  return { duplicate: false, submission, booking }
}

/**
 * Re-run the apply pipeline for a stuck submission (FAILED / NEEDS_MAPPING),
 * optionally with extra mappings for this one payload.
 */
export async function reapplySubmission(
  submission: IntakeSubmission,
  source: IntakeSource,
  opts: { overrideMapping?: Record<string, string>; actor?: IntakeActor } = {},
): Promise<IntakeSubmission> {
  if (source.slug === 'scs-website' && isSchema42Payload(submission.rawPayload)) {
    const configured = { ...source, fieldMapping: {
      ...((source.fieldMapping ?? {}) as Record<string, string>), ...opts.overrideMapping,
    } }
    return (await processInbound(configured, submission.externalId, submission.rawPayload, opts.actor ?? null)).submission
  }
  const outcome = await applyToCrm(source, submission.rawPayload, opts)
  return db.intakeSubmission.update({
    where: { id: submission.id },
    data: {
      status: outcome.status,
      mappedPayload: outcome.mapped as Prisma.InputJsonValue,
      unmappedKeys: outcome.unmappedKeys,
      clientId: outcome.clientId ?? submission.clientId,
      createdClient: outcome.createdClient || submission.createdClient,
      matchedOn: outcome.matchedOn ?? submission.matchedOn,
      error: outcome.error,
      attemptCount: { increment: 1 },
      processedAt: new Date(),
    },
  })
}

export type SheetSyncResult = {
  ok: boolean
  synced: number
  applied: number
  duplicates: number
  needsMapping: number
  failed: number
  alreadySeen: number
  cursor: number
  message: string
}

/**
 * Pull rows past the cursor through the same apply pipeline. externalId is
 * `row:<n>`, so re-running a sync (or resetting the cursor) is a no-op for
 * rows already ingested.
 */
export async function runSheetSync(source: IntakeSource, actor: IntakeActor = null): Promise<SheetSyncResult> {
  const fail = async (message: string): Promise<SheetSyncResult> => {
    await db.intakeSource.update({
      where: { id: source.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: 'error', lastError: message, lastErrorAt: new Date() },
    })
    return { ok: false, synced: 0, applied: 0, duplicates: 0, needsMapping: 0, failed: 0, alreadySeen: 0, cursor: source.lastRowCursor, message }
  }

  if (source.kind !== 'GOOGLE_SHEET') return fail('This source is not a Google Sheet.')
  if (!source.sheetId) return fail('No sheet ID configured.')

  let rows
  try {
    rows = await getSheetsProvider().listRows(source.sheetId, source.sheetTab ?? 'Sheet1', source.lastRowCursor + 1)
  } catch (error) {
    return fail(error instanceof Error ? error.message.slice(0, 500) : 'Sheet provider error.')
  }

  const counts = { applied: 0, duplicates: 0, needsMapping: 0, failed: 0, alreadySeen: 0 }
  let cursor = source.lastRowCursor
  for (const row of rows) {
    const { duplicate, submission } = await processInbound(source, `row:${row.rowNumber}`, row.values, actor)
    if (duplicate) counts.alreadySeen += 1
    else if (submission.status === IntakeStatus.APPLIED) counts.applied += 1
    else if (submission.status === IntakeStatus.DUPLICATE) counts.duplicates += 1
    else if (submission.status === IntakeStatus.NEEDS_MAPPING) counts.needsMapping += 1
    else counts.failed += 1
    cursor = Math.max(cursor, row.rowNumber)
  }

  const message =
    rows.length === 0
      ? 'No new rows.'
      : `${rows.length} row${rows.length === 1 ? '' : 's'}: ${counts.applied} created, ${counts.duplicates} matched, ${counts.needsMapping} need mapping, ${counts.failed} failed${counts.alreadySeen ? `, ${counts.alreadySeen} already seen` : ''}.`

  await db.intakeSource.update({
    where: { id: source.id },
    data: {
      lastRowCursor: cursor,
      lastSyncAt: new Date(),
      lastSyncStatus: message,
      lastError: null,
    },
  })

  await writeAudit(source.organizationId, source, actor, {
    action: 'intake.sheet_synced',
    entityType: 'IntakeSource',
    entityId: source.id,
    summary: `Sheet sync for "${source.name}" — ${message}`,
  })

  return { ok: true, synced: rows.length, ...counts, cursor, message }
}
