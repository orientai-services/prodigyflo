import 'server-only'
import { db } from '@/lib/db'
import { INTAKE_SURVEY_NAME } from '@/lib/org/bootstrap'
import { SCHEMA_VERSION, asRecord, str, type DocumentRef } from '@/lib/packet/schema'

export function isSchema42Payload(raw: unknown): boolean {
  const data = asRecord(asRecord(raw).data)
  return str(data.schema_version) === SCHEMA_VERSION || Boolean(data.stage1_answers)
}

export async function ingestScsPacket(opts: {
  organizationId: string
  clientId: string
  rawPayload: unknown
}): Promise<void> {
  const raw = asRecord(opts.rawPayload)
  const data = asRecord(raw.data)
  const answers = asRecord(data.stage1_answers)
  if (Object.keys(answers).length === 0) return

  const survey = await db.survey.findFirst({
    where: { organizationId: opts.organizationId, name: INTAKE_SURVEY_NAME },
    select: { id: true },
  })
  if (survey) {
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

  const docsBlock = asRecord(data.documents)
  const files = Array.isArray(docsBlock.files)
    ? (docsBlock.files as DocumentRef[])
    : Array.isArray(data.documents)
      ? (data.documents as DocumentRef[])
      : []
  if (files.length) {
    await db.note.create({
      data: {
        clientId: opts.clientId,
        body: `SCS documents[] (${files.length}): ${files
          .map((f) => f.doc_type || f.original_filename || f.id)
          .join(', ')}`,
        isInternal: true,
      },
    })
  }
}
