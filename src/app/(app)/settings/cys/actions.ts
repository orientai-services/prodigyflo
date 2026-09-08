'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { canAny, requireUser, type SessionUser } from '@/lib/rbac'
import { CYS_DATA_TYPES, CYS_SOURCE_TYPES } from './constants'

export type DefinitionActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

const definitionSchema = z
  .object({
    id: z.string().optional(),
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, 'Lowercase letters, digits and underscores, starting with a letter.')
      .max(64),
    label: z.string().trim().min(1, 'A label is required.').max(120),
    groupName: z.string().trim().min(1, 'A group is required.').max(60),
    position: z.coerce.number().int().min(0).max(999),
    isRequired: z.boolean(),
    dataType: z.enum(CYS_DATA_TYPES),
    sourceType: z.enum(CYS_SOURCE_TYPES),
    sourcePath: z.string().trim().max(200).optional(),
    helpText: z.string().trim().max(500).optional(),
    isActive: z.boolean(),
  })
  .check((ctx) => {
    if (ctx.value.sourceType !== 'MANUAL' && !ctx.value.sourcePath) {
      ctx.issues.push({
        code: 'custom',
        message: 'A source path is required unless the field is manual.',
        path: ['sourcePath'],
        input: ctx.value.sourcePath,
      })
    }
  })

export type DefinitionInput = z.input<typeof definitionSchema>

/** Viewing the map needs submissions:prepare; editing it is a configuration act. */
async function requireEditor(): Promise<SessionUser | null> {
  const user = await requireUser()
  return canAny(user, ['pipeline:configure', 'org:manage']) ? user : null
}

export async function saveCysDefinitionAction(input: DefinitionInput): Promise<DefinitionActionResult> {
  const user = await requireEditor()
  if (!user) return { ok: false, error: 'You do not have permission to edit the CYS field map.' }

  const parsed = definitionSchema.safeParse(input)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message
    return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors }
  }
  const { id, ...data } = parsed.data
  const row = {
    ...data,
    sourcePath: data.sourceType === 'MANUAL' ? null : (data.sourcePath ?? null),
    helpText: data.helpText || null,
  }

  try {
    if (id) {
      const existing = await db.cysFieldDefinition.findFirst({
        where: { id, organizationId: user.organizationId },
      })
      if (!existing) return { ok: false, error: 'That field definition no longer exists.' }
      const updated = await db.cysFieldDefinition.update({ where: { id }, data: row })
      await recordAudit(user, {
        action: 'cys.definition_updated',
        entityType: 'CysFieldDefinition',
        entityId: id,
        summary: `Updated CYS field "${updated.label}" (${updated.key})`,
        before: {
          label: existing.label, groupName: existing.groupName, position: existing.position,
          isRequired: existing.isRequired, dataType: existing.dataType,
          sourceType: existing.sourceType, sourcePath: existing.sourcePath, isActive: existing.isActive,
        },
        after: row,
      })
    } else {
      const created = await db.cysFieldDefinition.create({
        data: { organizationId: user.organizationId, ...row },
      })
      await recordAudit(user, {
        action: 'cys.definition_created',
        entityType: 'CysFieldDefinition',
        entityId: created.id,
        summary: `Added CYS field "${created.label}" (${created.key})`,
        after: row,
      })
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return {
        ok: false,
        error: 'That key is already in use.',
        fieldErrors: { key: 'Another field already uses this key.' },
      }
    }
    throw error
  }

  revalidatePath('/settings/cys')
  return { ok: true, message: 'Field map saved.' }
}

const toggleSchema = z.object({ id: z.string().min(1), isActive: z.boolean() })

export async function toggleCysDefinitionAction(
  input: z.infer<typeof toggleSchema>,
): Promise<DefinitionActionResult> {
  const user = await requireEditor()
  if (!user) return { ok: false, error: 'You do not have permission to edit the CYS field map.' }

  const parsed = toggleSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid input.' }

  const existing = await db.cysFieldDefinition.findFirst({
    where: { id: parsed.data.id, organizationId: user.organizationId },
  })
  if (!existing) return { ok: false, error: 'That field definition no longer exists.' }

  await db.cysFieldDefinition.update({
    where: { id: existing.id },
    data: { isActive: parsed.data.isActive },
  })
  await recordAudit(user, {
    action: 'cys.definition_toggled',
    entityType: 'CysFieldDefinition',
    entityId: existing.id,
    summary: `${parsed.data.isActive ? 'Activated' : 'Deactivated'} CYS field "${existing.label}"`,
    before: { isActive: existing.isActive },
    after: { isActive: parsed.data.isActive },
  })

  revalidatePath('/settings/cys')
  return { ok: true, message: parsed.data.isActive ? 'Field activated.' : 'Field deactivated.' }
}
