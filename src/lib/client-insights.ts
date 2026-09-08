import 'server-only'
import type { StageKey } from '@prisma/client'
import { db } from '@/lib/db'
import { hoursBetween } from '@/lib/format'

export type NextAction = {
  label: string
  detail: string
  href?: string
  urgency: 'normal' | 'soon' | 'overdue'
}

export type ClientInsights = {
  nextAction: NextAction
  missing: { key: string; label: string }[]
  warnings: { level: 'info' | 'warn' | 'danger'; text: string }[]
  documentProgress: { approved: number; required: number; pct: number }
}

/**
 * Derives the "what happens next" panel from the record itself.
 *
 * Deliberately rule-based rather than model-driven: this drives what staff do
 * every day, so it has to be predictable, instant, and identical for everyone
 * looking at the same client.
 */
export async function getClientInsights(clientId: string): Promise<ClientInsights> {
  const client = await db.client.findUnique({
    where: { id: clientId },
    include: {
      currentStage: true,
      consents: { where: { granted: true, revokedAt: null }, select: { type: true } },
      verifications: { select: { type: true, status: true } },
      creditPulls: { orderBy: { createdAt: 'desc' }, take: 1 },
      qualificationReviews: { orderBy: { createdAt: 'desc' }, take: 1 },
      surveyResponses: { orderBy: { startedAt: 'desc' }, take: 1 },
      appointments: { orderBy: { startsAt: 'desc' }, take: 1 },
      paymentMethods: { orderBy: { createdAt: 'desc' }, take: 1 },
      documents: { include: { requirement: { select: { isRequired: true, name: true } } } },
      submissions: { orderBy: { createdAt: 'desc' }, take: 1 },
      tasks: { where: { status: 'OPEN' }, orderBy: { dueAt: 'asc' } },
    },
  })

  if (!client) {
    return {
      nextAction: { label: 'Client not found', detail: '', urgency: 'normal' },
      missing: [],
      warnings: [],
      documentProgress: { approved: 0, required: 0, pct: 0 },
    }
  }

  const missing: ClientInsights['missing'] = []
  const warnings: ClientInsights['warnings'] = []

  const stage = client.currentStage.key as StageKey
  const survey = client.surveyResponses[0]
  const credit = client.creditPulls[0]
  const review = client.qualificationReviews[0]
  const appointment = client.appointments[0]
  const payment = client.paymentMethods[0]

  const requiredDocs = client.documents.filter((d) => d.requirement?.isRequired)
  const approvedDocs = requiredDocs.filter((d) => d.status === 'APPROVED')
  const documentProgress = {
    approved: approvedDocs.length,
    required: requiredDocs.length,
    pct: requiredDocs.length ? Math.round((approvedDocs.length / requiredDocs.length) * 100) : 0,
  }

  // ── gaps ───────────────────────────────────────────────────
  if (!survey || survey.status !== 'COMPLETED') missing.push({ key: 'survey', label: 'Survey not completed' })

  for (const v of client.verifications) {
    if (v.status !== 'VERIFIED') missing.push({ key: `verify:${v.type}`, label: `${v.type.toLowerCase()} not verified` })
  }
  if (client.verifications.length === 0) missing.push({ key: 'verify', label: 'No verification attempted' })

  const hasCreditConsent = client.consents.some((c) => c.type === 'SOFT_CREDIT_PULL')
  if (!hasCreditConsent) missing.push({ key: 'consent', label: 'Soft-credit-pull consent not recorded' })

  for (const doc of requiredDocs.filter((d) => d.status !== 'APPROVED')) {
    missing.push({ key: `doc:${doc.id}`, label: `${doc.requirement?.name ?? 'Document'} — ${doc.status.toLowerCase()}` })
  }

  // ── warnings ───────────────────────────────────────────────
  const slaHours = client.currentStage.slaHours
  if (slaHours) {
    const elapsed = hoursBetween(client.stageEnteredAt)
    if (elapsed > slaHours) {
      warnings.push({
        level: 'danger',
        text: `${Math.round(elapsed - slaHours)}h past the ${slaHours}h SLA for “${client.currentStage.name}”.`,
      })
    } else if (elapsed > slaHours * 0.8) {
      warnings.push({ level: 'warn', text: `Approaching the ${slaHours}h SLA for this stage.` })
    }
  }

  const overdueTasks = client.tasks.filter((t) => t.dueAt && t.dueAt < new Date())
  if (overdueTasks.length) {
    warnings.push({
      level: 'warn',
      text: `${overdueTasks.length} overdue task${overdueTasks.length === 1 ? '' : 's'}.`,
    })
  }

  if (client.preferredLanguage !== 'en') {
    warnings.push({
      level: 'info',
      text: `Prefers ${client.preferredLanguage.toUpperCase()}. Confirm documents are delivered in that language.`,
    })
  }

  if (credit?.expiresAt && credit.expiresAt < new Date()) {
    warnings.push({ level: 'warn', text: 'The credit summary on file has expired.' })
  }

  const expiring = client.documents.filter(
    (d) => d.expiresAt && d.expiresAt.getTime() - Date.now() < 30 * 86_400_000,
  )
  if (expiring.length) {
    warnings.push({ level: 'warn', text: `${expiring.length} document${expiring.length === 1 ? '' : 's'} expiring within 30 days.` })
  }

  if (!client.ownerId && stage !== 'NEW_LEAD') {
    warnings.push({ level: 'warn', text: 'No closer is assigned to this client.' })
  }

  // ── next action ────────────────────────────────────────────
  const base = `/clients/${client.id}`
  const urgency: NextAction['urgency'] = warnings.some((w) => w.level === 'danger')
    ? 'overdue'
    : warnings.some((w) => w.level === 'warn')
      ? 'soon'
      : 'normal'

  let nextAction: NextAction

  if (client.status === 'CLOSED_WON') {
    nextAction = { label: 'Deal closed won', detail: 'Nothing further is required.', urgency: 'normal' }
  } else if (client.status === 'CLOSED_LOST') {
    nextAction = { label: 'Deal closed lost', detail: client.lostReason ?? 'No reason recorded.', urgency: 'normal' }
  } else if (client.status === 'ON_HOLD') {
    nextAction = { label: 'On hold', detail: client.holdReason ?? 'No reason recorded.', urgency: 'normal' }
  } else if (!survey || survey.status !== 'COMPLETED') {
    nextAction = {
      label: 'Get the survey finished',
      detail: 'Everything downstream is blocked until the client completes it.',
      href: `${base}/survey`,
      urgency,
    }
  } else if (client.verifications.some((v) => v.status !== 'VERIFIED') || client.verifications.length === 0) {
    nextAction = {
      label: 'Verify the client’s details',
      detail: 'Confirm contact and identity information before requesting consent.',
      href: `${base}/verification`,
      urgency,
    }
  } else if (!hasCreditConsent) {
    nextAction = {
      label: 'Capture consent',
      detail: 'A recorded consent is required before any credit inquiry.',
      href: `${base}/qualification`,
      urgency,
    }
  } else if (!credit || credit.status === 'PENDING' || credit.status === 'NOT_REQUESTED') {
    nextAction = {
      label: 'Run the soft credit pull',
      detail: 'Consent is on file, so the inquiry can proceed.',
      href: `${base}/qualification`,
      urgency,
    }
  } else if (!review || review.outcome === 'PENDING') {
    nextAction = {
      label: 'Record the qualification decision',
      detail: 'A named reviewer must accept or override the recommendation.',
      href: `${base}/qualification`,
      urgency,
    }
  } else if (!client.ownerId) {
    nextAction = {
      label: 'Assign a closer',
      detail: 'The client is qualified and waiting for an owner.',
      href: `${base}/assignment`,
      urgency,
    }
  } else if (!appointment || appointment.status === 'CANCELLED') {
    nextAction = {
      label: 'Book the presentation',
      detail: 'No live appointment is on the calendar.',
      href: `${base}/appointments`,
      urgency,
    }
  } else if (appointment.status === 'SCHEDULED' || appointment.status === 'CONFIRMED') {
    nextAction = {
      label: 'Prepare for the appointment',
      detail: `Scheduled for ${appointment.startsAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`,
      href: `${base}/appointments`,
      urgency,
    }
  } else if (!payment || payment.path === 'UNDECIDED') {
    nextAction = {
      label: 'Confirm the payment path',
      detail: 'The presentation is done — capture how the client will pay.',
      href: `${base}/payment`,
      urgency,
    }
  } else if (documentProgress.approved < documentProgress.required) {
    nextAction = {
      label: 'Collect the outstanding documents',
      detail: `${documentProgress.required - documentProgress.approved} of ${documentProgress.required} still needed.`,
      href: `${base}/documents`,
      urgency,
    }
  } else if (!client.submissions.length) {
    nextAction = {
      label: 'Assemble the submission package',
      detail: 'Every required document is approved.',
      href: `${base}/submission`,
      urgency,
    }
  } else {
    const sub = client.submissions[0]
    nextAction =
      sub.status === 'CORRECTIONS_REQUESTED'
        ? {
            label: 'Fix the requested corrections',
            detail: 'The external reviewer returned the package.',
            href: `${base}/submission`,
            urgency: 'overdue',
          }
        : {
            label: 'Awaiting the external reviewer',
            detail: `Submission is ${sub.status.toLowerCase().replace(/_/g, ' ')}.`,
            href: `${base}/submission`,
            urgency: 'normal',
          }
  }

  return { nextAction, missing, warnings, documentProgress }
}
