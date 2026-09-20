'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { ForbiddenError, findClientInScope, requirePermission } from '@/lib/rbac'
import { moveClientToStage, StageTransitionError } from '@/lib/stage-transitions'
import { CYS_DOCUMENT_KINDS, normalizeForCompare } from '@/lib/cys/resolve'
import { generateCysPackage, resolveForClient } from '@/lib/cys/data'
import { PackageNotAllowedError } from '@/lib/cys/package'

export type CysActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string; blockers?: string[]; fieldErrors?: Record<string, string> }

/** Values can be personal or financial — audit a shape, never the raw text. */
function mask(value: string | null | undefined): string {
  if (!value) return '(empty)'
  const v = value.trim()
  if (v.length <= 4) return '••••'
  return `${v.slice(0, 2)}…${v.slice(-2)} (${v.length} chars)`
}

function fail(error: unknown): CysActionResult {
  if (error instanceof ForbiddenError) return { ok: false, error: error.message }
  if (error instanceof PackageNotAllowedError) return { ok: false, error: error.message }
  if (error instanceof StageTransitionError) {
    return { ok: false, error: error.message, blockers: error.blockers }
  }
  throw error
}

const verifySchema = z.object({
  clientId: z.string().min(1),
  fieldKey: z.string().min(1),
  value: z.string().trim().max(2000).optional(),
  note: z.string().trim().max(1000).optional(),
})

/**
 * Staff confirms a suggested value, resolves a conflict by picking a value, or
 * enters/corrects one by hand. The result is always a human-VERIFIED value.
 */
export async function verifyCysFieldAction(input: z.infer<typeof verifySchema>): Promise<CysActionResult> {
  try {
    const user = await requirePermission('submissions:prepare')
    const parsed = verifySchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: 'Invalid input.' }
    const { clientId, fieldKey, note } = parsed.data

    const client = await findClientInScope(user, clientId)
    if (!client) return { ok: false, error: 'Client not found or out of your scope.' }

    const def = await db.cysFieldDefinition.findUnique({
      where: { organizationId_key: { organizationId: user.organizationId, key: fieldKey } },
    })
    if (!def || !def.isActive) return { ok: false, error: 'Unknown CYS field.' }
    if (CYS_DOCUMENT_KINDS[fieldKey]) return { ok: false, error: 'Upload and review the actual file in the document module.' }

    const workspace = await resolveForClient(user, clientId)
    const existing = workspace.values.find((row) => row.fieldKey === fieldKey) ?? null

    const provided = parsed.data.value
    const value = provided !== undefined && provided !== '' ? provided : (existing?.value ?? '')
    if (!value.trim()) {
      return { ok: false, error: 'Enter a value before verifying.', fieldErrors: { value: 'A value is required.' } }
    }

    const corrected =
      !existing?.value || normalizeForCompare(existing.value) !== normalizeForCompare(value)
    const keepSource = existing !== null && !corrected

    const now = new Date()
    await db.cysFieldValue.upsert({
      where: { clientId_fieldKey: { clientId, fieldKey } },
      create: {
        clientId,
        fieldKey,
        value: value.trim(),
        status: 'VERIFIED',
        sourceLabel: def.sourceType === 'MANUAL' ? 'Manual entry' : 'Staff entry',
        note: note ?? null,
        verifiedById: user.id,
        verifiedAt: now,
        ...(keepSource ? { sourceLabel: existing.sourceLabel, sourceDocumentId: existing.sourceDocumentId, sourceExtractedFieldId: existing.sourceExtractedFieldId, confidence: existing.confidence } : {}),
      },
      update: {
        value: value.trim(),
        status: 'VERIFIED',
        conflictValue: null,
        note: note ?? (keepSource ? existing?.note : null),
        ...(keepSource
          ? {}
          : {
              sourceLabel: def.sourceType === 'MANUAL' ? 'Manual entry' : 'Staff entry',
              confidence: null,
              sourceDocumentId: null,
              sourceExtractedFieldId: null,
            }),
        verifiedById: user.id,
        verifiedAt: now,
      },
    })

    // A changed answer needs a fresh approval. Preserve earlier Submission snapshots.
    if (corrected) await db.cysReadiness.updateMany({ where: { clientId }, data: { approvedAt: null, approvedById: null, packageGeneratedAt: null } })

    await recordAudit(user, {
      action: corrected ? 'cys.field_corrected' : 'cys.field_verified',
      entityType: 'CysFieldValue',
      entityId: clientId,
      summary: `${corrected ? 'Corrected' : 'Verified'} CYS field "${def.label}"`,
      before: { fieldKey, status: existing?.status ?? 'MISSING', value: mask(existing?.value) },
      after: { fieldKey, status: 'VERIFIED', value: mask(value), note: note ?? null },
    })

    revalidatePath(`/clients/${clientId}`)
    return { ok: true, message: `"${def.label}" verified.` }
  } catch (error) {
    return fail(error)
  }
}

const approveSchema = z.object({
  clientId: z.string().min(1),
  note: z.string().trim().max(1000).optional(),
})

/**
 * The approval gate. Refused server-side while any required field is MISSING,
 * CONFLICT, or merely SUGGESTED — hiding the button is not the protection.
 */
export async function approveCysReadinessAction(
  input: z.infer<typeof approveSchema>,
): Promise<CysActionResult> {
  try {
    const user = await requirePermission('submissions:approve')
    const parsed = approveSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: 'Invalid input.' }
    const { clientId, note } = parsed.data

    const client = await findClientInScope(user, clientId)
    if (!client) return { ok: false, error: 'Client not found or out of your scope.' }
    const currentStage = await db.pipelineStage.findUnique({
      where: { id: client.currentStageId },
      select: { category: true },
    })

    const { completion, blockers, checklist } = await resolveForClient(user, clientId)
    if (blockers.length > 0) {
      return {
        ok: false,
        error: 'This client is not CYS ready yet.',
        blockers,
      }
    }

    // Advance the pipeline first so a gated transition blocks the approval too.
    const stageCategory = currentStage?.category
    if (stageCategory !== 'SUBMISSION' && stageCategory !== 'TERMINAL') {
      await moveClientToStage({
        user,
        clientId,
        toStageKey: 'DEAL_READY_FOR_SUBMISSION',
        reason: 'Approved as CYS ready',
      })
    }

    const now = new Date()
    await db.cysReadiness.upsert({
      where: { clientId },
      create: { clientId, ...completion, checklist, approvedById: user.id, approvedAt: now, approvalNote: note ?? null },
      update: {
        approvedById: user.id,
        approvedAt: now,
        approvalNote: note ?? null,
        completionPct: completion.completionPct,
        requiredTotal: completion.requiredTotal,
        requiredVerified: completion.requiredVerified,
      },
    })

    await recordAudit(user, {
      action: 'cys.readiness_approved',
      entityType: 'Client',
      entityId: clientId,
      summary: `Approved as CYS ready (${completion.requiredVerified}/${completion.requiredTotal} required fields verified)`,
      after: { completion, note: note ?? null },
    })

    revalidatePath(`/clients/${clientId}`)
    return { ok: true, message: 'Client approved as CYS ready.' }
  } catch (error) {
    return fail(error)
  }
}

const generateSchema = z.object({ clientId: z.string().min(1) })

export async function generateCysPackageAction(
  input: z.infer<typeof generateSchema>,
): Promise<CysActionResult> {
  try {
    const user = await requirePermission('submissions:prepare')
    const parsed = generateSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: 'Invalid input.' }

    await generateCysPackage(user, parsed.data.clientId)

    revalidatePath(`/clients/${parsed.data.clientId}`)
    revalidatePath('/submissions')
    return { ok: true, message: 'CYS package generated.' }
  } catch (error) {
    return fail(error)
  }
}
