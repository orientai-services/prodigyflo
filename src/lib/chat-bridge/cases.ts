import 'server-only'
import { db } from '@/lib/db'
import { readFacebookFormEvent } from '@/lib/call-center/meta-route'
import { readSmsEvent } from '@/lib/call-center/messages-core'
import { linkedSunoffIdById } from './link'

/**
 * The case feed the chat Worker pulls (docs/CYS_BRIDGE.md §B4 "PF case chats",
 * Worker docs/CHAT_CONTRACT.md §14):
 *
 *   GET /api/bridge/chat/cases?since=<cursor>  (signed with PF_CHAT_KEY)
 *   → { ok, full: true, cases: [...], msgs: [...], cursor }
 *
 * `cases` is the full current set: every desk lead whose lock holder, or whose
 * linked Client's owner, has a SunOff link. Watchers are the org's linked
 * Super Admins (they hear @mentions only). `msgs` are the lead's texts
 * (CallCenterEvent SMS with a direction) newer than the cursor.
 *
 * Least data: the client's name as the desk shows it, the last four digits of
 * the phone, stage, appointment time. Never a full number, an email or an
 * address. The text body is what the chat mirrors, as the design asks.
 */

export const FEED_CASE_LIMIT = 500
export const FEED_MSG_LIMIT = 500
/** The first pull (no cursor) backfills this far. */
export const BACKFILL_DAYS = 14

export type FeedCase = {
  lead_id: string
  name: string
  rep_uid: string | null
  rep_name: string | null
  watchers: string[]
  stage: string
  closed: boolean
  appt_at: number | null
  phone4: string
  type: string
  updated_at: number
}
export type FeedMsg = {
  id: string
  lead_id: string
  dir: 'in' | 'out'
  via: 'sms'
  body: string
  at: number
  rep_uid: string | null
  rep_name: string | null
}
export type Feed = { ok: true; full: true; cases: FeedCase[]; msgs: FeedMsg[]; cursor: string }

/** Cursor = the newest text's time in ms. Equal-time rows are re-sent; the chat dedupes by id. */
export function parseCursor(raw: string | null | undefined, now: Date): Date {
  const n = Number(raw)
  if (raw && Number.isFinite(n) && n > 0 && n <= now.getTime()) return new Date(n)
  return new Date(now.getTime() - BACKFILL_DAYS * 86_400_000)
}

const STAGE: Record<string, string> = { WAITING: 'New', INBOUND: 'Inbound', MISSED: 'Missed', BOOKED: 'Booked' }

function shortName(name: string | null | undefined): string | null {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0]
}

export async function buildCaseFeed(since: string | null, now = new Date()): Promise<Feed> {
  const cursor = parseCursor(since, now)
  // Candidates: recently active desk leads someone holds or whose Client has an owner. Links are looked up forward
  // (ProdigyFlo stores none), once per distinct person, cached in ./link.
  const leads = await db.callCenterLead.findMany({
    where: { OR: [{ lockedBy: { not: null } }, { clientId: { not: null } }] },
    orderBy: { updatedAt: 'desc' },
    take: FEED_CASE_LIMIT,
    select: {
      id: true,
      organizationId: true,
      status: true,
      source: true,
      lockedBy: true,
      clientId: true,
      phoneLast4: true,
      doNotCallAt: true,
      updatedAt: true,
      events: { where: { type: 'FORM' }, select: { body: true }, take: 1 },
      calendarSlots: {
        where: { status: { in: ['HOLD', 'CONFIRMED'] }, startsAt: { gte: now } },
        orderBy: { startsAt: 'asc' },
        take: 1,
        select: { startsAt: true },
      },
    },
  })
  const clientIds = [...new Set(leads.flatMap((l) => (l.clientId ? [l.clientId] : [])))]
  const owners = clientIds.length
    ? await db.client.findMany({ where: { id: { in: clientIds }, deletedAt: null, ownerId: { not: null } }, select: { id: true, ownerId: true } })
    : []
  const ownerOf = new Map(owners.map((c) => [c.id, c.ownerId]))
  const orgIds = [...new Set(leads.map((l) => l.organizationId))]
  const admins = orgIds.length
    ? await db.user.findMany({ where: { organizationId: { in: orgIds }, isActive: true, deletedAt: null, role: { key: 'SUPER_ADMIN' } }, select: { id: true } })
    : []
  const people = [...new Set([...leads.flatMap((l) => (l.lockedBy ? [l.lockedBy] : [])), ...owners.flatMap((c) => (c.ownerId ? [c.ownerId] : [])), ...admins.map((a) => a.id)])]
  const resolved = (await Promise.all(people.slice(0, 300).map((id) => linkedSunoffIdById(id)))).filter((x): x is NonNullable<typeof x> => Boolean(x))
  const byId = new Map(resolved.map((r) => [r.user.id, r]))
  const uidOf = (pfUserId: string | null | undefined) => {
    const r = pfUserId ? byId.get(pfUserId) : undefined
    return r ? `u${r.sunoffUserId}` : null
  }
  const users = resolved.map((r) => ({ id: r.user.id, name: r.user.name, organizationId: r.user.organizationId, role: { key: r.user.role } }))
  if (!users.length) return { ok: true, full: true, cases: [], msgs: [], cursor: String(cursor.getTime()) }

  const userById = new Map(users.map((u) => [u.id, u]))
  const superAdminsByOrg = new Map<string, string[]>()
  for (const u of users) {
    if (u.role.key !== 'SUPER_ADMIN') continue
    const uid = uidOf(u.id)
    if (uid) superAdminsByOrg.set(u.organizationId, [...(superAdminsByOrg.get(u.organizationId) ?? []), uid])
  }

  const cases: FeedCase[] = []
  for (const lead of leads) {
    // The rep must be in the lead's own workspace: a link never crosses organizations.
    const lockRep = lead.lockedBy && userById.get(lead.lockedBy)?.organizationId === lead.organizationId ? lead.lockedBy : null
    const owner = lead.clientId ? ownerOf.get(lead.clientId) ?? null : null
    const ownerRep = owner && userById.get(owner)?.organizationId === lead.organizationId ? owner : null
    const repId = (lockRep && uidOf(lockRep) ? lockRep : null) ?? (ownerRep && uidOf(ownerRep) ? ownerRep : null)
    const repUid = uidOf(repId)
    const watchers = (superAdminsByOrg.get(lead.organizationId) ?? []).filter((w) => w !== repUid)
    // §B4: only leads whose holder or Client owner is linked; Super Admins watch those, never the rest.
    if (!repUid) continue
    let name: string | null = null
    for (const e of lead.events) name = name ?? readFacebookFormEvent(e.body).name
    const last4 = lead.phoneLast4 && /^\d{4}$/.test(lead.phoneLast4) ? lead.phoneLast4 : ''
    cases.push({
      lead_id: lead.id,
      name: (name ?? '').trim().slice(0, 80) || (last4 ? `Lead ••${last4}` : 'Lead'),
      rep_uid: repUid,
      rep_name: repId ? shortName(userById.get(repId)?.name) : null,
      watchers,
      stage: STAGE[lead.status] ?? lead.status,
      closed: Boolean(lead.doNotCallAt),
      appt_at: lead.calendarSlots[0]?.startsAt.getTime() ?? null,
      phone4: last4,
      type: String(lead.source).toLowerCase(),
      updated_at: lead.updatedAt.getTime(),
    })
  }

  const leadIds = cases.map((c) => c.lead_id)
  const rows = leadIds.length
    ? await db.callCenterEvent.findMany({
        where: { leadId: { in: leadIds }, type: 'SMS', direction: { in: ['in', 'out'] }, createdAt: { gte: cursor } },
        orderBy: { createdAt: 'asc' },
        take: FEED_MSG_LIMIT,
        select: { id: true, leadId: true, body: true, direction: true, createdAt: true },
      })
    : []
  const msgs: FeedMsg[] = rows.map((r) => {
    const copy = readSmsEvent(r.body)
    const authorUid = r.direction === 'out' ? uidOf(copy?.userId) : null
    return {
      id: r.id,
      lead_id: r.leadId,
      dir: r.direction === 'out' ? 'out' : 'in',
      via: 'sms',
      body: (copy?.detail ?? '').slice(0, 2000),
      at: r.createdAt.getTime(),
      rep_uid: authorUid,
      rep_name: authorUid && copy?.userId ? shortName(userById.get(copy.userId)?.name) : null,
    }
  })
  const newest = rows.length ? rows[rows.length - 1].createdAt.getTime() : cursor.getTime()
  return { ok: true, full: true, cases, msgs, cursor: String(newest) }
}
