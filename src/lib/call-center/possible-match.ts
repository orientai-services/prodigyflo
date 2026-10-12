import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { can, type SessionUser } from '@/lib/rbac'
import { phoneHashOrNull } from '@/lib/telephony/compliance-core'
import { readSecret } from './contact'

/**
 * Lead ↔ Client linking (docs/CYS_BRIDGE.md §B1). `CallCenterLead.clientId`
 * is written here and nowhere else: by the SCS packet receiver when the
 * packet carries a valid `pfl` token, and by a manager from the
 * "Possible match" card. A link is never replaced: a second, different
 * Client is a conflict that is audited and left alone.
 */

export const POSSIBLE_MATCH_DAYS = 30

export type LeadLinkOutcome = 'linked' | 'same' | 'conflict' | 'missing'

export type AssistedIntake = { by: string; at: string; mode: string }

type LinkActor = { id: string | null; label: string }

function eventBody(detail: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ label: 'Intake link', detail, action: 'linked', ...extra })
}

/**
 * Link a desk lead to a Client in the same organization. Runs on `store`, so
 * the packet receiver can call it inside its transaction. Copies the lead's
 * phone and email onto the Client only where the Client's are empty.
 */
export async function applyLeadLink(
  store: Prisma.TransactionClient,
  input: {
    organizationId: string
    leadId: string
    clientId: string
    actor: LinkActor
    via: 'intake_token' | 'manual'
    tokenId?: string
    assisted?: AssistedIntake | null
  },
  at = new Date(),
): Promise<LeadLinkOutcome> {
  const lead = await store.callCenterLead.findFirst({
    where: { id: input.leadId, organizationId: input.organizationId },
    select: { id: true, clientId: true, phoneSecret: true, emailSecret: true },
  })
  const client = await store.client.findFirst({
    where: { id: input.clientId, organizationId: input.organizationId, deletedAt: null },
    select: { id: true, phone: true, email: true },
  })
  if (!lead || !client) return 'missing'
  if (lead.clientId === client.id) return 'same'
  if (lead.clientId) {
    const seen = await store.auditEvent.findFirst({
      where: { organizationId: input.organizationId, action: 'call_center.link_conflict', entityId: lead.id, summary: { contains: client.id } },
      select: { id: true },
    })
    if (!seen) {
      await store.auditEvent.create({
        data: {
          organizationId: input.organizationId,
          actorId: input.actor.id,
          actorLabel: input.actor.label,
          action: 'call_center.link_conflict',
          entityType: 'CallCenterLead',
          entityId: lead.id,
          summary: `Lead already linked to another client; kept it. Offered client ${client.id}`,
          before: { clientId: lead.clientId },
          after: { offeredClientId: client.id, via: input.via },
        },
      })
    }
    return 'conflict'
  }
  const claimed = await store.callCenterLead.updateMany({
    where: { id: lead.id, organizationId: input.organizationId, clientId: null },
    data: { clientId: client.id },
  })
  if (claimed.count !== 1) return 'conflict'

  const fill: { phone?: string; email?: string } = {}
  if (!client.phone.trim()) {
    const phone = readSecret(lead.phoneSecret)
    if (phone) fill.phone = phone
  }
  if (!client.email.trim()) {
    const email = readSecret(lead.emailSecret)
    if (email && email.includes('@')) fill.email = email
  }
  if (fill.phone || fill.email) await store.client.update({ where: { id: client.id }, data: fill })

  const detail = input.via === 'manual'
    ? `Linked to the client by ${input.actor.label}`
    : input.assisted
      ? `SCS intake received · linked (rep-assisted by ${input.assisted.by})`
      : 'SCS intake received · linked'
  await store.callCenterEvent.create({
    data: {
      leadId: lead.id,
      type: 'INTAKE_LINK',
      createdAt: at,
      body: eventBody(detail, {
        clientId: client.id,
        via: input.via,
        ...(input.tokenId ? { tokenId: input.tokenId } : {}),
        ...(input.assisted ? { assisted: input.assisted } : {}),
      }),
    },
  })
  await store.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      actorId: input.actor.id,
      actorLabel: input.actor.label,
      action: 'call_center.lead_linked',
      entityType: 'CallCenterLead',
      entityId: lead.id,
      summary: input.via === 'manual' ? 'Desk lead linked to a client by hand' : 'Desk lead linked by its SCS intake',
      before: { clientId: null },
      after: {
        clientId: client.id,
        via: input.via,
        ...(input.tokenId ? { tokenId: input.tokenId } : {}),
        ...(input.assisted ? { assisted: input.assisted } : {}),
        filled: Object.keys(fill),
      },
    },
  })
  return 'linked'
}

// ── Fallback: a possible match by phone ─────────────────────────────────────

export type PossibleMatch = {
  clientId: string
  firstName: string
  createdAt: string
  /** The viewer may press "Link" (clients:reassign or Super Admin). */
  canLink: boolean
}

/** clients:reassign or Super Admin. */
export function mayLink(user: SessionUser): boolean {
  return user.role === 'SUPER_ADMIN' || can(user, 'clients:reassign')
}

/**
 * One Client in the org, created in the last 30 days, whose phone is this
 * lead's phone. Never linked automatically: SCS cases are deliberately not
 * matched by identity, so a person decides. Shown to the lock holder and to
 * anyone who may link.
 */
export async function findPossibleMatch(user: SessionUser, leadId: string, now = new Date()): Promise<PossibleMatch | null> {
  const lead = await db.callCenterLead.findFirst({
    where: { id: leadId, organizationId: user.organizationId },
    select: { clientId: true, phoneHash: true, lockedBy: true },
  })
  if (!lead || lead.clientId || !lead.phoneHash) return null
  if (lead.lockedBy !== user.id && !mayLink(user)) return null
  const since = new Date(now.getTime() - POSSIBLE_MATCH_DAYS * 24 * 60 * 60 * 1000)
  const clients = await db.client.findMany({
    where: { organizationId: user.organizationId, deletedAt: null, createdAt: { gte: since } },
    select: { id: true, firstName: true, phone: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 2000,
  })
  const hits = clients.filter((c) => phoneHashOrNull(c.phone) === lead.phoneHash)
  if (hits.length !== 1) return null
  const hit = hits[0]
  return {
    clientId: hit.id,
    firstName: hit.firstName.trim().split(/\s+/)[0] || 'Client',
    createdAt: hit.createdAt.toISOString(),
    canLink: mayLink(user),
  }
}

export type LinkLeadResult = { ok: true } | { ok: false; reason: string }

export async function linkLeadToClientFor(
  user: SessionUser,
  leadId: string,
  clientId: string,
  now = new Date(),
): Promise<LinkLeadResult> {
  if (!mayLink(user)) return { ok: false, reason: "You don't have permission to link leads to clients." }
  const outcome = await db.$transaction((tx) =>
    applyLeadLink(tx, {
      organizationId: user.organizationId,
      leadId,
      clientId,
      actor: { id: user.id, label: `${user.name} (${user.roleName})` },
      via: 'manual',
    }, now),
  )
  if (outcome === 'missing') return { ok: false, reason: 'Lead or client not found.' }
  if (outcome === 'conflict') return { ok: false, reason: 'This lead is already linked to another client.' }
  return { ok: true }
}
