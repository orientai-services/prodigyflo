import 'server-only'
import { queueAnalysisPacket, materializeScsAnalysis } from './scs-analysis'
import { Prisma } from '@prisma/client'
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

export function intakeAnswersFromPacket(raw: Record<string, unknown>): Record<string, unknown> {
  const data = asRecord(raw.data)
  const answers = asRecord(raw.stage1_answers)
  const nested = asRecord(data.stage1_answers)
  const stage1 = Object.keys(answers).length ? answers : nested
  const provenance = asRecord(data.stage1_provenance ?? raw.stage1_provenance)
  const humanAnswers = Object.fromEntries(Object.entries(stage1).filter(([key]) => !key.startsWith('_') && str(asRecord(provenance[key]).source) !== 'document_extraction'))
  const money = asRecord(data.money)
  const screening = asRecord(data.screening)
  const extras: Record<string, unknown> = {}
  if (humanAnswers.monthly_utility_bill == null && money.monthly_utility_bill != null) extras.monthly_utility_bill = money.monthly_utility_bill
  if (humanAnswers.credit_band == null && screening.credit_band != null) extras.credit_band = screening.credit_band
  if (humanAnswers.payment_status == null && money.payment_status != null) extras.payment_status = money.payment_status
  const merged = { ...extras, ...humanAnswers }
  const answerProvenance = Object.fromEntries(Object.keys(merged).filter(key => provenance[key]).map(key => [key, provenance[key]]))
  const dispositions=asRecord(data.questionnaire_dispositions??raw.questionnaire_dispositions)
  return {...merged,...(Object.keys(answerProvenance).length?{_scs_answer_provenance:answerProvenance}:{}),...(Object.keys(dispositions).length?{_scs_questionnaire_dispositions:dispositions}:{})}
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
}, store: Prisma.TransactionClient = db): Promise<void> {
  const raw = asRecord(opts.rawPayload)
  // Extract-backed finance stays in the immutable submission payload and in
  // document review. It must not masquerade as a homeowner's survey answer.
  const incoming = intakeAnswersFromPacket(raw)
  if (Object.keys(incoming).length === 0 && documentsFrom(raw).length === 0) return

  const survey = await store.survey.findFirst({
    where: { organizationId: opts.organizationId, name: INTAKE_SURVEY_NAME },
    select: { id: true },
  })
  let answers = incoming
  if (survey && Object.keys(incoming).length) {
    const existing = await store.surveyResponse.findFirst({
      where: { clientId: opts.clientId, surveyId: survey.id },
      orderBy: { updatedAt: 'desc' },
    })
    if (existing) {
      const prior = asRecord(existing.answers)
      answers = { ...prior, ...incoming }
      if (prior._scs_answer_provenance || incoming._scs_answer_provenance) answers._scs_answer_provenance = { ...asRecord(prior._scs_answer_provenance), ...asRecord(incoming._scs_answer_provenance) }
    }
    const identity =
      str(answers.first_name) &&
      str(answers.last_name) &&
      str(answers.phone) &&
      str(answers.email) &&
      str(answers.zip)
    if (existing) {
      await store.surveyResponse.update({
        where: { id: existing.id },
        data: {
          answers: answers as object,
          status: identity ? 'COMPLETED' : 'IN_PROGRESS',
          completedAt: identity ? new Date() : existing.completedAt,
        },
      })
    } else {
      await store.surveyResponse.create({
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
    await store.$queryRaw`SELECT id FROM "Client" WHERE id=${opts.clientId} FOR UPDATE`
    const has = await store.clientAddress.findFirst({ where: { clientId: opts.clientId, isPrimary:true } })
    const address={line1:street,city,state:str(answers.state),postalCode:str(answers.zip),isPrimary:true}
    if(has) await store.clientAddress.update({where:{id:has.id},data:address})
    else await store.clientAddress.create({data:{clientId:opts.clientId,...address}})
    if(address.state&&address.postalCode) {
      const {queuePropertyRecords}=await import('@/lib/property-records/jobs')
      await queuePropertyRecords({organizationId:opts.organizationId,clientId:opts.clientId,sourceLeadId:str(raw.lead_id),address:{line1:street,city,state:address.state,postal_code:address.postalCode}},store)
    }
  }

  const files = documentsFrom(raw)
  await queueScsDocumentImports({
    organizationId: opts.organizationId,
    clientId: opts.clientId,
    intakeSubmissionId: opts.intakeSubmissionId,
    sourceLeadId: str(raw.lead_id) || null,
    documents: files,
  }, store)

  await queueAnalysisPacket({...opts, sourceLeadId: str(raw.lead_id), analysis: asRecord(raw.data).analysis, rawPayload:raw},store)
  await store.externalDocumentImport.updateMany({
    where: {
      clientId: opts.clientId,
      sourceLeadId: str(raw.lead_id),
      status: 'IMPORTED',
      clientDocumentId: { not: null },
      NOT: { sourceAnalysis: { equals: Prisma.DbNull } },
    },
    data: { analysisPending: true, analysisAttempts: 0, analysisError: null, analysisNextAttemptAt: new Date() },
  })

  if (store !== db) return
  try {
    await materializeScsAnalysis(25, { clientId: opts.clientId, sourceLeadId: str(raw.lead_id) })
  } catch (err) {
    console.error('[intake] analysis materialize failed; durable cron will retry', err)
  }
  try {
    await refreshCysMirror(opts.organizationId, opts.clientId)
  } catch (err) {
    console.error('[intake] cys mirror refresh failed', err)
  }
}
