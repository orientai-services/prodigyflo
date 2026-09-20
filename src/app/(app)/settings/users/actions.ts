'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { type RoleKey } from '@prisma/client'
import { CLOSER_EDITABLE_PERMISSIONS, type PermissionKey } from '@/lib/permissions'
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
    await db.$transaction(async (tx) => {
      await lockStaffChanges(tx, actor.organizationId, actor.id)
      if (!makeActive) await assertNotLastSuperAdmin(actor.organizationId, target.id, tx)
      if (makeActive && !assignableRoles(actor).includes(target.role.key)) throw new InviteError('This historical role cannot be reactivated.')
      await tx.user.update({ where: { id: target.id }, data: { isActive: makeActive } })
      if (!makeActive) {
        await tx.authToken.updateMany({ where: { userId: target.id, usedAt: null }, data: { usedAt: new Date() } })
        await detachCloser(tx, target.id)
      }
    })
  } catch (e) {
    return { error: e instanceof InviteError ? e.message : 'Could not update staff access.' }
  }

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

  const role = await db.role.findFirst({ where: { organizationId: actor.organizationId, key: roleKey } })
  if (!role) return { error: 'Role not found.' }
  try {
    await db.$transaction(async (tx) => {
      await lockStaffChanges(tx, actor.organizationId, actor.id)
      await assertNotLastSuperAdmin(actor.organizationId, target.id, tx)
      await tx.user.update({ where: { id: target.id }, data: { roleId: role.id, isOwner: false } })
      if (roleKey !== 'CLOSER') await detachCloser(tx, target.id)
    })
  } catch (e) {
    return { error: e instanceof InviteError ? e.message : 'Could not change role.' }
  }

  await recordAudit(actor, {
    action: 'user.role_changed',
    entityType: 'User',
    entityId: target.id,
    summary: `${target.email}: ${target.role.name} → ${role.name}`,
  })
  revalidatePath('/settings/users')
  return {}
}

async function lockStaffChanges(tx: import('@prisma/client').Prisma.TransactionClient, organizationId: string, actorId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff:${organizationId}`}))`
  const actor = await tx.user.findFirst({ where: { id: actorId, organizationId, isActive: true, deletedAt: null, role: { key: 'SUPER_ADMIN' } } })
  if (!actor) throw new InviteError('Your staff-management access changed. Reload and try again.')
}

async function detachCloser(tx: import('@prisma/client').Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM "Client" WHERE "ownerId" = ${userId} ORDER BY id FOR UPDATE`
  const now = new Date()
  await tx.appointment.updateMany({ where: { client: { ownerId: userId }, status: { in: ['SCHEDULED', 'CONFIRMED'] }, startsAt: { gte: now } }, data: { ownerId: null } })
  await tx.assignment.updateMany({ where: { assigneeId: userId, isActive: true }, data: { isActive: false, unassignedAt: now } })
  await tx.client.updateMany({ where: { ownerId: userId }, data: { ownerId: null } })
}

export type CloserPermissionState = { error?: string; saved?: boolean }
export async function updateCloserPermissionsAction(_prev: CloserPermissionState, formData: FormData): Promise<CloserPermissionState> {
  const actor = await requirePermission('roles:manage')
  const selected = formData.getAll('permission').map(String)
  if (selected.some((key) => !CLOSER_EDITABLE_PERMISSIONS.includes(key as PermissionKey))) return { error: 'Only listed Closer actions can be changed.' }
  const keys = [...new Set(['clients:read_assigned', ...selected])]
  try {
    await db.$transaction(async (tx) => {
      await lockStaffChanges(tx, actor.organizationId, actor.id)
      const role = await tx.role.findFirst({ where: { organizationId: actor.organizationId, key: 'CLOSER' } })
      if (!role) throw new InviteError('Closer role is not configured.')
      const before = await tx.rolePermission.findMany({ where: { roleId: role.id }, include: { permission: true } })
      const permissions = await tx.permission.findMany({ where: { key: { in: keys } } })
      if (permissions.length !== keys.length) throw new InviteError('Permission catalog is incomplete.')
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } })
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })) })
      await tx.auditEvent.create({ data: {
        organizationId: actor.organizationId, actorId: actor.id, actorLabel: `${actor.name} (Super Admin)`,
        action: 'role.closer_permissions_changed', entityType: 'Role', entityId: role.id,
        summary: 'Updated shared Closer action permissions; assignment scope is unchanged.',
        before: before.map((row) => row.permission.key), after: keys,
      } })
    })
  } catch (error) {
    return { error: error instanceof InviteError ? error.message : 'Could not update Closer permissions.' }
  }
  revalidatePath('/settings/users')
  return { saved: true }
}
