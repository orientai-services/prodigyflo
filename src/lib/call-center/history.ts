import 'server-only'
import type { CallOutcome, CallCenterSlotStatus, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { can, clientScope, type SessionUser } from '@/lib/rbac'
import { ACTIVE_STATUSES, TERMINAL_STATUSES, recordingPath, visibleCallsWhere } from '@/lib/telephony/voice-calls'
import { calendarReps } from './calendar/config'
import { calendarTrailText } from './calendar/trail-text'
import { leadHref } from './lead-link'
import { withLeadPhones } from './lead-phones'
import { readFacebookFormEvent } from './meta-route'
import {
  HISTORY_PAGE,
  HISTORY_TZ,
  dayLabel,
  decodeCursor,
  firstName,
  maskPhones,
  maskedNumber,
  nameMatches,
  pageOf,
  parseSearch,
  timeLabel,
  type ActivityKind,
  type ActivityPage,
  type ActivityRow,
  type HistoryFilter,
  type HistoryPage,
  type HistoryRow,
  type HistoryRowKind,
} from './history-format'

/**
 * History (docs/DIALER_APP.md §3): every call and text the viewer may see,
 * and the desk's activity, newest first, 50 at a time.
 *
 * Scope mirrors `canSeeCall`: `telephony:manage` sees the whole organization;
 * anyone else sees calls they placed or answered, calls on their clients and
 * calls on leads they hold. Texts follow the same idea (their clients, leads
 * they hold, texts they sent). Names come from the lead's Facebook form or the
 * client record; a number never leaves here except as its last 4.
 */

/** Each source is read a little past the page so ties at the boundary still merge right. */
const SOURCE_TAKE = HISTORY_PAGE + 10

type Viewer = { user: SessionUser; manage: boolean; heldLeadIds: string[]; scopedClientIds: string[] }

async function viewerOf(user: SessionUser): Promise<Viewer> {
  const manage = can(user, 'telephony:manage')
  if (manage) return { user, manage, heldLeadIds: [], scopedClientIds: [] }
  const [held, scoped] = await Promise.all([
    db.callCenterLead.findMany({ where: { organizationId: user.organizationId, lockedBy: user.id }, select: { id: true } }),
    db.client.findMany({ where: clientScope(user), select: { id: true }, take: 5000 }),
  ])
  return { user, manage, heldLeadIds: held.map((r) => r.id), scopedClientIds: scoped.map((r) => r.id) }
}

function defined<T>(values: (T | null | undefined)[]): T[] {
  return [...new Set(values.filter((v): v is T => v != null))]
}

function readJson(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Free text shown in a list: phone numbers masked, any other long digit run hidden. */
function safe(text: string | null | undefined): string | null {
  if (!text) return null
  const out = maskPhones(text).replace(/\d{7,}/g, '····').trim()
  return out || null
}

async function userNames(organizationId: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const users = await db.user.findMany({ where: { organizationId, id: { in: ids } }, select: { id: true, name: true } })
  return new Map(users.map((u) => [u.id, u.name]))
}

type LeadInfo = { name: string | null; last4: string | null }

/** Lead display names from their Facebook form rows (the desk's own rule). */
async function leadInfo(organizationId: string, ids: string[]): Promise<Map<string, LeadInfo>> {
  if (!ids.length) return new Map()
  const leads = await db.callCenterLead.findMany({
    where: { organizationId, id: { in: ids } },
    select: {
      id: true,
      phoneLast4: true,
      events: { where: { type: 'FORM' }, orderBy: { createdAt: 'asc' }, take: 3, select: { body: true } },
    },
  })
  return new Map(
    leads.map((l) => {
      const name = l.events.map((e) => readFacebookFormEvent(e.body).name).find(Boolean) ?? null
      return [l.id, { name, last4: l.phoneLast4 }]
    }),
  )
}

function leadLabel(info: LeadInfo | undefined): string {
  return info?.name ?? maskedNumber(info?.last4)
}

type Search = { leadIds: string[]; clientIds: string[]; last4: string | null }

/** Search by a name (lead form name or client name) or by the last 4 of a number. */
async function resolveSearch(organizationId: string, q: string): Promise<Search | null> {
  const { last4, words } = parseSearch(q)
  if (last4) {
    const [leads, clients] = await Promise.all([
      db.callCenterLead.findMany({ where: { organizationId, phoneLast4: last4 }, select: { id: true }, take: 500 }),
      db.client.findMany({ where: { organizationId, deletedAt: null, phone: { endsWith: last4 } }, select: { id: true }, take: 500 }),
    ])
    return { last4, leadIds: leads.map((l) => l.id), clientIds: clients.map((c) => c.id) }
  }
  if (!words.length) return null
  const [forms, clients] = await Promise.all([
    db.callCenterEvent.findMany({
      where: { type: 'FORM', lead: { organizationId }, AND: words.map((w) => ({ body: { contains: w, mode: 'insensitive' as const } })) },
      select: { leadId: true, body: true },
      take: 1000,
    }),
    db.client.findMany({
      where: {
        organizationId,
        deletedAt: null,
        AND: words.map((w) => ({
          OR: [{ firstName: { contains: w, mode: 'insensitive' as const } }, { lastName: { contains: w, mode: 'insensitive' as const } }],
        })),
      },
      select: { id: true },
      take: 500,
    }),
  ])
  const leadIds = defined(forms.filter((f) => nameMatches(readFacebookFormEvent(f.body).name ?? '', words)).map((f) => f.leadId))
  return { last4: null, leadIds, clientIds: clients.map((c) => c.id) }
}

// ── Calls ───────────────────────────────────────────────────────────────────

const NOT_ANSWERED: CallOutcome[] = ['VOICEMAIL', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'DECLINED', 'FAILED']

function callFilterWhere(filter: HistoryFilter): Prisma.VoiceCallWhereInput {
  switch (filter) {
    case 'answered':
      return { outcome: 'CONNECTED' }
    case 'missed':
      return {
        direction: 'INBOUND',
        OR: [{ outcome: { in: NOT_ANSWERED } }, { outcome: null, answeredAt: null, status: { in: [...TERMINAL_STATUSES] } }],
      }
    case 'unattached':
      return { clientId: null, callCenterLeadId: null }
    default:
      return {}
  }
}

const OUTCOME_LABEL: Partial<Record<CallOutcome, string>> = {
  NO_ANSWER: 'No answer',
  BUSY: 'Busy',
  FAILED: 'Failed',
  DECLINED: 'Declined',
  WRONG_NUMBER: 'Wrong number',
  VOICEMAIL: 'Voicemail',
}

const STATUS_LABEL: Record<string, string> = { 'no-answer': 'No answer', busy: 'Busy', failed: 'Failed', canceled: 'Cancelled' }

type CallRow = Prisma.VoiceCallGetPayload<{
  select: {
    id: true; direction: true; status: true; outcome: true; startedAt: true; answeredAt: true; endedAt: true
    durationSeconds: true; talkSeconds: true; recordingSid: true; recordingDurationSeconds: true; recordingKind: true
    remoteLast4: true; clientId: true; callCenterLeadId: true; userId: true; answeredBy: true
    callbackRequested: true; transcript: true
  }
}>

function isActive(vc: CallRow): boolean {
  return !vc.endedAt && (ACTIVE_STATUSES as readonly string[]).includes(vc.status)
}

export function callKind(vc: Pick<CallRow, 'direction' | 'status' | 'outcome' | 'answeredAt' | 'endedAt' | 'recordingKind'>): HistoryRowKind {
  if (vc.direction === 'OUTBOUND') return 'out'
  if (vc.recordingKind === 'voicemail' || vc.outcome === 'VOICEMAIL') return 'voicemail'
  if (vc.outcome === 'CONNECTED' || vc.answeredAt) return 'in'
  if (!vc.endedAt && (ACTIVE_STATUSES as readonly string[]).includes(vc.status)) return 'in'
  return 'missed'
}

function callStatus(vc: CallRow, kind: HistoryRowKind): string | null {
  if (isActive(vc)) return vc.status === 'in-progress' ? 'On the call' : 'Ringing'
  if (kind === 'missed') return vc.callbackRequested ? 'Wants a callback' : 'Missed'
  if (kind === 'voicemail') return vc.callbackRequested ? 'Wants a callback' : null
  if (vc.outcome && vc.outcome !== 'CONNECTED') return OUTCOME_LABEL[vc.outcome] ?? null
  if (!vc.outcome && !vc.answeredAt) return STATUS_LABEL[vc.status] ?? null
  return null
}

function callSeconds(vc: CallRow, kind: HistoryRowKind): number | null {
  const s = kind === 'voicemail' ? vc.recordingDurationSeconds ?? vc.durationSeconds : vc.outcome === 'CONNECTED' || vc.answeredAt ? vc.talkSeconds ?? vc.durationSeconds : null
  return s && s > 0 ? s : null
}

function repId(vc: Pick<CallRow, 'userId' | 'answeredBy'>): string | null {
  if (vc.userId) return vc.userId
  const m = /^(?:browser|team):(.+)$/.exec(vc.answeredBy ?? '')
  return m ? m[1] : null
}

async function loadCalls(v: Viewer, filter: HistoryFilter, search: Search | null, before: Date | null, now: Date): Promise<HistoryRow[]> {
  const org = v.user.organizationId
  const searchWhere: Prisma.VoiceCallWhereInput | null = search
    ? {
        OR: [
          ...(search.leadIds.length ? [{ callCenterLeadId: { in: search.leadIds } }] : []),
          ...(search.clientIds.length ? [{ clientId: { in: search.clientIds } }] : []),
          ...(search.last4 ? [{ remoteLast4: search.last4 }] : []),
        ],
      }
    : null
  if (searchWhere && !searchWhere.OR?.length) return []
  const rows: CallRow[] = await db.voiceCall.findMany({
    where: {
      AND: [
        visibleCallsWhere(v.user, v.heldLeadIds, v.scopedClientIds),
        callFilterWhere(filter),
        ...(searchWhere ? [searchWhere] : []),
        ...(before ? [{ startedAt: { lte: before } }] : []),
      ],
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: SOURCE_TAKE,
    select: {
      id: true, direction: true, status: true, outcome: true, startedAt: true, answeredAt: true, endedAt: true,
      durationSeconds: true, talkSeconds: true, recordingSid: true, recordingDurationSeconds: true, recordingKind: true,
      remoteLast4: true, clientId: true, callCenterLeadId: true, userId: true, answeredBy: true,
      callbackRequested: true, transcript: true,
    },
  })
  if (!rows.length) return []

  const clientIds = defined(rows.map((r) => r.clientId))
  const [clients, leads, reps] = await Promise.all([
    clientIds.length
      ? db.client.findMany({ where: { AND: [clientScope(v.user), { id: { in: clientIds } }] }, select: { id: true, firstName: true, lastName: true } })
      : Promise.resolve([]),
    leadInfo(org, defined(rows.map((r) => r.callCenterLeadId))),
    userNames(org, defined(rows.map(repId))),
  ])
  const clientName = new Map(clients.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]))

  return rows.map((vc) => {
    const kind = callKind(vc)
    const visibleClient = vc.clientId && clientName.has(vc.clientId) ? vc.clientId : null
    const lead = vc.callCenterLeadId ? leads.get(vc.callCenterLeadId) : undefined
    const name = visibleClient ? clientName.get(visibleClient)! : lead?.name ?? maskedNumber(vc.remoteLast4 ?? lead?.last4)
    const rep = repId(vc)
    return {
      key: `vc:${vc.id}`,
      at: vc.startedAt.toISOString(),
      day: dayLabel(vc.startedAt, now),
      time: timeLabel(vc.startedAt),
      kind,
      name,
      rep: rep ? firstName(reps.get(rep)) : null,
      seconds: callSeconds(vc, kind),
      status: callStatus(vc, kind),
      recording: vc.recordingSid ? { src: recordingPath(vc.id), seconds: vc.recordingDurationSeconds ?? 0 } : null,
      transcript: kind === 'voicemail' ? safe(vc.transcript) : null,
      text: null,
      href: visibleClient ? `/clients/${encodeURIComponent(visibleClient)}` : lead ? leadHref(vc.callCenterLeadId!) : null,
      leadId: visibleClient ? null : vc.callCenterLeadId,
    }
  })
}

// ── Texts ───────────────────────────────────────────────────────────────────

async function loadClientTexts(v: Viewer, search: Search | null, before: Date | null, now: Date): Promise<HistoryRow[]> {
  const org = v.user.organizationId
  if (search && !search.clientIds.length) return []
  const scope: Prisma.CommunicationWhereInput = v.manage
    ? { client: { organizationId: org, deletedAt: null } }
    : { OR: [{ client: clientScope(v.user) }, { userId: v.user.id, client: { organizationId: org, deletedAt: null } }] }
  const rows = await db.communication.findMany({
    where: {
      AND: [
        scope,
        { channel: 'SMS', isInternal: false },
        ...(search ? [{ clientId: { in: search.clientIds } }] : []),
        ...(before ? [{ occurredAt: { lte: before } }] : []),
      ],
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: SOURCE_TAKE,
    select: {
      id: true, direction: true, status: true, body: true, occurredAt: true, clientId: true, userId: true,
      client: { select: { firstName: true, lastName: true } },
    },
  })
  if (!rows.length) return []
  const reps = await userNames(org, defined(rows.map((r) => r.userId)))
  return rows.map((c) => ({
    key: `cm:${c.id}`,
    at: c.occurredAt.toISOString(),
    day: dayLabel(c.occurredAt, now),
    time: timeLabel(c.occurredAt),
    kind: c.direction === 'INBOUND' ? 'sms-in' : 'sms-out',
    name: `${c.client.firstName} ${c.client.lastName}`.trim() || 'Client',
    rep: c.userId ? firstName(reps.get(c.userId)) : null,
    seconds: null,
    status: c.status === 'FAILED' ? 'Not sent' : c.status === 'QUEUED' ? 'Queued' : null,
    recording: null,
    transcript: null,
    text: safe(c.body) ?? '',
    href: `/clients/${encodeURIComponent(c.clientId)}`,
  }))
}

let directionColumnSeen = false

/**
 * `CallCenterEvent.direction` arrives with the Messages lane's migration.
 * Until it exists every lead text reads as outbound. Only a positive answer
 * is remembered, so the column is picked up as soon as it is migrated.
 */
async function leadTextDirections(ids: string[]): Promise<Map<string, 'in' | 'out'>> {
  if (!ids.length) return new Map()
  try {
    if (!directionColumnSeen) {
      const found = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'CallCenterEvent' AND column_name = 'direction' AND table_schema = current_schema()`
      if (!(Number(found[0]?.n) > 0)) return new Map()
      directionColumnSeen = true
    }
    const rows = await db.$queryRaw<{ id: string; direction: string | null }[]>`
      SELECT "id", "direction"::text AS "direction" FROM "CallCenterEvent" WHERE "id" = ANY(${ids})`
    return new Map(rows.filter((r) => r.direction === 'in' || r.direction === 'out').map((r) => [r.id, r.direction as 'in' | 'out']))
  } catch {
    return new Map()
  }
}

/** The stored body is the text itself, or the desk's `{ label, detail }` trail line. */
function leadTextBody(body: string): string {
  const json = readJson(body)
  if (!json) return body
  return str(json.text) ?? str(json.body) ?? str(json.detail) ?? ''
}

async function loadLeadTexts(v: Viewer, search: Search | null, before: Date | null, now: Date): Promise<HistoryRow[]> {
  const org = v.user.organizationId
  if (search && !search.leadIds.length) return []
  const rows = await db.callCenterEvent.findMany({
    where: {
      AND: [
        { type: 'SMS', lead: { organizationId: org } },
        ...(v.manage ? [] : [{ OR: [{ lead: { lockedBy: v.user.id } }, { body: { contains: `"userId":"${v.user.id}"` } }] }]),
        ...(search ? [{ leadId: { in: search.leadIds } }] : []),
        ...(before ? [{ createdAt: { lte: before } }] : []),
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: SOURCE_TAKE,
    select: { id: true, leadId: true, body: true, createdAt: true },
  })
  if (!rows.length) return []
  const userIdOf = (body: string) => str(readJson(body)?.userId)
  const [leads, reps, directions] = await Promise.all([
    leadInfo(org, defined(rows.map((r) => r.leadId))),
    userNames(org, defined(rows.map((r) => userIdOf(r.body)))),
    leadTextDirections(rows.map((r) => r.id)),
  ])
  return rows.map((e) => {
    const rep = userIdOf(e.body)
    return {
      key: `ev:${e.id}`,
      at: e.createdAt.toISOString(),
      day: dayLabel(e.createdAt, now),
      time: timeLabel(e.createdAt),
      kind: directions.get(e.id) === 'in' ? 'sms-in' : 'sms-out',
      name: leadLabel(leads.get(e.leadId)),
      rep: rep ? firstName(reps.get(rep)) : null,
      seconds: null,
      status: null,
      recording: null,
      transcript: null,
      text: safe(leadTextBody(e.body)) ?? '',
      href: leadHref(e.leadId),
      leadId: e.leadId,
    }
  })
}

/**
 * Calls & SMS. `filter` picks the sources (SMS reads texts only, the call
 * filters read calls only); `q` is a name or the last 4 of a number;
 * `cursor` is the `nextCursor` of the page before.
 */
export async function loadHistory(
  user: SessionUser,
  { filter = 'all', q = '', cursor = null }: { filter?: HistoryFilter; q?: string; cursor?: string | null } = {},
  now = new Date(),
): Promise<HistoryPage> {
  const cur = decodeCursor(cursor)
  const before = cur ? new Date(cur.at) : null
  const [v, search] = await Promise.all([viewerOf(user), resolveSearch(user.organizationId, q)])
  const calls = filter !== 'sms'
  const texts = filter === 'all' || filter === 'sms'
  const parts = await Promise.all([
    calls ? loadCalls(v, filter, search, before, now) : Promise.resolve([]),
    texts ? loadClientTexts(v, search, before, now) : Promise.resolve([]),
    texts ? loadLeadTexts(v, search, before, now) : Promise.resolve([]),
  ])
  const page = pageOf(parts.flat(), cur)
  // Full numbers for the leads this viewer may see; a nameless lead then reads as its number.
  const rows = (await withLeadPhones(user, page.rows, (r) => r.leadId)).map((r) =>
    r.phone?.state === 'shown' && r.name === maskedNumber(r.name.slice(-4)) ? { ...r, name: r.phone.display } : r,
  )
  return { ...page, rows }
}

// ── Activity ────────────────────────────────────────────────────────────────

const ACTIVITY_EVENT_TYPES = ['FORM', 'LOCK', 'OUTCOME', 'NOTE', 'INTAKE_LINK'] as const

const DESK_AUDIT: Record<string, { title: string; kind: ActivityKind }> = {
  'telephony.suppression_added': { title: 'Added to Do not call', kind: 'dnc' },
  'telephony.suppression_removed': { title: 'Removed from Do not call', kind: 'dnc' },
  'telephony.optout_review': { title: 'Possible opt-out', kind: 'dnc' },
  'telephony.consent_recorded': { title: 'Consent recorded', kind: 'audit' },
  'telephony.hours_override': { title: 'Calling hours overridden', kind: 'audit' },
  'telephony.missed_handled': { title: 'Missed call handled', kind: 'audit' },
  'telephony.timezone_set': { title: 'Time zone set', kind: 'audit' },
}

const SLOT_OUTCOME: Partial<Record<CallCenterSlotStatus, string>> = {
  SAT: 'Visit sat',
  NO_SHOW: 'No-show',
  CANCELLED: 'Visit cancelled',
  RESCHEDULED: 'Visit moved',
}

function visitWhen(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: HISTORY_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date)
}

type Take = { at: Date; userId: string | null; name: string | null }

/** Who held each lead over time, from its "took this lead" lines. Desk writes need the lock. */
async function lockHistory(leadIds: string[]): Promise<Map<string, Take[]>> {
  if (!leadIds.length) return new Map()
  const rows = await db.callCenterEvent.findMany({
    where: { leadId: { in: leadIds }, type: 'LOCK', body: { contains: '"action":"take"' } },
    orderBy: { createdAt: 'asc' },
    select: { leadId: true, body: true, createdAt: true },
  })
  const out = new Map<string, Take[]>()
  for (const r of rows) {
    const json = readJson(r.body)
    const list = out.get(r.leadId) ?? []
    list.push({ at: r.createdAt, userId: str(json?.userId), name: str(json?.name) })
    out.set(r.leadId, list)
  }
  return out
}

function holderAt(locks: Map<string, Take[]>, leadId: string, at: Date): Take | null {
  let found: Take | null = null
  for (const t of locks.get(leadId) ?? []) {
    if (t.at.getTime() <= at.getTime()) found = t
    else break
  }
  return found
}

/**
 * The desk's activity: results, notes, takes, intake links and new leads
 * (Call Center trail), visit holds / confirmations / outcomes (calendar),
 * and do-not-call, consent and override changes (audit), newest first.
 */
export async function loadActivity(
  user: SessionUser,
  { cursor = null }: { cursor?: string | null } = {},
  now = new Date(),
): Promise<ActivityPage> {
  const org = user.organizationId
  const manage = can(user, 'telephony:manage')
  const cur = decodeCursor(cursor)
  const lte = cur ? { lte: new Date(cur.at) } : undefined

  const eventScope: Prisma.CallCenterEventWhereInput = manage
    ? { lead: { organizationId: org } }
    : { lead: { organizationId: org }, OR: [{ lead: { lockedBy: user.id } }, { body: { contains: `"userId":"${user.id}"` } }] }
  const slotScope: Prisma.CallCenterSlotWhereInput = manage
    ? { organizationId: org }
    : { organizationId: org, OR: [{ lead: { lockedBy: user.id } }, { confirmedById: user.id }] }
  const slotSelect = {
    id: true, leadId: true, repKey: true, startsAt: true, status: true, heldBy: true,
    confirmedById: true, createdAt: true, confirmedAt: true, outcomeAt: true,
  } as const

  const [events, held, confirmed, ended, audits] = await Promise.all([
    db.callCenterEvent.findMany({
      where: {
        AND: [
          eventScope,
          { type: { in: [...ACTIVITY_EVENT_TYPES] } },
          { NOT: { type: 'LOCK', body: { contains: '"action":"skip"' } } },
          ...(lte ? [{ createdAt: lte }] : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: SOURCE_TAKE,
      select: { id: true, leadId: true, type: true, body: true, createdAt: true },
    }),
    db.callCenterSlot.findMany({
      where: { AND: [slotScope, ...(lte ? [{ createdAt: lte }] : [])] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: SOURCE_TAKE,
      select: slotSelect,
    }),
    db.callCenterSlot.findMany({
      where: { AND: [slotScope, { confirmedAt: lte ?? { not: null } }] },
      orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
      take: SOURCE_TAKE,
      select: slotSelect,
    }),
    db.callCenterSlot.findMany({
      where: { AND: [slotScope, { outcomeAt: lte ?? { not: null } }, { status: { in: Object.keys(SLOT_OUTCOME) as CallCenterSlotStatus[] } }] },
      orderBy: [{ outcomeAt: 'desc' }, { id: 'desc' }],
      take: SOURCE_TAKE,
      select: slotSelect,
    }),
    db.auditEvent.findMany({
      where: {
        organizationId: org,
        action: { in: Object.keys(DESK_AUDIT) },
        ...(manage ? {} : { actorId: user.id }),
        ...(lte ? { createdAt: lte } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: SOURCE_TAKE,
      select: { id: true, action: true, entityType: true, entityId: true, summary: true, actorId: true, actorLabel: true, createdAt: true },
    }),
  ])

  const auditLeadIds = audits.filter((a) => a.entityType === 'CallCenterLead' && a.entityId).map((a) => a.entityId)
  const auditClientIds = defined(audits.filter((a) => a.entityType === 'Client').map((a) => a.entityId))
  const leadIds = defined([...events.map((e) => e.leadId), ...[...held, ...confirmed, ...ended].map((s) => s.leadId), ...auditLeadIds])
  const userIds = defined([
    ...events.map((e) => str(readJson(e.body)?.userId)),
    ...confirmed.map((s) => s.confirmedById),
    ...audits.map((a) => a.actorId),
  ])
  const [leads, locks, clients] = await Promise.all([
    leadInfo(org, leadIds),
    lockHistory(leadIds),
    auditClientIds.length
      ? db.client.findMany({ where: { organizationId: org, id: { in: auditClientIds } }, select: { id: true, firstName: true, lastName: true } })
      : Promise.resolve([]),
  ])
  const lockUserIds = [...locks.values()].flat().map((t) => t.userId)
  const names = await userNames(org, defined([...userIds, ...lockUserIds]))
  const clientName = new Map(clients.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]))
  const reps = new Map(calendarReps().map((r) => [r.key, r.label]))

  const nameOf = (id: string | null | undefined, fallback?: string | null) => firstName((id && names.get(id)) || fallback || null)
  const holder = (leadId: string, at: Date) => {
    const t = holderAt(locks, leadId, at)
    return t ? nameOf(t.userId, t.name) : null
  }
  const stamp = (at: Date) => ({ at: at.toISOString(), day: dayLabel(at, now), time: timeLabel(at) })
  const aboutLead = (leadId: string) => ({ subject: leadLabel(leads.get(leadId)), href: leadHref(leadId) })

  const rows: ActivityRow[] = []

  for (const e of events) {
    const json = readJson(e.body)
    const label = safe(str(json?.label)) ?? ''
    // The calendar's own lines ("Calendar hold placed (dakota)") in words, as on the lead trail.
    const detail = safe(str(json?.detail) ?? (json ? null : (calendarTrailText(e.body) ?? e.body)))
    const who = nameOf(str(json?.userId), str(json?.name)) ?? holder(e.leadId, e.createdAt)
    const base = { key: `ev:${e.id}`, ...stamp(e.createdAt), ...aboutLead(e.leadId) }
    switch (e.type) {
      case 'FORM':
        rows.push({ ...base, kind: 'form', title: 'New lead', detail: 'Facebook form', who: 'Facebook' })
        break
      case 'LOCK':
        rows.push({ ...base, kind: 'lock', title: 'Took the lead', detail: null, who })
        break
      case 'NOTE':
        rows.push({ ...base, kind: 'note', title: 'Note', detail, who })
        break
      case 'INTAKE_LINK':
        rows.push({ ...base, kind: 'intake', title: 'Intake link sent', detail: detail && detail !== label ? detail : null, who })
        break
      default:
        rows.push({ ...base, kind: /do not call/i.test(label) ? 'dnc' : 'outcome', title: label || 'Result', detail, who })
    }
  }

  for (const s of held) {
    rows.push({
      key: `sh:${s.id}`,
      ...stamp(s.createdAt),
      ...aboutLead(s.leadId),
      kind: 'hold',
      title: 'Visit held',
      detail: `${visitWhen(s.startsAt)} · ${reps.get(s.repKey) ?? s.repKey}`,
      who: s.heldBy === 'autobook' ? 'Auto-book' : holder(s.leadId, s.createdAt),
    })
  }
  for (const s of confirmed) {
    if (!s.confirmedAt) continue
    rows.push({
      key: `sc:${s.id}`,
      ...stamp(s.confirmedAt),
      ...aboutLead(s.leadId),
      kind: 'confirm',
      title: 'Visit confirmed',
      detail: `${visitWhen(s.startsAt)} · ${reps.get(s.repKey) ?? s.repKey}`,
      who: nameOf(s.confirmedById) ?? holder(s.leadId, s.confirmedAt),
    })
  }
  for (const s of ended) {
    if (!s.outcomeAt) continue
    rows.push({
      key: `so:${s.id}`,
      ...stamp(s.outcomeAt),
      ...aboutLead(s.leadId),
      kind: 'visit',
      title: SLOT_OUTCOME[s.status] ?? 'Visit updated',
      detail: visitWhen(s.startsAt),
      who: holder(s.leadId, s.outcomeAt),
    })
  }
  for (const a of audits) {
    const spec = DESK_AUDIT[a.action] ?? { title: 'Update', kind: 'audit' as const }
    const lead = a.entityType === 'CallCenterLead' && a.entityId ? aboutLead(a.entityId) : null
    const client = a.entityType === 'Client' && a.entityId && clientName.has(a.entityId)
      ? { subject: clientName.get(a.entityId)!, href: `/clients/${encodeURIComponent(a.entityId)}` }
      : null
    rows.push({
      key: `au:${a.id}`,
      ...stamp(a.createdAt),
      kind: spec.kind,
      title: spec.title,
      detail: safe(a.summary),
      who: nameOf(a.actorId) ?? a.actorLabel ?? null,
      subject: lead?.subject ?? client?.subject ?? null,
      href: lead?.href ?? client?.href ?? null,
    })
  }

  return pageOf(rows, cur)
}
