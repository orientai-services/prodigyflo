'use server'

import { z } from 'zod'
import { db } from '@/lib/db'
import { clientScope, requirePermission } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { asRecord } from '@/lib/packet/schema'
import { createInvite, resetInviteLink } from '@/lib/invites'
import { getEmailProvider, isMockMode } from '@/lib/messaging'
import { QUESTIONNAIRE_NAME, QUESTIONNAIRE_VERSION, QUESTION_SECTIONS, QUESTIONS, answerCount, validateAnswers } from './questions'
import { finalDeskEnabled, loadFinalDesk, loadFinalQuestionnaire } from './data'

const saveSchema = z.object({ clientId: z.string().min(1), answers: z.unknown(), touched: z.array(z.string()).max(42),
  page: z.number().int().min(0).max(8), revision: z.number().int().min(0), complete: z.boolean().default(false) })

export async function saveFinalQuestionnaire(raw: unknown): Promise<{ ok: boolean; revision?: number; error?: string }> {
  try {
    if (!finalDeskEnabled()) throw Error('Final desk is not enabled')
    const user = await requirePermission('clients:update'), input = saveSchema.parse(raw)
    const supplied = validateAnswers(input.answers)
    if (input.touched.some(k => !QUESTIONS.some(q => q.id === k))) throw Error('Unknown question')
    const current = await loadFinalQuestionnaire(user, input.clientId)
    if (!current) throw Error('Client not found or outside your scope')
    const revision = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${input.clientId} FOR UPDATE`
      const client = await tx.client.findFirst({ where: { AND: [clientScope(user), { id: input.clientId }] }, select: { id: true } })
      if (!client) throw Error('Client assignment changed')
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.organizationId + ':final-questionnaire'}))`
      const survey = await tx.survey.findFirst({ where: { organizationId: user.organizationId, name: QUESTIONNAIRE_NAME, version: QUESTIONNAIRE_VERSION } })
        ?? await tx.survey.create({ data: { organizationId: user.organizationId, name: QUESTIONNAIRE_NAME, version: QUESTIONNAIRE_VERSION, schema: JSON.parse(JSON.stringify(QUESTION_SECTIONS)) } })
      const saved = await tx.surveyResponse.findFirst({ where: { surveyId: survey.id, clientId: client.id }, orderBy: { updatedAt: 'desc' } })
      const prior = asRecord(saved?.answers), previousRevision = Number(prior._revision ?? 0)
      if (previousRevision !== input.revision) throw Error('This questionnaire changed in another session. Reload before saving.')
      const merged = { ...current.answers }
      for (const key of input.touched) merged[key] = supplied[key]
      if (input.complete && answerCount(merged) !== 42) throw Error('Answer all 42 questions before Complete')
      const touched = input.complete ? QUESTIONS.map(q => q.id) : input.touched
      const manual = { ...asRecord(prior._manual) }
      for (const key of touched) manual[key] = { actorId: user.id, at: new Date().toISOString(), source: 'staff' }
      const nextRevision = previousRevision + 1
      const data = { answers: { ...merged, _manual: manual, _revision: nextRevision } as object, currentStep: input.page,
        status: input.complete ? 'COMPLETED' as const : 'IN_PROGRESS' as const, completedAt: input.complete ? new Date() : null }
      if (saved) await tx.surveyResponse.update({ where: { id: saved.id }, data })
      else await tx.surveyResponse.create({ data: { ...data, surveyId: survey.id, clientId: client.id } })
      await tx.auditEvent.create({ data: { organizationId: user.organizationId, actorId: user.id, action: input.complete ? 'questionnaire.completed' : 'questionnaire.saved', entityType: 'Client', entityId: client.id, after: { revision: nextRevision, fields: touched } } })
      return nextRevision
    })
    return { ok: true, revision }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not save questionnaire' } }
}

export async function decideFinalSuggestion(raw: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!finalDeskEnabled()) throw Error('Final desk is not enabled')
    const input = z.object({ id: z.string().min(1).max(10000), decision: z.enum(['accepted', 'dismissed']) }).parse(raw)
    const user = await requirePermission('users:manage')
    if (user.role !== 'SUPER_ADMIN') throw Error('Forbidden')
    const card = (await loadFinalDesk(user, 'engine')).suggestions?.find(c => c.id === input.id)
    if (!card) throw Error('Suggestion is no longer current')
    await recordAudit(user, { action: `desk.suggestion.${input.decision}`, entityType: 'DeskSuggestion', entityId: card.id, summary: card.title })
    return { ok: true }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not save decision' } }
}

export async function inviteFinalCloser(raw: unknown): Promise<{ ok: boolean; error?: string; message?: string }> {
  try {
    if (!finalDeskEnabled()) throw Error('Final desk is not enabled')
    const input = z.object({ email: z.email().optional(), inviteId: z.string().optional() }).parse(raw)
    const user = await requirePermission('users:manage')
    // Never report mock delivery as a sent invitation, or create undeliverable invites.
    if (isMockMode('EMAIL')) throw Error('Invitation email delivery is not configured in this preview')
    const base = process.env.APP_URL
    if (!base) throw Error('Invitation URL is not configured')
    let email = input.email, token: string
    if (input.inviteId) {
      const existing = await db.invite.findFirst({ where: { id: input.inviteId, organizationId: user.organizationId, acceptedAt: null, revokedAt: null } })
      if (!existing?.email) throw Error('Email-bound pending invitation not found')
      email = existing.email
      token = (await resetInviteLink(user, existing.id)).token
    } else {
      if (!email) throw Error('A real email address is required')
      token = (await createInvite(user, { email, roleKey: 'CLOSER' })).token
    }
    const result = await getEmailProvider().send({ organizationId: user.organizationId, to: email!, subject: 'Your ProdigyFlo invitation', body: `You have been invited to join Team Prodigy as a Closer. Accept your single-use invitation: ${base}/invite/${token}` })
    if (result.status !== 'SENT') throw Error('Email delivery failed; the invitation remains pending and can be resent')
    return { ok: true, message: 'Invitation sent' }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Could not send invitation' } }
}
