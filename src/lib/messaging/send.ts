import 'server-only'
import { isSyntheticClient } from '@/lib/intake/synthetic'
import type { CommunicationChannel } from '@prisma/client'
import { db } from '@/lib/db'
import { can, findClientInScope, ForbiddenError, type SessionUser } from '@/lib/rbac'
import { recordAudit, redactForAudit } from '@/lib/audit'
import { dateTime, humanize } from '@/lib/format'
import { getConsentDecision, type MessagingChannel } from './consent'
import { renderSignature } from './signature'
import { baseVarsForClient, renderTemplate, type TemplateVars } from './render'
import { getEmailProvider, getSmsProvider, isMockMode } from './index'

/**
 * The single entry point for outbound email/SMS. Order is deliberate:
 * permission -> scope -> consent -> render (strict) -> provider -> persist.
 * A Communication row is written as QUEUED before the provider is called and
 * only moves to SENT when the provider confirmed the send.
 */

export type SendInput = {
  clientId: string
  channel: MessagingChannel
  /** Send from a stored template… */
  templateId?: string
  /** …or a free-form message (still variable-substituted and strict-checked). */
  subject?: string
  body?: string
  /** Extra variable sources for reminder sends. Both are scope-checked to the client. */
  context?: { appointmentId?: string; documentId?: string }
  followUpTask?: { dueAt: Date; title?: string }
}

export type SendOutcome =
  | { ok: true; communicationId: string; status: 'SENT' | 'FAILED'; error?: string; mock: boolean }
  | { ok: false; code: string; error: string }

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!domain) return '***'
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, local.length - 1))}@${domain}`
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return digits.length >= 4 ? `(***) ***-${digits.slice(-4)}` : '***'
}

async function contextVars(clientId: string, context: SendInput['context']): Promise<TemplateVars> {
  const vars: TemplateVars = {}
  if (!context) return vars

  if (context.appointmentId) {
    const appt = await db.appointment.findFirst({
      where: { id: context.appointmentId, clientId },
      select: { startsAt: true, timezone: true, type: true, location: true },
    })
    if (appt) {
      vars.appointment_date = dateTime(appt.startsAt, appt.timezone)
      vars.appointment_type = humanize(appt.type)
      vars.appointment_location = appt.location ?? ''
    }
  }

  if (context.documentId) {
    const doc = await db.clientDocument.findFirst({
      where: { id: context.documentId, clientId },
      select: { label: true, fileName: true, requirement: { select: { name: true } } },
    })
    if (doc) {
      vars.document_name = doc.requirement?.name ?? doc.label ?? doc.fileName ?? ''
    }
  }

  return vars
}

export async function sendMessage(user: SessionUser, input: SendInput): Promise<SendOutcome> {
  if (!can(user, 'communications:send')) {
    throw new ForbiddenError('You do not have permission to send messages.')
  }

  const client = await findClientInScope(user, input.clientId, {
    owner: { select: { name: true } },
    organization: { select: { name: true } },
  })
  if (!client) throw new ForbiddenError('This client is not in your scope.')

  if (await isSyntheticClient(client.id)) return {ok:false,code:'SYNTHETIC',error:'Synthetic case: messages blocked'}
  const decision = await getConsentDecision(client.id, input.channel)
  if (!decision.allowed) {
    return { ok: false, code: decision.code, error: decision.reason }
  }

  // Resolve content.
  let subjectSource: string | null = input.subject?.trim() || null
  let bodySource = input.body?.trim() ?? ''
  let templateKey: string | null = null

  if (input.templateId) {
    const template = await db.messageTemplate.findFirst({
      where: {
        id: input.templateId,
        organizationId: user.organizationId,
        isActive: true,
        channel: input.channel as CommunicationChannel,
      },
    })
    if (!template) {
      return { ok: false, code: 'TEMPLATE_NOT_FOUND', error: 'Template not found, inactive, or wrong channel.' }
    }
    subjectSource = template.subject
    bodySource = template.body
    templateKey = template.key
  }

  if (!bodySource) return { ok: false, code: 'EMPTY_BODY', error: 'The message body is empty.' }

  // The sender's identity and signature are first-class template variables, so
  // outreach templates can write {{sender_name}} or place {{signature}} freely.
  const sender = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: {
      name: true, nickname: true, title: true, phone: true, emailAlias: true,
      signatureStyle: true, signatureIncludePhone: true,
    },
  })
  const signature = renderSignature(sender, user.organizationName)

  const vars: TemplateVars = {
    ...baseVarsForClient(client as never),
    ...(await contextVars(client.id, input.context)),
    sender_name: sender.name,
    sender_nickname: sender.nickname ?? sender.name,
    sender_title: sender.title ?? '',
    signature,
  }
  const rendered = renderTemplate({ subject: subjectSource, body: bodySource }, vars)
  if (rendered.unresolved.length > 0) {
    return {
      ok: false,
      code: 'UNRESOLVED_VARIABLES',
      error: `Unresolved variables: ${rendered.unresolved.map((v) => `{{${v}}}`).join(', ')}. The message was not sent.`,
    }
  }
  if (input.channel === 'EMAIL' && !rendered.subject) {
    return { ok: false, code: 'EMPTY_SUBJECT', error: 'Email requires a subject line.' }
  }
  // Every email carries the sender's signature: appended unless the template
  // already placed {{signature}} itself. SMS stays untouched — length matters.
  if (input.channel === 'EMAIL' && signature && !bodySource.includes('{{signature}}')) {
    rendered.body = `${rendered.body}

${signature}`
  }

  const to = input.channel === 'EMAIL' ? client.email : client.phone
  if (!to) {
    return {
      ok: false,
      code: 'NO_RECIPIENT',
      error:
        input.channel === 'EMAIL'
          ? 'The client has no email address on file.'
          : 'The client has no phone number on file.',
    }
  }

  const connector = await db.connector.findFirst({
    where: { organizationId: user.organizationId, kind: input.channel === 'EMAIL' ? 'EMAIL' : 'TWILIO_SMS' },
    select: { id: true },
  })

  const toMasked = input.channel === 'EMAIL' ? maskEmail(to) : maskPhone(to)

  const communication = await db.communication.create({
    data: {
      clientId: client.id,
      userId: user.id,
      channel: input.channel,
      direction: 'OUTBOUND',
      status: 'QUEUED',
      subject: rendered.subject,
      body: rendered.body,
      templateKey,
      connectorId: connector?.id ?? null,
      message: { create: { toMasked } },
    },
  })

  const result =
    input.channel === 'EMAIL'
      ? await getEmailProvider().send({ to, subject: rendered.subject!, body: rendered.body, organizationId: user.organizationId })
      : await getSmsProvider().send({ to, body: rendered.body, organizationId: user.organizationId })

  // Persist exactly what the provider reported — SENT only on confirmation.
  await db.communication.update({
    where: { id: communication.id },
    data: {
      status: result.status,
      externalRef: result.externalRef,
      message: {
        update: { failureCode: result.status === 'FAILED' ? (result.error ?? 'unknown').slice(0, 500) : null },
      },
    },
  })
  await db.client.update({ where: { id: client.id }, data: { lastActivityAt: new Date() } })

  await recordAudit(user, {
    action: 'communication.send',
    entityType: 'Communication',
    entityId: communication.id,
    summary: `${result.status === 'SENT' ? 'Sent' : 'Failed to send'} ${input.channel.toLowerCase()} to ${toMasked}${templateKey ? ` (template ${templateKey})` : ''}`,
    after: redactForAudit({
      channel: input.channel,
      status: result.status,
      templateKey,
      toMasked,
      externalRef: result.externalRef,
      error: result.error ?? null,
    }),
  })

  if (input.followUpTask && result.status === 'SENT') {
    const task = await db.task.create({
      data: {
        clientId: client.id,
        assigneeId: user.id,
        createdById: user.id,
        title: input.followUpTask.title?.trim() || `Follow up with ${client.firstName} ${client.lastName}`,
        description: `Follow-up on ${input.channel.toLowerCase()}${templateKey ? ` (template ${templateKey})` : ''} sent ${new Date().toLocaleDateString('en-US')}.`,
        dueAt: input.followUpTask.dueAt,
      },
    })
    await recordAudit(user, {
      action: 'task.create',
      entityType: 'Task',
      entityId: task.id,
      summary: `Follow-up task created after ${input.channel.toLowerCase()} send`,
      after: { title: task.title, dueAt: task.dueAt },
    })
  }

  return {
    ok: true,
    communicationId: communication.id,
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
    mock: isMockMode(input.channel),
  }
}
