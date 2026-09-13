'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { RoleKey } from '@prisma/client'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'
import {
  InviteError,
  assertNotLastSuperAdmin,
  assignableRoles,
  canManageUser,
  createInvite,
  resetInviteLink,
  revokeInvite,
} from '@/lib/invites'

export type InviteState = { error?: string; inviteUrl?: string; email?: string }

const inviteSchema = z.object({
  mode: z.enum(['email', 'link']).default('email'),
  email: z.email('Enter a valid email address.').optional(),
  roleKey: z.string().min(1, 'Pick a role.'),
  teamId: z.string().optional(),
})

function inviteUrl(token: string): string {
  const base = process.env.APP_URL || 'http://localhost:3300'
  return `${base}/invite/${token}`
}

export async function createInviteAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const actor = await requirePermission('users:manage')
  const parsed = inviteSchema.safeParse({
    mode: formData.get('mode') || 'email',
    email: formData.get('email') || undefined,
    roleKey: formData.get('roleKey'),
    teamId: formData.get('teamId') || undefined,
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  if (parsed.data.mode === 'email' && !parsed.data.email) return { error: 'Enter an email address.' }

  try {
    const { token } = await createInvite(actor, {
      email: parsed.data.mode === 'link' ? null : parsed.data.email!,
      roleKey: parsed.data.roleKey as RoleKey,
      teamId: parsed.data.teamId || null,
    })
    revalidatePath('/settings/users')
    return { inviteUrl: inviteUrl(token), email: parsed.data.mode === 'link' ? undefined : parsed.data.email!.toLowerCase().trim() }
  } catch (e) {
    return { error: e instanceof InviteError ? e.message : 'Could not create the invite.' }
  }
}

export async function resetInviteAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const actor = await requirePermission('users:manage')
  const id = String(formData.get('inviteId') ?? '')
  try {
    const { token } = await resetInviteLink(actor, id)
    revalidatePath('/settings/users')
    return { inviteUrl: inviteUrl(token) }
  } catch (e) {
    return { error: e instanceof InviteError ? e.message : 'Could not reset the link.' }
  }
}

export async function revokeInviteAction(formData: FormData): Promise<void> {
  const actor = await requirePermission('users:manage')
  try {
    await revokeInvite(actor, String(formData.get('inviteId') ?? ''))
  } catch {
    // Already accepted/revoked — the refreshed list tells the story.
  }
  revalidatePath('/settings/users')
}

export type UserActionState = { error?: string }

export type AccountRecoveryState = {
  error?: string
  recoveredEmail?: string
  sourceOrganization?: string
  preview?: {
    userId: string
    email: string
    sourceOrganization: string
    isOwner: boolean
    otherUserCount: number
    clientCount: number
  }
}

const recoverySchema = z.object({
  email: z.email('Enter a valid email address.').transform((value) => value.trim().toLowerCase()),
})

/**
 * Looks up an account before a cross-workspace recovery. It has no side effect:
 * the dialog must show the legacy workspace's actual user/client counts before
 * a separate, explicit recovery action may move or delete anything.
 */
export async function inspectExistingAccountAction(
  _prev: AccountRecoveryState,
  formData: FormData,
): Promise<AccountRecoveryState> {
  const actor = await requirePermission('users:manage')
  if (!actor.isOwner) return { error: 'Only the workspace owner can recover an account from another workspace.' }

  const parsed = recoverySchema.safeParse({ email: formData.get('email') })
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const target = await db.user.findFirst({
    where: { email: parsed.data.email, deletedAt: null },
    include: { role: true, organization: { select: { id: true, name: true } } },
  })
  if (!target) return { error: 'No active account exists for that email.' }
  if (target.organizationId === actor.organizationId) {
    return { error: 'That account is already in this workspace. Refresh the staff list.' }
  }

  const [otherUserCount, clientCount] = await Promise.all([
    db.user.count({ where: { organizationId: target.organizationId, id: { not: target.id }, deletedAt: null } }),
    db.client.count({ where: { organizationId: target.organizationId, deletedAt: null } }),
  ])

  return {
    preview: {
      userId: target.id,
      email: target.email,
      sourceOrganization: target.organization.name,
      isOwner: target.isOwner,
      otherUserCount,
      clientCount,
    },
  }
}

/** Moves the inspected account, deleting only a proven-empty legacy workspace. */
export async function completeAccountRecoveryAction(
  _prev: AccountRecoveryState,
  formData: FormData,
): Promise<AccountRecoveryState> {
  const actor = await requirePermission('users:manage')
  if (!actor.isOwner) return { error: 'Only the workspace owner can recover an account from another workspace.' }
  const userId = String(formData.get('userId') ?? '')
  if (!userId) return { error: 'Account recovery details are missing. Inspect the account again.' }

  const target = await db.user.findFirst({
    where: { id: userId, deletedAt: null },
    include: { role: true, organization: { select: { id: true, name: true } } },
  })
  if (!target || target.organizationId === actor.organizationId) {
    return { error: 'That account is no longer recoverable. Refresh and inspect it again.' }
  }

  const [otherUserCount, clientCount, adminRole] = await Promise.all([
    db.user.count({ where: { organizationId: target.organizationId, id: { not: target.id }, deletedAt: null } }),
    db.client.count({ where: { organizationId: target.organizationId, deletedAt: null } }),
    db.role.findFirst({ where: { organizationId: actor.organizationId, key: RoleKey.ADMIN }, select: { id: true } }),
  ])
  if (!adminRole) return { error: 'The Admin role is not configured in this workspace.' }

  if (target.isOwner && (otherUserCount > 0 || clientCount > 0)) {
    return {
      error: `The ${target.organization.name} workspace has ${otherUserCount} other staff member(s) and ${clientCount} client record(s). It was not deleted.`,
    }
  }
  if (!target.isOwner && target.role.key === RoleKey.SUPER_ADMIN) {
    try {
      await assertNotLastSuperAdmin(target.organizationId, target.id)
    } catch (e) {
      return { error: e instanceof InviteError ? e.message : 'This account cannot be moved safely.' }
    }
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: {
        organizationId: actor.organizationId,
        roleId: adminRole.id,
        regionId: null,
        teamId: null,
        managerId: null,
        isActive: true,
        isOwner: false,
      },
    })
    if (target.isOwner) await tx.organization.delete({ where: { id: target.organizationId } })
  })
  await recordAudit(actor, {
    action: 'user.recovered_to_workspace',
    entityType: 'User',
    entityId: target.id,
    summary: `${target.isOwner ? `Deleted empty legacy workspace ${target.organization.name} and recovered` : 'Recovered'} ${target.email} as Admin / Operations.`,
    before: { organizationId: target.organizationId, role: target.role.key },
    after: { organizationId: actor.organizationId, role: RoleKey.ADMIN },
  })
  revalidatePath('/settings/users')
  return { recoveredEmail: target.email, sourceOrganization: target.organization.name }
}

export async function setUserActiveAction(_prev: UserActionState, formData: FormData): Promise<UserActionState> {
  const actor = await requirePermission('users:manage')
  const userId = String(formData.get('userId') ?? '')
  const makeActive = formData.get('active') === 'true'

  const target = await db.user.findFirst({
    where: { id: userId, organizationId: actor.organizationId, deletedAt: null },
    include: { role: true },
  })
  if (!target) return { error: 'User not found.' }
  if (!canManageUser(actor, { id: target.id, roleKey: target.role.key, isOwner: target.isOwner })) {
    return { error: 'You cannot manage that user.' }
  }

  try {
    if (!makeActive) await assertNotLastSuperAdmin(actor.organizationId, target.id)
  } catch (e) {
    return { error: e instanceof InviteError ? e.message : 'Blocked.' }
  }

  await db.user.update({ where: { id: target.id }, data: { isActive: makeActive } })
  await recordAudit(actor, {
    action: makeActive ? 'user.reactivated' : 'user.deactivated',
    entityType: 'User',
    entityId: target.id,
    summary: `${makeActive ? 'Reactivated' : 'Deactivated'} ${target.email}`,
  })
  revalidatePath('/settings/users')
  return {}
}

export async function changeRoleAction(_prev: UserActionState, formData: FormData): Promise<UserActionState> {
  const actor = await requirePermission('users:manage')
  const userId = String(formData.get('userId') ?? '')
  const roleKey = String(formData.get('roleKey') ?? '') as RoleKey

  const target = await db.user.findFirst({
    where: { id: userId, organizationId: actor.organizationId, deletedAt: null },
    include: { role: true },
  })
  if (!target) return { error: 'User not found.' }
  if (!canManageUser(actor, { id: target.id, roleKey: target.role.key, isOwner: target.isOwner })) {
    return { error: 'You cannot manage that user.' }
  }
  if (!assignableRoles(actor).includes(roleKey)) return { error: 'You cannot grant that role.' }
  if (target.role.key === roleKey) return {}

  try {
    await assertNotLastSuperAdmin(actor.organizationId, target.id)
  } catch (e) {
    return { error: e instanceof InviteError ? e.message : 'Blocked.' }
  }

  const role = await db.role.findFirst({ where: { organizationId: actor.organizationId, key: roleKey } })
  if (!role) return { error: 'Role not found.' }

  await db.user.update({ where: { id: target.id }, data: { roleId: role.id } })
  await recordAudit(actor, {
    action: 'user.role_changed',
    entityType: 'User',
    entityId: target.id,
    summary: `${target.email}: ${target.role.name} → ${role.name}`,
  })
  revalidatePath('/settings/users')
  return {}
}
