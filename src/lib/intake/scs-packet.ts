import 'server-only'
import { queueAnalysisPacket, materializeScsAnalysis } from './scs-analysis'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { INTAKE_SURVEY_NAME } from '@/lib/org/bootstrap'
import { refreshCysMirror } from '@/lib/cys/data'
import { SCHEMA_VERSION, asRecord, str, type DocumentRef } from '@/lib/packet/schema'
import { queueScsDocumentImports, retireSupersededScsDocuments } from './scs-document-import'
import { profileAddressAfterPacket } from './property-identity'
import { verifyIntakeToken } from '@/lib/call-center/intake-link'
import { applyLeadLink, type AssistedIntake } from '@/lib/call-center/possible-match'

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
  if (humanAnswers.paying_both == null && money.paying_both != null) extras.paying_both = money.paying_both
  if (humanAnswers.credit_band == null && screening.credit_band != null) extras.credit_band = screening.credit_band
  if (humanAnswers.payment_status == null && money.payment_status != null) extras.payment_status = money.payment_status
  // Money-form answers typed after Stage 1 ride in typed_field_provenance as
  // { value, source, ... } (or a plain value). They fill only keys with no
  // Stage 1 answer, and never document-derived readings.
  const typedProvenance = asRecord(data.typed_field_provenance ?? raw.typed_field_provenance)
  const typed: Record<string, unknown> = {}
  const typedSources: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(typedProvenance)) {
    if (key.startsWith('_') || humanAnswers[key] != null) continue
    const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? asRecord(entry) : null
    const typedValue = record ? record.value : entry
    const source = str(record?.source)
    if (typedValue == null || str(typedValue) === '' || source === 'document_extraction' || source === 'document_review') continue
    typed[key] = typedValue
    if (record && !provenance[key]) typedSources[key] = record
  }
  const merged = { ...extras, ...typed, ...humanAnswers }
  const sources = { ...typedSources, ...provenance }
  const answerProvenance = Object.fromEntries(Object.keys(merged).filter(key => sources[key]).map(key => [key, sources[key]]))
  const dispositions=asRecord(data.questionnaire_dispositions??raw.questionnaire_dispositions)
  const assisted=assistedFromPacket(raw)
  return {...merged,...(Object.keys(answerProvenance).length?{_scs_answer_provenance:answerProvenance}:{}),...(Object.keys(dispositions).length?{_scs_questionnaire_dispositions:dispositions}:{}),...(assisted?{_scs_assisted:assisted}:{})}
}

/**
 * Rep-assisted intake (docs/CYS_BRIDGE.md §F D1): SCS records who filled or
 * finished the form with the homeowner as `data.assisted {by, at, mode}`.
 * Kept on the Client's intake SurveyResponse as `_scs_assisted` (underscore
 * keys are never shown as homeowner answers), so a later client-only packet
 * does not erase it.
 */
export function assistedFromPacket(raw: Record<string, unknown>): AssistedIntake | null {
  const block = asRecord(asRecord(raw.data).assisted ?? raw.assisted)
  const by = str(block.by).trim().slice(0, 120)
  if (!by) return null
  const at = new Date(str(block.at))
  return {
    by,
    at: Number.isNaN(at.getTime()) ? '' : at.toISOString(),
    mode: (str(block.mode).trim() || 'rep').slice(0, 40),
  }
}

/** The `pfl` token SCS copied from the intake link into the packet's attribution. */
export function intakeLinkTokenFrom(raw: Record<string, unknown>): string | null {
  const data = asRecord(raw.data)
  return str(asRecord(data.attribution).pfl) || str(asRecord(raw.attribution).pfl) || null
}

/**
 * Link the Call Center lead that sent this homeowner to SCS (§B1). A bad,
 * expired or foreign token, or any error here, is audited or logged and the
 * intake carries on: a failed link never fails the intake. Inside the
 * receiver's transaction the step runs under a savepoint for that reason.
 */
async function linkCallCenterLead(opts: { organizationId: string; clientId: string }, raw: Record<string, unknown>, store: Prisma.TransactionClient): Promise<void> {
  const token = intakeLinkTokenFrom(raw)
  if (!token) return
  const inTx = store !== db
  if (inTx) await store.$executeRawUnsafe('SAVEPOINT pf_lead_link')
  try {
    const check = verifyIntakeToken(token)
    if (!check.ok) {
      await store.auditEvent.create({ data: {
        organizationId: opts.organizationId, actorLabel: 'SCS intake', action: 'call_center.link_rejected',
        entityType: 'Client', entityId: opts.clientId, summary: `SCS intake link not accepted (${check.reason})`,
        after: { reason: check.reason, scsLeadId: str(raw.lead_id) || null },
      } })
    } else {
      // Scoped to the receiving source's org: a token for another org's lead finds nothing.
      const outcome = await applyLeadLink(store, {
        organizationId: opts.organizationId, leadId: check.leadId, clientId: opts.clientId,
        actor: { id: null, label: 'SCS intake' }, via: 'intake_token', tokenId: check.tokenId, assisted: assistedFromPacket(raw),
      })
      if (outcome === 'missing') {
        await store.auditEvent.create({ data: {
          organizationId: opts.organizationId, actorLabel: 'SCS intake', action: 'call_center.link_rejected',
          entityType: 'Client', entityId: opts.clientId, summary: 'SCS intake link names no lead in this workspace',
          after: { reason: 'no_lead', tokenId: check.tokenId },
        } })
      }
    }
    if (inTx) await store.$executeRawUnsafe('RELEASE SAVEPOINT pf_lead_link')
  } catch (err) {
    if (inTx) await store.$executeRawUnsafe('ROLLBACK TO SAVEPOINT pf_lead_link')
    console.error('[intake] call center lead link skipped', err instanceof Error ? err.message : err)
  }
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
  await linkCallCenterLead(opts, raw, store)
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

  // Property-records trigger. SCS sends its first packet (lead.received) when the
  // homeowner presses NEXT on Contact, intake step 1, with name, email, mobile and
  // the property address. That packet creates the profile and saves the primary
  // address here, then queues the lookup. Later packets (documents, Review
  // confirm) reach this same call; queuePropertyRecords keeps one job per
  // client + address, so they do not add a second lookup.
  const street = str(answers.property_street)
  const city = str(answers.city)
  if (street && city) {
    await store.$queryRaw`SELECT id FROM "Client" WHERE id=${opts.clientId} FOR UPDATE`
    const has = await store.clientAddress.findFirst({ where: { clientId: opts.clientId, isPrimary:true } })
    const incoming={line1:street,city,state:str(answers.state),postalCode:str(answers.zip)}
    const kept=profileAddressAfterPacket(has?{line1:has.line1,city:has.city,state:has.state,postalCode:has.postalCode}:null,incoming)
    const address={...kept.address,isPrimary:true}
    if(has) {
      if(!kept.sameHouse) {
        await store.clientAddress.update({where:{id:has.id},data:address})
        // The contract reading belonged to the previous house.
        await store.documentExtraction.updateMany({where:{provider:'records',document:{clientId:opts.clientId}},data:{sourceActive:false}})
      }
    } else await store.clientAddress.create({data:{clientId:opts.clientId,...address}})
    if(address.state&&address.postalCode) {
      const {queuePropertyRecords}=await import('@/lib/property-records/jobs')
      await queuePropertyRecords({organizationId:opts.organizationId,clientId:opts.clientId,sourceLeadId:str(raw.lead_id),address:{line1:address.line1,city:address.city,state:address.state,postal_code:address.postalCode}},store)
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
  await retireSupersededScsDocuments({
    organizationId: opts.organizationId,
    clientId: opts.clientId,
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
