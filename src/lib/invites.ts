import 'server-only'
import bcrypt from 'bcryptjs'
import type { Prisma, RoleKey } from '@prisma/client'
import { db } from '@/lib/db'
import { hashValue, randomToken } from '@/lib/crypto'
import { recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/rbac'
import { STAFF_ROLES } from '@/lib/permissions'

export const INVITE_TTL_DAYS = 7

/** Super Admins have equal authority; legacy Owner flags grant no extra power. */
export function assignableRoles(actor: SessionUser): RoleKey[] {
  return actor.role === 'SUPER_ADMIN' ? [...STAFF_ROLES] : []
}

export function canManageUser(
  actor: SessionUser,
  _target: { id: string; roleKey: RoleKey; isOwner?: boolean },
): boolean {
  void _target
  return actor.role === 'SUPER_ADMIN'
}

export class InviteError extends Error {}

/**
 * Creates an invite and returns the ONE-TIME plaintext link token.
 * `email: null` makes an OPEN single-use link — whoever opens it first joins
 * with the chosen role, supplying their own email at acceptance.
 */
export async function createInvite(
  actor: SessionUser,
  input: { email: string | null; roleKey: RoleKey; teamId?: string | null; regionId?: string | null },
) {
  const email = input.email ? input.email.toLowerCase().trim() : null

  if (!assignableRoles(actor).includes(input.roleKey)) {
    throw new InviteError('You cannot grant that role.')
  }

  if (email) {
    // GLOBAL uniqueness, not per-org: login (src/lib/auth.ts) looks users up
    // by email alone, so the same address living in two organizations would
    // make one of the accounts unreachable. Every user-creation path must
    // enforce this — the schema only guards @@unique([organizationId, email]).
    const existing = await db.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    })
    if (existing) throw new InviteError('A user with that email already exists.')

    const pending = await db.invite.findFirst({
      where: { organizationId: actor.organizationId, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    })
    if (pending) throw new InviteError('That email already has a pending invite. Reset or revoke it instead.')
  }

  const role = await db.role.findFirst({
    where: { organizationId: actor.organizationId, key: input.roleKey },
  })
  if (!role) throw new InviteError('Role not found for this organization.')

  const team = await db.team.findFirst({ where: { organizationId: actor.organizationId, name: 'Team Prodigy' } })
  if (!team) throw new InviteError('The Team Prodigy workspace has not been initialized.')

  const token = randomToken(32)
  const invite = await db.invite.create({
    data: {
      organizationId: actor.organizationId,
      email,
      roleId: role.id,
      teamId: team.id,
      regionId: null,
      tokenHash: hashValue(token),
      invitedById: actor.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
    },
  })

  await recordAudit(actor, {
    action: 'invite.created',
    entityType: 'Invite',
    entityId: invite.id,
    summary: email ? `Invited ${email} as ${role.name}` : `Created a single-use ${role.name} invite link`,
  })

  return { invite, token }
}

/** Rotates the token on a pending invite and returns the new plaintext. */
export async function resetInviteLink(actor: SessionUser, inviteId: string) {
  const invite = await db.invite.findFirst({
    where: { id: inviteId, organizationId: actor.organizationId, acceptedAt: null, revokedAt: null },
    include: { role: true },
  })
  if (!invite) throw new InviteError('Invite not found or no longer pending.')
  if (!assignableRoles(actor).includes(invite.role.key)) throw new InviteError('You cannot manage that invite.')

  const token = randomToken(32)
  await db.invite.update({
    where: { id: invite.id },
    data: { tokenHash: hashValue(token), expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000) },
  })
  await recordAudit(actor, {
    action: 'invite.link_reset',
    entityType: 'Invite',
    entityId: invite.id,
    summary: `Reset invite link for ${invite.email}`,
  })
  return { token }
}

export async function revokeInvite(actor: SessionUser, inviteId: string) {
  const invite = await db.invite.findFirst({
    where: { id: inviteId, organizationId: actor.organizationId, acceptedAt: null, revokedAt: null },
    include: { role: true },
  })
  if (!invite) throw new InviteError('Invite not found or no longer pending.')
  if (!assignableRoles(actor).includes(invite.role.key)) throw new InviteError('You cannot manage that invite.')

  await db.invite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } })
  await recordAudit(actor, {
    action: 'invite.revoked',
    entityType: 'Invite',
    entityId: invite.id,
    summary: `Revoked invite for ${invite.email}`,
  })
}

/** Looks up a LIVE invite by its plaintext token. Null for anything not usable. */
export async function findLiveInvite(token: string) {
  if (!token || token.length < 20) return null
  return db.invite.findFirst({
    where: { tokenHash: hashValue(token), acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, role: { key: { in: STAFF_ROLES } } },
    include: { organization: { select: { name: true } }, role: true },
  })
}

/** Redeems an invite: creates the staff user. Returns the new user id. */
export async function acceptInvite(token: string, input: { name: string; password: string; email?: string }) {
  const invite = await findLiveInvite(token)
  if (!invite) throw new InviteError('This invite link is invalid, expired, or already used.')

  const email = invite.email ?? input.email?.toLowerCase().trim()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new InviteError('Enter a valid email address.')
  }

  const passwordHash = await bcrypt.hash(input.password, 10)

  // The uniqueness re-check and the accept happen atomically so two submits of
  // the same link cannot mint two users.
  const user = await db.$transaction(async (tx) => {
    const claimed = await tx.invite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date() },
    })
    if (claimed.count !== 1) throw new InviteError('This invite is no longer available.')
    // Global email uniqueness (see createInvite): login is org-blind, so a
    // duplicate in ANY organization would shadow one account at sign-in.
    const clash = await tx.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    })
    if (clash) throw new InviteError('A user with this email already exists. Sign in instead.')

    const user = await tx.user.create({
      data: {
        organizationId: invite.organizationId,
        roleId: invite.roleId,
        teamId: invite.teamId,
        regionId: invite.regionId,
        email,
        name: input.name.trim(),
        passwordHash,
        isActive: true,
        isOwner: false,
      },
    })
    await tx.invite.update({
      where: { id: invite.id },
      // Open links get stamped with the email that claimed them, for the record.
      data: { acceptedAt: new Date(), acceptedUserId: user.id, email },
    })
    await tx.auditEvent.create({
      data: {
        organizationId: invite.organizationId,
        actorId: user.id,
        actorLabel: `${user.name} (${invite.role.name})`,
        action: 'invite.accepted',
        entityType: 'Invite',
        entityId: invite.id,
        summary: `${email} joined as ${invite.role.name}`,
      },
    })
    return user
  })

  return user
}

/** Guard shared by deactivate + role change: never lose the last super admin. */
export async function assertNotLastSuperAdmin(organizationId: string, userId: string, store: Prisma.TransactionClient = db) {
  const target = await store.user.findFirst({
    where: { id: userId, organizationId },
    select: { role: { select: { key: true } } },
  })
  if (target?.role.key !== 'SUPER_ADMIN') return
  const others = await store.user.count({
    where: {
      organizationId,
      id: { not: userId },
      isActive: true,
      deletedAt: null,
      role: { key: 'SUPER_ADMIN' },
    },
  })
  if (others === 0) throw new InviteError('This is the last active Super Admin — the organization would be locked out.')
}
