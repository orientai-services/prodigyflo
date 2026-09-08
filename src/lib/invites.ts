import 'server-only'
import bcrypt from 'bcryptjs'
import type { RoleKey } from '@prisma/client'
import { db } from '@/lib/db'
import { hashValue, randomToken } from '@/lib/crypto'
import { recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/rbac'

export const INVITE_TTL_DAYS = 7

/**
 * Who may grant what. A user can only assign roles of strictly lower rank than
 * their own — except SUPER_ADMIN, who can mint peers. CLIENT is absent on
 * purpose: portal accounts are created from a Client record, never by invite.
 */
const RANK: Record<RoleKey, number> = {
  SUPER_ADMIN: 100,
  ADMIN: 80,
  REGIONAL_MANAGER: 60,
  SALES_MANAGER: 50,
  CLOSER: 40,
  DOCUMENT_COLLECTOR: 30,
  MARKETING: 30,
  CLIENT: 0,
}

const OWNER_RANK = 110

export function rankOf(role: RoleKey, isOwner = false): number {
  return isOwner ? OWNER_RANK : (RANK[role] ?? 0)
}

/** How many Super Admin seats exist besides the owner. Owner-adjustable later. */
export const SUPER_ADMIN_SEATS = 2

export function assignableRoles(actor: SessionUser): RoleKey[] {
  // Only the owner mints Super Admins; a Super Admin peer cannot. The owner
  // rank itself is never assignable — there is exactly one owner.
  return (Object.keys(RANK) as RoleKey[]).filter(
    (r) => r !== 'CLIENT' && (actor.isOwner ? RANK[r] <= RANK.SUPER_ADMIN : RANK[r] < rankOf(actor.role)),
  )
}

export function canManageUser(
  actor: SessionUser,
  target: { id: string; roleKey: RoleKey; isOwner?: boolean },
): boolean {
  if (actor.id === target.id) return false
  return rankOf(target.roleKey, target.isOwner) < rankOf(actor.role, actor.isOwner)
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

  if (input.roleKey === 'SUPER_ADMIN') {
    // Seats exclude the owner (who merely displays as Super Admin).
    const [seated, pendingSeats] = await Promise.all([
      db.user.count({
        where: { organizationId: actor.organizationId, deletedAt: null, isActive: true, isOwner: false, role: { key: 'SUPER_ADMIN' } },
      }),
      db.invite.count({
        where: { organizationId: actor.organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, isOwner: false, role: { key: 'SUPER_ADMIN' } },
      }),
    ])
    if (seated + pendingSeats >= SUPER_ADMIN_SEATS) {
      throw new InviteError(`All ${SUPER_ADMIN_SEATS} Super Admin seats are taken (counting pending invites). Revoke one first.`)
    }
  }

  const token = randomToken(32)
  const invite = await db.invite.create({
    data: {
      organizationId: actor.organizationId,
      email,
      roleId: role.id,
      teamId: input.teamId ?? null,
      regionId: input.regionId ?? null,
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
    where: { tokenHash: hashValue(token), acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
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
        isOwner: invite.isOwner,
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
export async function assertNotLastSuperAdmin(organizationId: string, userId: string) {
  const target = await db.user.findFirst({
    where: { id: userId, organizationId },
    select: { role: { select: { key: true } } },
  })
  if (target?.role.key !== 'SUPER_ADMIN') return
  const others = await db.user.count({
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
