import 'server-only'
import { Prisma, type IntakeSource, type IntakeSubmission } from '@prisma/client'
import { db } from '@/lib/db'
import { classifyInbound, type Classified } from '@/lib/inbound/classify'

/**
 * The Inbound RECORDING layer — it sits ON TOP of the lead pipeline, never in
 * its way. After processInbound has upserted/deduped the lead, we classify the
 * same payload (contact vs document-status vs pipeline move) and file a durable
 * InboundEvent so the Inbound workspace can organize everything a connector
 * sends — not just the deliveries that became leads.
 *
 * This runs in the public webhook path, so it MUST NEVER throw into it: every
 * write is wrapped and a failure comes back as `{ ok: false }`, leaving the
 * 200 response the caller already computed untouched.
 */

/** The ids a recorded event/document is stamped with, pulled from the source + submission. */
export type RecordIds = {
  organizationId: string
  sourceId: string
  connectorDefId: string | null
  submissionId: string | null
  clientId: string | null
}

/**
 * Pure: turn a classifier result + ids into the exact Prisma upsert for the one
 * InboundDocument row this event owns, or null when the event carries no
 * document. Keyed on (organizationId, externalId) so repeated status pushes
 * update the same row instead of piling up. `now` is injectable for tests.
 */
export function buildInboundDocumentUpsert(
  classified: Classified,
  ids: Pick<RecordIds, 'organizationId' | 'sourceId' | 'clientId'>,
  now: Date = new Date(),
): Prisma.InboundDocumentUpsertArgs | null {
  const doc = classified.document
  if (!doc) return null

  return {
    where: {
      organizationId_externalId: {
        organizationId: ids.organizationId,
        externalId: doc.externalId,
      },
    },
    create: {
      organizationId: ids.organizationId,
      sourceId: ids.sourceId,
      clientId: ids.clientId,
      externalId: doc.externalId,
      name: doc.name,
      status: doc.status,
      note: doc.note,
      url: doc.url,
      receivedAt: now,
    },
    update: {
      name: doc.name,
      status: doc.status,
      note: doc.note,
      url: doc.url,
      // A later push may finally carry the matched client; fill it, never blank it.
      ...(ids.clientId ? { clientId: ids.clientId } : {}),
      receivedAt: now,
    },
  }
}

export type RecordInboundResult = { ok: boolean }

/**
 * Record one inbound delivery as an InboundEvent (+ upsert its InboundDocument
 * when it is a document event). Non-destructive and swallow-all: any failure
 * returns { ok: false } and never propagates into the webhook response.
 */
export async function recordInboundEvent(args: {
  source: IntakeSource
  submission: Pick<IntakeSubmission, 'id' | 'clientId'>
  payload: unknown
  externalId: string
}): Promise<RecordInboundResult> {
  try {
    const { source, submission, payload, externalId } = args
    const classified = classifyInbound(payload)

    await db.inboundEvent.create({
      data: {
        organizationId: source.organizationId,
        sourceId: source.id,
        connectorDefId: source.connectorDefId,
        submissionId: submission.id,
        clientId: submission.clientId,
        category: classified.category,
        eventType: classified.eventType,
        externalId,
        summary: classified.summary,
        rawPayload: payload as Prisma.InputJsonValue,
        normalized: classified as unknown as Prisma.InputJsonValue,
      },
    })

    const upsert = buildInboundDocumentUpsert(classified, {
      organizationId: source.organizationId,
      sourceId: source.id,
      clientId: submission.clientId,
    })
    if (upsert) await db.inboundDocument.upsert(upsert)

    return { ok: true }
  } catch {
    // The webhook has already decided its 200; recording is best-effort.
    return { ok: false }
  }
}
