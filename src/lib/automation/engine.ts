import 'server-only'
import { db } from '@/lib/db'
import { ForbiddenError, type SessionUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { sendMessage, type SendOutcome } from '@/lib/messaging/send'
import { pickTemplate } from '@/lib/messaging/render'
import { loadActor } from './actor'

/**
 * The automation engine. `runDueWork(now)` is invoked by the job runner
 * (POST /api/jobs/run, systemd timer every 5 minutes) and processes:
 *
 *  1. Due ScheduledMessages — one-off "send later" messages, with up to
 *     MAX_ATTEMPTS provider retries on exponential backoff.
 *  2. Due SequenceEnrollments — the next step of every active sequence whose
 *     nextRunAt has passed: reply-stop check, actor resolution, template
 *     resolution by key + client locale, then the normal consent-gated send.
 *
 * Every send goes through sendMessage(), so permission, scope, consent,
 * strict template rendering, and auditing are identical to a manual send.
 */

export const MAX_ATTEMPTS = 3

/** 15 min, 30 min, 60 min … after the 1st, 2nd, 3rd failed attempt. */
export function retryBackoffMs(attemptsSoFar: number): number {
  return 15 * 60_000 * 2 ** Math.max(0, attemptsSoFar - 1)
}

export type JobRunResult = {
  scheduled: { sent: number; retried: number; failed: number }
  sequences: { sent: number; advanced: number; completed: number; stopped: number; failed: number }
}

const CONSENT_CODES = new Set(['NO_CONSENT', 'CONSENT_DECLINED', 'CONSENT_REVOKED', 'CONSENT_EXPIRED', 'OPTED_OUT'])

type SendableChannel = 'EMAIL' | 'SMS'

function sendableChannel(channel: string): SendableChannel | null {
  return channel === 'EMAIL' || channel === 'SMS' ? channel : null
}

/** Resolve a template id from key + channel using the client's locale. */
async function resolveTemplateId(
  organizationId: string,
  key: string,
  channel: SendableChannel,
  locale: string,
): Promise<string | null> {
  const candidates = await db.messageTemplate.findMany({
    where: { organizationId, key, channel, isActive: true },
    select: { id: true, locale: true },
  })
  return pickTemplate(candidates, locale || 'en')?.id ?? null
}

/** A send failure that will never succeed on retry (consent, template, validation). */
function isPermanentRefusal(outcome: SendOutcome): outcome is Extract<SendOutcome, { ok: false }> {
  return !outcome.ok
}

// ─── Scheduled messages ──────────────────────────────────────────────────────

export type RunOptions = {
  /** Restrict the run to one organization (used by tests; production runs unfiltered). */
  organizationId?: string
}

async function runScheduledMessages(now: Date, result: JobRunResult, opts: RunOptions): Promise<void> {
  const due = await db.scheduledMessage.findMany({
    where: {
      status: 'PENDING',
      sendAt: { lte: now },
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
    },
    orderBy: { sendAt: 'asc' },
    take: 50,
    include: {
      client: { select: { id: true, ownerId: true, organizationId: true, preferredLanguage: true, deletedAt: true } },
    },
  })

  for (const sm of due) {
    const fail = async (error: string, actor: SessionUser | null) => {
      await db.scheduledMessage.update({
        where: { id: sm.id },
        data: { status: 'FAILED', attempts: sm.attempts + 1, error: error.slice(0, 500) },
      })
      result.scheduled.failed += 1
      if (actor) {
        await recordAudit(actor, {
          action: 'scheduled_message.failed',
          entityType: 'ScheduledMessage',
          entityId: sm.id,
          summary: `Scheduled ${sm.channel.toLowerCase()} could not be sent: ${error}`,
        })
      }
    }

    if (sm.client.deletedAt) {
      await fail('The client record was deleted.', null)
      continue
    }

    const actor = (await loadActor(sm.userId)) ?? (await loadActor(sm.client.ownerId))
    if (!actor) {
      await fail('No active sender available (scheduling user and client owner are both gone).', null)
      continue
    }

    const channel = sendableChannel(sm.channel)
    if (!channel) {
      await fail(`Channel ${sm.channel} cannot be sent automatically.`, actor)
      continue
    }

    let templateId: string | undefined
    if (sm.templateKey) {
      const id = await resolveTemplateId(sm.client.organizationId, sm.templateKey, channel, sm.client.preferredLanguage)
      if (!id) {
        await fail(`Template "${sm.templateKey}" no longer exists or is inactive for ${channel.toLowerCase()}.`, actor)
        continue
      }
      templateId = id
    }

    let outcome: SendOutcome
    try {
      outcome = await sendMessage(actor, {
        clientId: sm.clientId,
        channel,
        ...(templateId ? { templateId } : { subject: sm.subject ?? undefined, body: sm.body ?? undefined }),
      })
    } catch (err) {
      if (err instanceof ForbiddenError) {
        await fail(`Sender is no longer allowed to message this client: ${err.message}`, actor)
        continue
      }
      throw err
    }

    if (isPermanentRefusal(outcome)) {
      // Consent or validation refusals will not fix themselves — no retry.
      await fail(outcome.error, actor)
      continue
    }

    if (outcome.status === 'SENT') {
      await db.scheduledMessage.update({
        where: { id: sm.id },
        data: { status: 'SENT', attempts: sm.attempts + 1, error: null, communicationId: outcome.communicationId },
      })
      result.scheduled.sent += 1
      continue
    }

    // Provider failure — transient by assumption; retry with backoff up to the cap.
    const attempts = sm.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      await db.scheduledMessage.update({
        where: { id: sm.id },
        data: {
          status: 'FAILED',
          attempts,
          error: `Gave up after ${attempts} attempts. Last error: ${outcome.error ?? 'provider error'}`.slice(0, 500),
          communicationId: outcome.communicationId,
        },
      })
      result.scheduled.failed += 1
      await recordAudit(actor, {
        action: 'scheduled_message.failed',
        entityType: 'ScheduledMessage',
        entityId: sm.id,
        summary: `Scheduled ${channel.toLowerCase()} failed permanently after ${attempts} attempts`,
      })
    } else {
      await db.scheduledMessage.update({
        where: { id: sm.id },
        data: {
          status: 'PENDING',
          attempts,
          sendAt: new Date(now.getTime() + retryBackoffMs(attempts)),
          error: (outcome.error ?? 'provider error').slice(0, 500),
          communicationId: outcome.communicationId,
        },
      })
      result.scheduled.retried += 1
    }
  }
}

// ─── Sequence enrollments ────────────────────────────────────────────────────

async function stopEnrollment(
  enrollmentId: string,
  status: 'COMPLETED' | 'STOPPED' | 'FAILED',
  reason: string,
  actor: SessionUser | null,
  organizationId: string,
  sequenceName: string,
): Promise<void> {
  await db.sequenceEnrollment.update({
    where: { id: enrollmentId },
    data: { status, stoppedReason: reason.slice(0, 500), nextRunAt: null },
  })
  const summary = `Sequence “${sequenceName}” ${status.toLowerCase()}: ${reason}`
  if (actor) {
    await recordAudit(actor, {
      action: `sequence_enrollment.${status.toLowerCase()}`,
      entityType: 'SequenceEnrollment',
      entityId: enrollmentId,
      summary,
    })
  } else {
    await db.auditEvent.create({
      data: {
        organizationId,
        actorLabel: 'Automation engine',
        action: `sequence_enrollment.${status.toLowerCase()}`,
        entityType: 'SequenceEnrollment',
        entityId: enrollmentId,
        summary,
      },
    })
  }
}

async function runSequenceEnrollments(now: Date, result: JobRunResult, opts: RunOptions): Promise<void> {
  const due = await db.sequenceEnrollment.findMany({
    where: {
      status: 'ACTIVE',
      nextRunAt: { lte: now },
      ...(opts.organizationId ? { sequence: { organizationId: opts.organizationId } } : {}),
    },
    orderBy: { nextRunAt: 'asc' },
    take: 50,
    include: {
      sequence: { include: { steps: { orderBy: { position: 'asc' } } } },
      client: { select: { id: true, ownerId: true, organizationId: true, preferredLanguage: true, deletedAt: true } },
    },
  })

  for (const e of due) {
    const orgId = e.client.organizationId
    const seqName = e.sequence.name

    if (!e.sequence.isActive) {
      await stopEnrollment(e.id, 'STOPPED', 'The sequence was deactivated.', null, orgId, seqName)
      result.sequences.stopped += 1
      continue
    }
    if (e.client.deletedAt) {
      await stopEnrollment(e.id, 'STOPPED', 'The client record was deleted.', null, orgId, seqName)
      result.sequences.stopped += 1
      continue
    }

    const step = e.sequence.steps[e.currentStep]
    if (!step) {
      await stopEnrollment(e.id, 'COMPLETED', 'All steps already sent.', null, orgId, seqName)
      result.sequences.completed += 1
      continue
    }

    if (step.stopIfReplied) {
      const reply = await db.communication.findFirst({
        where: { clientId: e.clientId, direction: 'INBOUND', occurredAt: { gt: e.createdAt } },
        select: { id: true },
      })
      if (reply) {
        await stopEnrollment(
          e.id,
          'COMPLETED',
          'The client replied — remaining steps were skipped.',
          null,
          orgId,
          seqName,
        )
        result.sequences.completed += 1
        continue
      }
    }

    const actor = (await loadActor(e.enrolledById)) ?? (await loadActor(e.client.ownerId))
    if (!actor) {
      await stopEnrollment(e.id, 'STOPPED', 'No sender: the enrolling user and the client owner are both unavailable.', null, orgId, seqName)
      result.sequences.stopped += 1
      continue
    }

    const channel = sendableChannel(step.channel)
    if (!channel) {
      await stopEnrollment(e.id, 'FAILED', `Step ${e.currentStep + 1} uses channel ${step.channel}, which cannot be sent automatically.`, actor, orgId, seqName)
      result.sequences.failed += 1
      continue
    }

    const templateId = await resolveTemplateId(orgId, step.templateKey, channel, e.client.preferredLanguage)
    if (!templateId) {
      await stopEnrollment(e.id, 'FAILED', `Template "${step.templateKey}" no longer exists or is inactive for ${channel.toLowerCase()}.`, actor, orgId, seqName)
      result.sequences.failed += 1
      continue
    }

    let outcome: SendOutcome
    try {
      outcome = await sendMessage(actor, { clientId: e.clientId, channel, templateId })
    } catch (err) {
      if (err instanceof ForbiddenError) {
        await stopEnrollment(e.id, 'STOPPED', `The sender is no longer allowed to message this client: ${err.message}`, actor, orgId, seqName)
        result.sequences.stopped += 1
        continue
      }
      throw err
    }

    if (!outcome.ok) {
      if (CONSENT_CODES.has(outcome.code)) {
        await stopEnrollment(e.id, 'STOPPED', outcome.error, actor, orgId, seqName)
        result.sequences.stopped += 1
      } else {
        await stopEnrollment(e.id, 'FAILED', outcome.error, actor, orgId, seqName)
        result.sequences.failed += 1
      }
      continue
    }

    // Sent (or provider-failed with a Communication row recording it) —
    // advance to the next step either way; the timeline shows what happened.
    result.sequences.sent += 1
    const next = e.sequence.steps[e.currentStep + 1]
    if (next) {
      await db.sequenceEnrollment.update({
        where: { id: e.id },
        data: { currentStep: e.currentStep + 1, nextRunAt: new Date(now.getTime() + next.delayHours * 3_600_000) },
      })
      result.sequences.advanced += 1
    } else {
      await db.sequenceEnrollment.update({
        where: { id: e.id },
        data: { currentStep: e.currentStep + 1, status: 'COMPLETED', nextRunAt: null, stoppedReason: null },
      })
      result.sequences.completed += 1
      await recordAudit(actor, {
        action: 'sequence_enrollment.completed',
        entityType: 'SequenceEnrollment',
        entityId: e.id,
        summary: `Sequence “${seqName}” completed — every step sent.`,
      })
    }
  }
}

/** Process everything due at `now`. Called by POST /api/jobs/run. */
export async function runDueWork(now: Date = new Date(), opts: RunOptions = {}): Promise<JobRunResult> {
  const result: JobRunResult = {
    scheduled: { sent: 0, retried: 0, failed: 0 },
    sequences: { sent: 0, advanced: 0, completed: 0, stopped: 0, failed: 0 },
  }
  await runScheduledMessages(now, result, opts)
  await runSequenceEnrollments(now, result, opts)
  return result
}
