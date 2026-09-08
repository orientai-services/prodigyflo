'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { IntakeSourceKind, IntakeStatus, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ForbiddenError, requirePermission, type SessionUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { generateIntakeSecret, hashIntakeSecret } from '@/lib/intake/hmac'
import { reapplySubmission, runSheetSync } from '@/lib/intake/apply'
import { CRM_FIELD_KEYS, DEDUPE_KEYS } from '@/lib/intake/mapping'

type FieldErrors = Record<string, string>
type Result<T = object> = ({ ok: true } & T) | { ok: false; error?: string; fieldErrors?: FieldErrors }

async function manage(): Promise<SessionUser | null> {
  try {
    return await requirePermission('connectors:manage')
  } catch (e) {
    if (e instanceof ForbiddenError) return null
    throw e
  }
}

const FORBIDDEN = { ok: false as const, error: 'You do not have permission to manage intake sources.' }

function actorOf(user: SessionUser) {
  return { id: user.id, name: user.name, roleName: user.roleName }
}

function zodFieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {}
  for (const issue of error.issues) out[String(issue.path[0] ?? 'form')] = issue.message
  return out
}

function refresh(sourceId?: string) {
  revalidatePath('/settings/intake')
  if (sourceId) revalidatePath(`/settings/intake/${sourceId}`)
}

const mappingSchema = z.record(z.string(), z.string()).transform((m) => {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(m)) {
    if (CRM_FIELD_KEYS.includes(k) && v.trim()) clean[k] = v.trim()
  }
  return clean
})

// ── Create ───────────────────────────────────────────────────

const createSchema = z.object({
  name: z.string().trim().min(2, 'Give the source a name.').max(80),
  kind: z.enum(IntakeSourceKind),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{2,63}$/, 'Lowercase letters, digits and dashes; 3–64 characters.'),
  defaultOwnerId: z.string().trim().optional(),
  defaultLeadSourceId: z.string().trim().optional(),
  sheetId: z.string().trim().max(120).optional(),
  sheetTab: z.string().trim().max(80).optional(),
})

export async function createIntakeSource(
  input: z.input<typeof createSchema>,
): Promise<Result<{ sourceId: string; slug: string; secret: string }>> {
  const user = await manage()
  if (!user) return FORBIDDEN

  const parsed = createSchema.safeParse(input)
  if (!parsed.success) return { ok: false, fieldErrors: zodFieldErrors(parsed.error) }
  const data = parsed.data

  if (data.kind === 'GOOGLE_SHEET' && !data.sheetId) {
    return { ok: false, fieldErrors: { sheetId: 'A sheet ID is required for a Google Sheet source.' } }
  }

  // The plaintext secret is returned exactly once; only its hash is stored.
  const secret = generateIntakeSecret()
  try {
    const source = await db.intakeSource.create({
      data: {
        organizationId: user.organizationId,
        kind: data.kind,
        name: data.name,
        slug: data.slug,
        secretHash: hashIntakeSecret(secret),
        fieldMapping: { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone' },
        defaultOwnerId: data.defaultOwnerId || null,
        defaultLeadSourceId: data.defaultLeadSourceId || null,
        sheetId: data.kind === 'GOOGLE_SHEET' ? data.sheetId : null,
        sheetTab: data.kind === 'GOOGLE_SHEET' ? data.sheetTab || 'Sheet1' : null,
      },
    })
    await recordAudit(user, {
      action: 'intake.source_created',
      entityType: 'IntakeSource',
      entityId: source.id,
      summary: `Created intake source "${source.name}" (${source.kind}, /api/intake/${source.slug})`,
    })
    refresh(source.id)
    return { ok: true, sourceId: source.id, slug: source.slug, secret }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { ok: false, fieldErrors: { slug: 'That slug is already in use.' } }
    }
    throw e
  }
}

// ── Update ───────────────────────────────────────────────────

const updateSchema = z.object({
  sourceId: z.string().min(1),
  name: z.string().trim().min(2).max(80).optional(),
  isEnabled: z.boolean().optional(),
  defaultOwnerId: z.string().nullable().optional(),
  defaultLeadSourceId: z.string().nullable().optional(),
  dedupeKeys: z.array(z.enum(DEDUPE_KEYS)).min(1).max(3).optional(),
  fieldMapping: mappingSchema.optional(),
  sheetId: z.string().trim().max(120).optional(),
  sheetTab: z.string().trim().max(80).optional(),
})

export async function updateIntakeSource(input: z.input<typeof updateSchema>): Promise<Result> {
  const user = await manage()
  if (!user) return FORBIDDEN

  const parsed = updateSchema.safeParse(input)
  if (!parsed.success) return { ok: false, fieldErrors: zodFieldErrors(parsed.error) }
  const { sourceId, ...patch } = parsed.data

  const source = await db.intakeSource.findFirst({
    where: { id: sourceId, organizationId: user.organizationId },
  })
  if (!source) return { ok: false, error: 'Source not found.' }

  if (patch.dedupeKeys) patch.dedupeKeys = [...new Set(patch.dedupeKeys)]

  const updated = await db.intakeSource.update({
    where: { id: source.id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.isEnabled !== undefined ? { isEnabled: patch.isEnabled } : {}),
      ...(patch.defaultOwnerId !== undefined ? { defaultOwnerId: patch.defaultOwnerId || null } : {}),
      ...(patch.defaultLeadSourceId !== undefined ? { defaultLeadSourceId: patch.defaultLeadSourceId || null } : {}),
      ...(patch.dedupeKeys !== undefined ? { dedupeKeys: patch.dedupeKeys } : {}),
      ...(patch.fieldMapping !== undefined ? { fieldMapping: patch.fieldMapping } : {}),
      ...(patch.sheetId !== undefined ? { sheetId: patch.sheetId || null } : {}),
      ...(patch.sheetTab !== undefined ? { sheetTab: patch.sheetTab || null } : {}),
    },
  })
  await recordAudit(user, {
    action: 'intake.source_updated',
    entityType: 'IntakeSource',
    entityId: source.id,
    summary: `Updated intake source "${updated.name}" (${Object.keys(patch).join(', ')})`,
    before: { fieldMapping: source.fieldMapping, dedupeKeys: source.dedupeKeys, isEnabled: source.isEnabled },
    after: { fieldMapping: updated.fieldMapping, dedupeKeys: updated.dedupeKeys, isEnabled: updated.isEnabled },
  })
  refresh(source.id)
  return { ok: true }
}

// ── Secret rotation ──────────────────────────────────────────

export async function rotateIntakeSecret(sourceId: string): Promise<Result<{ secret: string }>> {
  const user = await manage()
  if (!user) return FORBIDDEN

  const source = await db.intakeSource.findFirst({
    where: { id: sourceId, organizationId: user.organizationId },
  })
  if (!source) return { ok: false, error: 'Source not found.' }

  const secret = generateIntakeSecret()
  await db.intakeSource.update({ where: { id: source.id }, data: { secretHash: hashIntakeSecret(secret) } })
  await recordAudit(user, {
    action: 'intake.secret_rotated',
    entityType: 'IntakeSource',
    entityId: source.id,
    summary: `Rotated webhook secret for "${source.name}" — old signatures are now rejected`,
  })
  refresh(source.id)
  return { ok: true, secret }
}

// ── Sheet sync ───────────────────────────────────────────────

export async function syncIntakeSource(sourceId: string): Promise<Result<{ message: string }>> {
  const user = await manage()
  if (!user) return FORBIDDEN

  const source = await db.intakeSource.findFirst({
    where: { id: sourceId, organizationId: user.organizationId },
  })
  if (!source) return { ok: false, error: 'Source not found.' }

  const result = await runSheetSync(source, actorOf(user))
  refresh(source.id)
  if (!result.ok) return { ok: false, error: result.message }
  return { ok: true, message: result.message }
}

// ── Retry / fix mapping ──────────────────────────────────────

const RETRYABLE: IntakeStatus[] = [IntakeStatus.FAILED, IntakeStatus.NEEDS_MAPPING]

export async function retryIntakeSubmission(submissionId: string): Promise<Result<{ status: IntakeStatus; error: string | null }>> {
  const user = await manage()
  if (!user) return FORBIDDEN

  const submission = await db.intakeSubmission.findFirst({
    where: { id: submissionId, organizationId: user.organizationId },
    include: { source: true },
  })
  if (!submission) return { ok: false, error: 'Submission not found.' }
  if (!RETRYABLE.includes(submission.status)) {
    return { ok: false, error: 'Only failed or needs-mapping submissions can be retried.' }
  }

  const updated = await reapplySubmission(submission, submission.source, { actor: actorOf(user) })
  await recordAudit(user, {
    action: 'intake.submission_retried',
    entityType: 'IntakeSubmission',
    entityId: submission.id,
    summary: `Retried intake submission ${submission.externalId} — now ${updated.status}`,
  })
  refresh(submission.sourceId)
  return { ok: true, status: updated.status, error: updated.error }
}

const fixSchema = z.object({
  submissionId: z.string().min(1),
  overrides: mappingSchema,
  saveToSource: z.boolean().default(false),
})

/** Map the stuck submission's unmapped keys and re-apply it in one step. */
export async function fixSubmissionMapping(
  input: z.input<typeof fixSchema>,
): Promise<Result<{ status: IntakeStatus; error: string | null }>> {
  const user = await manage()
  if (!user) return FORBIDDEN

  const parsed = fixSchema.safeParse(input)
  if (!parsed.success) return { ok: false, fieldErrors: zodFieldErrors(parsed.error) }
  if (Object.keys(parsed.data.overrides).length === 0) {
    return { ok: false, error: 'Map at least one field before applying.' }
  }

  const submission = await db.intakeSubmission.findFirst({
    where: { id: parsed.data.submissionId, organizationId: user.organizationId },
    include: { source: true },
  })
  if (!submission) return { ok: false, error: 'Submission not found.' }
  if (!RETRYABLE.includes(submission.status)) {
    return { ok: false, error: 'Only failed or needs-mapping submissions can be fixed.' }
  }

  let source = submission.source
  if (parsed.data.saveToSource) {
    source = await db.intakeSource.update({
      where: { id: source.id },
      data: {
        fieldMapping: {
          ...((source.fieldMapping ?? {}) as Record<string, string>),
          ...parsed.data.overrides,
        },
      },
    })
  }

  const updated = await reapplySubmission(submission, source, {
    overrideMapping: parsed.data.overrides,
    actor: actorOf(user),
  })
  await recordAudit(user, {
    action: 'intake.submission_mapping_fixed',
    entityType: 'IntakeSubmission',
    entityId: submission.id,
    summary: `Fixed mapping for submission ${submission.externalId} (${Object.keys(parsed.data.overrides).join(', ')})${parsed.data.saveToSource ? ', saved to source' : ''} — now ${updated.status}`,
  })
  refresh(submission.sourceId)
  return { ok: true, status: updated.status, error: updated.error }
}
