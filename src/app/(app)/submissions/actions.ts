'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { SubmissionStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { clientScope, ForbiddenError, requirePermission, type SessionUser } from '@/lib/rbac'

export type SubmissionActionResult = { ok: true; message?: string } | { ok: false; error: string }

/**
 * Delivery is manual — no CYS API exists. These actions only record what a
 * human actually did outside the system, which is why each requires an
 * explicit acknowledgement (an external reference, a corrections list).
 */

async function loadSubmission(user: SessionUser, submissionId: string) {
  return db.submission.findFirst({
    where: { id: submissionId, client: clientScope(user) },
    include: { client: { select: { id: true, firstName: true, lastName: true } } },
  })
}

function refresh(submissionId: string, clientId: string) {
  revalidatePath('/submissions')
  revalidatePath(`/submissions/${submissionId}`)
  revalidatePath(`/clients/${clientId}`)
}

const markSubmittedSchema = z.object({
  submissionId: z.string().min(1),
  externalRef: z.string().trim().min(1, 'Record the reference you received on delivery.').max(120),
})

export async function markSubmissionSubmittedAction(
  input: z.infer<typeof markSubmittedSchema>,
): Promise<SubmissionActionResult> {
  try {
    const user = await requirePermission('submissions:prepare')
    const parsed = markSubmittedSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }

    const submission = await loadSubmission(user, parsed.data.submissionId)
    if (!submission) return { ok: false, error: 'Submission not found or out of your scope.' }

    const from: SubmissionStatus[] = ['DRAFT', 'READY']
    if (!from.includes(submission.status)) {
      return { ok: false, error: `A ${submission.status.toLowerCase()} submission cannot be marked submitted.` }
    }
    if (!submission.approvedAt) {
      return { ok: false, error: 'This package was never approved — generate it from an approved client first.' }
    }

    await db.submission.update({
      where: { id: submission.id },
      data: { status: 'SUBMITTED', submittedAt: new Date(), externalRef: parsed.data.externalRef },
    })
    await recordAudit(user, {
      action: 'submission.marked_submitted',
      entityType: 'Submission',
      entityId: submission.id,
      summary: `Marked submission (attempt ${submission.attemptNumber}) as manually delivered to CYS`,
      before: { status: submission.status },
      after: { status: 'SUBMITTED', externalRef: parsed.data.externalRef },
    })

    refresh(submission.id, submission.client.id)
    return { ok: true, message: 'Recorded as submitted.' }
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: error.message }
    throw error
  }
}

const correctionsSchema = z.object({
  submissionId: z.string().min(1),
  corrections: z.string().trim().min(1, 'List at least one requested correction.').max(4000),
})

export async function recordSubmissionCorrectionsAction(
  input: z.infer<typeof correctionsSchema>,
): Promise<SubmissionActionResult> {
  try {
    const user = await requirePermission('submissions:prepare')
    const parsed = correctionsSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }

    const submission = await loadSubmission(user, parsed.data.submissionId)
    if (!submission) return { ok: false, error: 'Submission not found or out of your scope.' }

    const from: SubmissionStatus[] = ['SUBMITTED', 'ACKNOWLEDGED', 'RESUBMITTED']
    if (!from.includes(submission.status)) {
      return { ok: false, error: 'Corrections can only be recorded on a delivered submission.' }
    }

    const items = parsed.data.corrections
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    await db.submission.update({
      where: { id: submission.id },
      data: {
        status: 'CORRECTIONS_REQUESTED',
        correctionsRequested: items,
        correctionsRequestedAt: new Date(),
      },
    })
    await recordAudit(user, {
      action: 'submission.corrections_recorded',
      entityType: 'Submission',
      entityId: submission.id,
      summary: `Recorded ${items.length} correction${items.length === 1 ? '' : 's'} requested by CYS`,
      before: { status: submission.status },
      after: { status: 'CORRECTIONS_REQUESTED', corrections: items },
    })

    refresh(submission.id, submission.client.id)
    return { ok: true, message: 'Corrections recorded.' }
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: error.message }
    throw error
  }
}

const resubmitSchema = z.object({
  submissionId: z.string().min(1),
  externalRef: z.string().trim().max(120).optional(),
})

export async function markSubmissionResubmittedAction(
  input: z.infer<typeof resubmitSchema>,
): Promise<SubmissionActionResult> {
  try {
    const user = await requirePermission('submissions:prepare')
    const parsed = resubmitSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: 'Invalid input.' }

    const submission = await loadSubmission(user, parsed.data.submissionId)
    if (!submission) return { ok: false, error: 'Submission not found or out of your scope.' }

    if (submission.status !== 'CORRECTIONS_REQUESTED') {
      return { ok: false, error: 'Only a submission with corrections requested can be resubmitted.' }
    }

    await db.submission.update({
      where: { id: submission.id },
      data: {
        status: 'RESUBMITTED',
        resubmittedAt: new Date(),
        attemptNumber: submission.attemptNumber + 1,
        ...(parsed.data.externalRef ? { externalRef: parsed.data.externalRef } : {}),
      },
    })
    await recordAudit(user, {
      action: 'submission.marked_resubmitted',
      entityType: 'Submission',
      entityId: submission.id,
      summary: `Marked submission as manually re-delivered to CYS (attempt ${submission.attemptNumber + 1})`,
      before: { status: submission.status, attemptNumber: submission.attemptNumber },
      after: { status: 'RESUBMITTED', attemptNumber: submission.attemptNumber + 1 },
    })

    refresh(submission.id, submission.client.id)
    return { ok: true, message: 'Recorded as resubmitted.' }
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: error.message }
    throw error
  }
}
