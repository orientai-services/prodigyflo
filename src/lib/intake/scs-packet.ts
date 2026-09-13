import 'server-only'
import { db } from '@/lib/db'
import { INTAKE_SURVEY_NAME } from '@/lib/org/bootstrap'
import { refreshCysMirror } from '@/lib/cys/data'
import { SCHEMA_VERSION, asRecord, str, type DocumentRef } from '@/lib/packet/schema'
import { queueScsDocumentImports } from './scs-document-import'

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

/**
 * SCS owns a durable case UUID. Delivery attempt IDs change every time the
 * outbound queue republishes the packet, so they must never identify the
 * ProdigyFlo intake submission for a schema-42 packet.
 */
export function scsLeadId(raw: unknown): string | null {
  return str(asRecord(raw).lead_id) || null
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

export async function ingestScsPacket(opts: {
  organizationId: string
  clientId: string
  intakeSubmissionId: string
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
  await queueScsDocumentImports({
    organizationId: opts.organizationId,
    clientId: opts.clientId,
    intakeSubmissionId: opts.intakeSubmissionId,
    sourceLeadId: str(raw.lead_id) || null,
    documents: files,
  })

  try {
    await refreshCysMirror(opts.organizationId, opts.clientId)
  } catch (err) {
    console.error('[intake] cys mirror refresh failed', err)
  }
}
