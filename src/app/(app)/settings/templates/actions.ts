'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ForbiddenError, requirePermission } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'

export type TemplateFormResult = { ok: true; id: string } | { ok: false; errors: Record<string, string> }

const templateSchema = z
  .object({
    id: z.string().min(1).optional(),
    key: z
      .string()
      .min(2, 'Key is required')
      .max(80)
      .regex(/^[a-z0-9_]+$/, 'Lowercase letters, digits and underscores only'),
    name: z.string().min(2, 'Name is required').max(120),
    channel: z.enum(['EMAIL', 'SMS']),
    locale: z
      .string()
      .min(2)
      .max(10)
      .regex(/^[a-z]{2}(-[a-z0-9]+)?$/i, 'Use a locale code like en or es'),
    subject: z.string().max(300).optional(),
    body: z.string().min(1, 'Body is required').max(10_000),
    description: z.string().max(500).optional(),
    isActive: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.channel === 'EMAIL' && !v.subject?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['subject'], message: 'Email templates need a subject' })
    }
  })

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_form'
    out[key] ??= issue.message
  }
  return out
}

export async function saveTemplateAction(raw: unknown): Promise<TemplateFormResult> {
  let user
  try {
    user = await requirePermission('connectors:manage')
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, errors: { _form: err.message } }
    throw err
  }

  const parsed = templateSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) }
  const input = parsed.data

  const data = {
    key: input.key,
    name: input.name,
    channel: input.channel,
    locale: input.locale.toLowerCase(),
    subject: input.channel === 'EMAIL' ? (input.subject?.trim() ?? '') : null,
    body: input.body,
    description: input.description?.trim() || null,
    isActive: input.isActive,
  }

  try {
    if (input.id) {
      const existing = await db.messageTemplate.findFirst({
        where: { id: input.id, organizationId: user.organizationId },
      })
      if (!existing) return { ok: false, errors: { _form: 'Template not found.' } }

      const updated = await db.messageTemplate.update({ where: { id: existing.id }, data })
      await recordAudit(user, {
        action: 'message_template.update',
        entityType: 'MessageTemplate',
        entityId: updated.id,
        summary: `Updated template ${updated.key} (${updated.locale})`,
        before: { name: existing.name, subject: existing.subject, body: existing.body, isActive: existing.isActive },
        after: { name: updated.name, subject: updated.subject, body: updated.body, isActive: updated.isActive },
      })
      revalidatePath('/settings/templates')
      return { ok: true, id: updated.id }
    }

    const created = await db.messageTemplate.create({
      data: { ...data, organizationId: user.organizationId, createdById: user.id },
    })
    await recordAudit(user, {
      action: 'message_template.create',
      entityType: 'MessageTemplate',
      entityId: created.id,
      summary: `Created template ${created.key} (${created.locale}, ${created.channel})`,
      after: { name: created.name, subject: created.subject, body: created.body, isActive: created.isActive },
    })
    revalidatePath('/settings/templates')
    return { ok: true, id: created.id }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { ok: false, errors: { key: 'A template with this key and locale already exists.' } }
    }
    throw err
  }
}

export async function deleteTemplateAction(id: string): Promise<TemplateFormResult> {
  let user
  try {
    user = await requirePermission('connectors:manage')
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, errors: { _form: err.message } }
    throw err
  }

  const existing = await db.messageTemplate.findFirst({ where: { id, organizationId: user.organizationId } })
  if (!existing) return { ok: false, errors: { _form: 'Template not found.' } }

  await db.messageTemplate.delete({ where: { id: existing.id } })
  await recordAudit(user, {
    action: 'message_template.delete',
    entityType: 'MessageTemplate',
    entityId: existing.id,
    summary: `Deleted template ${existing.key} (${existing.locale})`,
    before: { name: existing.name, subject: existing.subject, body: existing.body },
  })
  revalidatePath('/settings/templates')
  return { ok: true, id: existing.id }
}
