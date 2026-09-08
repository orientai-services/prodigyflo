'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ForbiddenError, requirePermission, requireUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import { bootstrapOrganization } from '@/lib/org/bootstrap'
import {
  clearActiveOrganizationCookie,
  isSwitchableTarget,
  setActiveOrganizationCookie,
} from '@/lib/org-switch'

export type CreateAccountState = { error?: string; ok?: boolean; name?: string }

const createAccountSchema = z.object({
  name: z.string().trim().min(2, 'Enter an account name.').max(80, 'Keep the name under 80 characters.'),
  slug: z
    .string()
    .trim()
    .max(64, 'Keep the slug under 64 characters.')
    .regex(/^[a-z0-9-]{3,}$/, 'Slugs are at least 3 characters: lowercase letters, numbers, and dashes only.'),
})

/**
 * Creates a new CLIENT account under the caller's agency. Gate mirrors the
 * /agency page: `users:manage` + the caller's HOME org must be the AGENCY —
 * deliberately no new permission key (see the plan: avoids the seed-sync trap).
 */
export async function createClientAccountAction(
  _prev: CreateAccountState,
  formData: FormData,
): Promise<CreateAccountState> {
  const user = await requirePermission('users:manage')
  if (user.organizationKind !== 'AGENCY') throw new ForbiddenError()

  const parsed = createAccountSchema.safeParse({
    name: formData.get('name'),
    slug: formData.get('slug'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const { name, slug } = parsed.data

  // Organization.slug is globally unique — a taken slug anywhere (any agency,
  // even a soft-deleted org) blocks the create, so say so plainly up front.
  const taken = await db.organization.findUnique({ where: { slug }, select: { id: true } })
  if (taken) return { error: 'That slug is already taken — account slugs are unique across the whole platform.' }

  const homeOrganizationId = user.homeOrganizationId ?? user.organizationId
  let organizationId: string
  try {
    ;({ organizationId } = await bootstrapOrganization(db, {
      name,
      slug,
      kind: 'CLIENT',
      parentOrganizationId: homeOrganizationId,
    }))
  } catch {
    // Lost a slug race with a concurrent create — same message as the pre-check.
    return { error: 'That slug is already taken — account slugs are unique across the whole platform.' }
  }

  // Close the other side of the slug race: bootstrapOrganization is
  // skip-if-exists by slug, so if the slug was claimed between our pre-check
  // and its own lookup it returns the EXISTING org instead of throwing. Never
  // audit (or report success for) an org this action did not actually create
  // under this agency.
  const created = await db.organization.findUnique({
    where: { id: organizationId },
    select: { parentOrganizationId: true, kind: true },
  })
  if (created?.parentOrganizationId !== homeOrganizationId || created.kind !== 'CLIENT') {
    return { error: 'That slug is already taken — account slugs are unique across the whole platform.' }
  }

  await recordAudit(user, {
    action: 'organization.created',
    entityType: 'Organization',
    entityId: organizationId,
    summary: `Created client account "${name}" (${slug})`,
    after: { name, slug, kind: 'CLIENT', parentOrganizationId: homeOrganizationId },
  })

  revalidatePath('/agency')
  return { ok: true, name }
}

/**
 * Switches the caller's ACTIVE organization. Any signed-in agency user may
 * switch (the sidebar switcher is not admin-only); eligibility is re-validated
 * here AND on every subsequent request by getSessionUser — the cookie is a
 * preference, never the security boundary.
 */
export async function switchOrganizationAction(orgId: string): Promise<void> {
  const user = await requireUser()
  if (user.organizationKind !== 'AGENCY') throw new ForbiddenError()

  const homeOrganizationId = user.homeOrganizationId ?? user.organizationId
  const target = await db.organization.findFirst({
    where: { id: orgId },
    select: { id: true, name: true, parentOrganizationId: true, deletedAt: true },
  })
  if (
    !target ||
    !isSwitchableTarget(
      { id: homeOrganizationId, kind: user.organizationKind },
      { id: target.id, parentOrganizationId: target.parentOrganizationId, deletedAt: target.deletedAt },
    )
  ) {
    throw new ForbiddenError('That account is not available to you.')
  }

  if (target.id === homeOrganizationId) {
    // Back home: dropping the preference IS the switch.
    await clearActiveOrganizationCookie()
  } else {
    await setActiveOrganizationCookie(user.id, target.id)
  }

  await recordAudit(user, {
    action: 'org.switched',
    entityType: 'Organization',
    entityId: target.id,
    summary: `Switched active account to ${target.name}`,
  })

  redirect('/dashboard')
}
