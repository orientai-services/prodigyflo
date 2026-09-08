'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { ForbiddenError, requirePermission } from '@/lib/rbac'
import { buildAttorneyManifest, getAttorneyClientDetail } from '@/lib/attorney'

export type AttorneyActionResult =
  | { ok: true; message?: string; submissionId?: string }
  | { ok: false; error: string; blockers?: string[] }

const approveSchema = z.object({
  clientId: z.string().min(1),
  note: z.string().trim().max(1000).optional(),
})

/**
 * Approves the attorney handover: re-checks readiness server-side (every
 * attorney-required document APPROVED + signed contract on file), then keeps
 * exactly one DRAFT Submission {destination: ATTORNEY} whose manifest freezes
 * the reviewed document versions. Delivery stays manual — staff record the
 * hand-off on /submissions afterwards, exactly like CYS.
 */
export async function approveAttorneySubmissionAction(
  input: z.infer<typeof approveSchema>,
): Promise<AttorneyActionResult> {
  try {
    const user = await requirePermission('submissions:approve')
    const parsed = approveSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: 'Invalid input.' }
    const { clientId, note } = parsed.data

    const detail = await getAttorneyClientDetail(user, clientId)
    if (!detail) return { ok: false, error: 'Client not found or out of your scope.' }

    // The gate. The button being visible is never the protection.
    if (!detail.readiness.ready) {
      return {
        ok: false,
        error: 'This client is not ready for attorney review yet.',
        blockers: detail.readiness.blockers,
      }
    }

    const manifest = buildAttorneyManifest(
      detail.client.documents.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        label: d.label,
        requirementName: d.requirement?.name ?? null,
        checksum: d.checksum,
        version: d.version,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        status: d.status,
      })),
    )

    const now = new Date()
    const validationReport = {
      generatedAt: now.toISOString(),
      requiredTotal: detail.readiness.requiredTotal,
      requiredApproved: detail.readiness.requiredApproved,
      hasSignedContract: detail.readiness.hasSignedContract,
      note: note ?? null,
    }

    const submission = await db.$transaction(async (tx) => {
      const draft = await tx.submission.findFirst({
        where: { clientId, destination: 'ATTORNEY', status: 'DRAFT' },
      })
      const data = {
        packageManifest: manifest as never,
        validationReport: validationReport as never,
        approvedById: user.id,
        approvedAt: now,
      }
      if (draft) {
        return tx.submission.update({ where: { id: draft.id }, data })
      }
      return tx.submission.create({
        data: {
          clientId,
          destination: 'ATTORNEY',
          status: 'DRAFT',
          attemptNumber:
            (await tx.submission.count({ where: { clientId, destination: 'ATTORNEY' } })) + 1,
          ...data,
        },
      })
    })

    await recordAudit(user, {
      action: 'attorney.submission_approved',
      entityType: 'Submission',
      entityId: submission.id,
      summary: `Approved attorney package (${manifest.length} document${manifest.length === 1 ? '' : 's'}, ${detail.readiness.requiredApproved}/${detail.readiness.requiredTotal} required approved)`,
      after: {
        clientId,
        documentCount: manifest.length,
        requiredApproved: detail.readiness.requiredApproved,
        requiredTotal: detail.readiness.requiredTotal,
        note: note ?? null,
      },
    })

    revalidatePath('/attorney')
    revalidatePath(`/attorney/${clientId}`)
    revalidatePath('/submissions')
    revalidatePath(`/clients/${clientId}`)
    return {
      ok: true,
      message: 'Attorney package approved. Record the hand-off under Submissions once delivered.',
      submissionId: submission.id,
    }
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: error.message }
    throw error
  }
}
