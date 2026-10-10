import 'server-only'
import type { PermissionKey } from '@/lib/permissions'
import { effectivePermissions } from '@/lib/permissions'
import { db } from '@/lib/db'
import type { SessionUser } from '@/lib/rbac'
import { voiceIdentity } from './access-token'
import { MAX_BROWSER_LEGS } from './twiml'

/**
 * Who can take a browser call right now (P0b). Heartbeat-based — Vercel has no
 * long-lived sockets — so a tab POSTs /api/voice/presence every 60 s while its
 * Device is registered, and a row older than 90 s is not "present".
 *
 * Presence is per (user, organization): a user working in org A is registered
 * as pf_<A>_<user> and is never offered org B's calls.
 */

export const PRESENT_WITHIN_MS = 90_000
export const EXPIRE_AFTER_MS = 10 * 60_000

export async function touchPresence(user: Pick<SessionUser, 'id'>, organizationId: string, state: 'ready' | 'offline', now = new Date()): Promise<void> {
  const identity = voiceIdentity(organizationId, user.id)
  await db.voicePresence.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId } },
    create: { userId: user.id, organizationId, identity, state, lastSeenAt: now },
    update: { identity, state, lastSeenAt: now },
  })
}

export type PresentUser = { userId: string; identity: string }

/**
 * Ready browsers for a line's organization, in ring order: the line's own
 * user, then the caller's client owner, then everyone else newest first. Each
 * must be an active member of THAT organization with communications:send.
 */
export async function presentUsersFor(
  number: { organizationId: string; assignedUserId: string | null },
  callerClientOwnerId: string | null = null,
  now = new Date(),
): Promise<PresentUser[]> {
  const rows = await db.voicePresence.findMany({
    where: {
      organizationId: number.organizationId,
      state: 'ready',
      lastSeenAt: { gte: new Date(now.getTime() - PRESENT_WITHIN_MS) },
    },
    orderBy: { lastSeenAt: 'desc' },
    take: 50,
  })
  if (rows.length === 0) return []
  const users = await db.user.findMany({
    where: { id: { in: rows.map((r) => r.userId) }, organizationId: number.organizationId, isActive: true, deletedAt: null },
    select: { id: true, role: { select: { key: true, permissions: { select: { permission: { select: { key: true } } } } } } },
  })
  const allowed = new Set(
    users
      .filter((u) =>
        effectivePermissions(u.role.key, u.role.permissions.map((p) => p.permission.key as PermissionKey)).has('communications:send'),
      )
      .map((u) => u.id),
  )
  const present = rows.filter((r) => allowed.has(r.userId))
  const rank = (userId: string) => (userId === number.assignedUserId ? 0 : userId === callerClientOwnerId ? 1 : 2)
  return present
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r.userId) - rank(b.r.userId) || a.i - b.i)
    .slice(0, MAX_BROWSER_LEGS)
    .map(({ r }) => ({ userId: r.userId, identity: voiceIdentity(number.organizationId, r.userId) }))
}

export async function expirePresence(now = new Date()): Promise<number> {
  const res = await db.voicePresence.deleteMany({ where: { lastSeenAt: { lt: new Date(now.getTime() - EXPIRE_AFTER_MS) } } })
  return res.count
}
