import 'server-only'
import { db } from '@/lib/db'
import type { SessionUser } from '@/lib/rbac'
import { addDays, dayKeyOf, dayStartUtc, weekStart } from './calendar/planner'
import { durationLabel, firstName, maskedNumber, timeLabel } from './history-format'
import { readFacebookFormEvent } from './meta-route'
import { visitLabel } from './app-shell'

/**
 * The dialer's team reads (docs/DIALER_APP.md §1 Team, §2 Today): today's
 * calls, results, texts and visit holds across the workspace, who is ready
 * on the phone, and the Booked numbers. Everyone on the desk sees the same
 * team list (a Closer too); no phone number leaves here except a last 4 for
 * a caller with no name.
 */

/** Ready in the last 2 minutes counts as on the phone. */
export const READY_WINDOW_MS = 2 * 60_000

const FEED_LIMIT = 40

export type TeamMember = {
  id: string
  name: string
  role: string
  ready: boolean
  calls: number
  talkSeconds: number
  booked: number
  /** Their newest call, text, result or visit hold today (ISO), or null. */
  lastAt: string | null
}

export type FeedKind = 'call' | 'missed' | 'outcome' | 'hold' | 'confirm' | 'sms'

export type FeedRow = { key: string; at: string; time: string; kind: FeedKind; text: string }

export type TeamToday = { members: TeamMember[]; feed: FeedRow[]; count: number }

export type TodayStats = {
  /** CONFIRMED + HOLD visits starting this week (Mon–Sun, Pacific). */
  bookedWeek: number
  /** Visits confirmed on the call today. */
  confirmedToday: number
  /** Each lead's next live visit (ISO start), for the Today rows. */
  appointments: Record<string, string>
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

/** "Nate F." from "Nate Fuller". */
export function shortName(name: string | null | undefined): string | null {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  if (words.length === 1) return words[0]
  return `${words[0]} ${words[words.length - 1][0].toUpperCase()}.`
}

/** The rep on a call: who placed it, else who answered it in the browser or on the team ring. */
export function callRepId(call: { userId: string | null; answeredBy: string | null }): string | null {
  if (call.userId) return call.userId
  const m = /^(?:browser|team):(.+)$/.exec(call.answeredBy ?? '')
  return m ? m[1] : null
}

export function isReady(presence: { state: string; lastSeenAt: Date } | undefined, now: Date): boolean {
  return Boolean(presence && presence.state === 'ready' && now.getTime() - presence.lastSeenAt.getTime() <= READY_WINDOW_MS)
}

type Take = { at: number; userId: string | null }

function holderAt(takes: Map<string, Take[]>, leadId: string, at: Date): string | null {
  let found: string | null = null
  for (const t of takes.get(leadId) ?? []) {
    if (t.at <= at.getTime()) found = t.userId
    else break
  }
  return found
}

const NOT_ANSWERED = new Set(['VOICEMAIL', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'DECLINED', 'FAILED'])
const MISS_WORD: Record<string, string> = { BUSY: 'busy', VOICEMAIL: 'voicemail', WRONG_NUMBER: 'wrong number', DECLINED: 'declined', FAILED: 'failed' }

function todayStart(now: Date): Date {
  return dayStartUtc(dayKeyOf(now))
}

/**
 * Today across the workspace: the activity feed (newest first) and each
 * active user's calls, talk time, visits booked and last activity.
 */
export async function loadTeamToday(user: SessionUser, now = new Date()): Promise<TeamToday> {
  const org = user.organizationId
  const since = todayStart(now)

  const [users, presence, calls, events, slots] = await Promise.all([
    db.user.findMany({
      where: { organizationId: org, isActive: true, deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, role: { select: { name: true } } },
    }),
    db.voicePresence.findMany({ where: { organizationId: org }, select: { userId: true, state: true, lastSeenAt: true } }),
    db.voiceCall.findMany({
      where: { organizationId: org, startedAt: { gte: since, lte: now } },
      orderBy: { startedAt: 'desc' },
      take: 500,
      select: {
        id: true, direction: true, status: true, outcome: true, startedAt: true, answeredAt: true, endedAt: true,
        talkSeconds: true, durationSeconds: true, userId: true, answeredBy: true, callCenterLeadId: true,
        clientId: true, remoteLast4: true, recordingKind: true,
      },
    }),
    db.callCenterEvent.findMany({
      where: { lead: { organizationId: org }, type: { in: ['OUTCOME', 'SMS'] }, createdAt: { gte: since, lte: now } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { id: true, leadId: true, type: true, body: true, direction: true, createdAt: true },
    }),
    db.callCenterSlot.findMany({
      where: { organizationId: org, OR: [{ createdAt: { gte: since, lte: now } }, { confirmedAt: { gte: since, lte: now } }] },
      take: 500,
      select: { id: true, leadId: true, startsAt: true, heldBy: true, createdAt: true, confirmedAt: true, confirmedById: true },
    }),
  ])

  const leadIds = [...new Set([
    ...calls.map((c) => c.callCenterLeadId),
    ...events.map((e) => e.leadId),
    ...slots.map((s) => s.leadId),
  ].filter((id): id is string => Boolean(id)))]

  const [forms, locks, leadRows] = leadIds.length
    ? await Promise.all([
        db.callCenterEvent.findMany({
          where: { leadId: { in: leadIds }, type: 'FORM' },
          orderBy: { createdAt: 'asc' },
          select: { leadId: true, body: true },
        }),
        db.callCenterEvent.findMany({
          where: { leadId: { in: leadIds }, type: 'LOCK', body: { contains: '"action":"take"' } },
          orderBy: { createdAt: 'asc' },
          select: { leadId: true, body: true, createdAt: true },
        }),
        db.callCenterLead.findMany({ where: { organizationId: org, id: { in: leadIds } }, select: { id: true, phoneLast4: true } }),
      ])
    : [[], [], []]

  const leadName = new Map<string, string>()
  for (const f of forms) {
    if (leadName.has(f.leadId)) continue
    const name = shortName(readFacebookFormEvent(f.body).name)
    if (name) leadName.set(f.leadId, name)
  }
  const last4 = new Map(leadRows.map((l) => [l.id, l.phoneLast4]))
  const leadLabel = (id: string | null, fallback4?: string | null) =>
    (id && leadName.get(id)) || maskedNumber((id && last4.get(id)) || fallback4)

  const takes = new Map<string, Take[]>()
  for (const r of locks) {
    const list = takes.get(r.leadId) ?? []
    list.push({ at: r.createdAt.getTime(), userId: str(readJson(r.body)?.userId) })
    takes.set(r.leadId, list)
  }

  const names = new Map(users.map((u) => [u.id, firstName(u.name) ?? u.name]))
  const who = (id: string | null) => (id && names.get(id)) || 'Someone'

  type Row = FeedRow & { actor: string | null }
  const rows: Row[] = []
  const push = (key: string, at: Date, kind: FeedKind, text: string, actor: string | null) =>
    rows.push({ key, at: at.toISOString(), time: timeLabel(at), kind, text, actor })

  const stats = new Map<string, { calls: number; talk: number; booked: number }>()
  const stat = (id: string) => {
    let s = stats.get(id)
    if (!s) stats.set(id, (s = { calls: 0, talk: 0, booked: 0 }))
    return s
  }

  for (const c of calls) {
    const rep = callRepId(c)
    const answered = c.outcome === 'CONNECTED' || (!c.outcome && Boolean(c.answeredAt))
    const talk = answered ? (c.talkSeconds ?? c.durationSeconds ?? 0) : 0
    if (rep) {
      const s = stat(rep)
      s.calls += 1
      s.talk += talk
    }
    const lead = c.clientId && !c.callCenterLeadId ? 'a client' : leadLabel(c.callCenterLeadId, c.remoteLast4)
    if (c.direction === 'OUTBOUND') {
      const how = answered
        ? `${durationLabel(talk)} · answered`
        : c.outcome && NOT_ANSWERED.has(c.outcome)
          ? (MISS_WORD[c.outcome] ?? 'no answer')
          : c.endedAt ? 'no answer' : 'calling'
      push(`c:${c.id}`, c.startedAt, 'call', `${who(rep)} called ${lead} · ${how}`, rep)
    } else if (answered) {
      push(`c:${c.id}`, c.startedAt, 'call', `${lead} called in · ${who(rep)} answered · ${durationLabel(talk)}`, rep)
    } else if (c.endedAt || c.outcome) {
      const what = c.recordingKind === 'voicemail' || c.outcome === 'VOICEMAIL' ? 'left a voicemail' : 'missed'
      push(`c:${c.id}`, c.startedAt, 'missed', `${lead} called in · ${what}`, null)
    }
  }

  for (const e of events) {
    const json = readJson(e.body)
    if (e.type === 'SMS') {
      if (e.direction === 'in') {
        push(`e:${e.id}`, e.createdAt, 'sms', `${leadLabel(e.leadId)} texted`, null)
      } else {
        const actor = str(json?.userId) ?? holderAt(takes, e.leadId, e.createdAt)
        push(`e:${e.id}`, e.createdAt, 'sms', `${who(actor)} texted ${leadLabel(e.leadId)}`, actor)
      }
      continue
    }
    const label = str(json?.label)
    if (!label) continue
    const actor = holderAt(takes, e.leadId, e.createdAt)
    push(`e:${e.id}`, e.createdAt, 'outcome', `${who(actor)} marked ${leadLabel(e.leadId)} · ${label}`, actor)
  }

  for (const s of slots) {
    if (s.createdAt.getTime() >= since.getTime()) {
      const auto = s.heldBy === 'autobook'
      const actor = auto ? null : holderAt(takes, s.leadId, s.createdAt)
      if (actor) stat(actor).booked += 1
      push(`h:${s.id}`, s.createdAt, 'hold', `${auto ? 'Auto-book' : who(actor)} booked ${leadLabel(s.leadId)} for ${visitLabel(s.startsAt.toISOString())}`, actor)
    }
    if (s.confirmedAt && s.confirmedAt.getTime() >= since.getTime()) {
      const actor = s.confirmedById ?? holderAt(takes, s.leadId, s.confirmedAt)
      push(`k:${s.id}`, s.confirmedAt, 'confirm', `${who(actor)} confirmed ${leadLabel(s.leadId)} for ${visitLabel(s.startsAt.toISOString())}`, actor)
    }
  }

  rows.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key))

  const lastAt = new Map<string, string>()
  for (const r of rows) if (r.actor && !lastAt.has(r.actor)) lastAt.set(r.actor, r.at)

  const ready = new Map(presence.map((p) => [p.userId, p]))
  const members: TeamMember[] = users.map((u) => {
    const s = stats.get(u.id)
    return {
      id: u.id,
      name: u.name,
      role: u.role.name,
      ready: isReady(ready.get(u.id), now),
      calls: s?.calls ?? 0,
      talkSeconds: s?.talk ?? 0,
      booked: s?.booked ?? 0,
      lastAt: lastAt.get(u.id) ?? null,
    }
  })

  return {
    members,
    count: rows.length,
    feed: rows.slice(0, FEED_LIMIT).map((r) => ({ key: r.key, at: r.at, time: r.time, kind: r.kind, text: r.text })),
  }
}

/** The Booked and Confirmed tiles, and each lead's next visit. */
export async function loadTodayStats(user: SessionUser, now = new Date()): Promise<TodayStats> {
  const org = user.organizationId
  const today = dayKeyOf(now)
  const since = dayStartUtc(today)
  const monday = weekStart(today)
  const [bookedWeek, confirmedToday, upcoming] = await Promise.all([
    db.callCenterSlot.count({
      where: {
        organizationId: org,
        status: { in: ['HOLD', 'CONFIRMED'] },
        startsAt: { gte: dayStartUtc(monday), lt: dayStartUtc(addDays(monday, 7)) },
      },
    }),
    db.callCenterSlot.count({ where: { organizationId: org, confirmedAt: { gte: since, lte: now } } }),
    db.callCenterSlot.findMany({
      where: { organizationId: org, status: { in: ['HOLD', 'CONFIRMED'] }, startsAt: { gte: since } },
      orderBy: { startsAt: 'asc' },
      take: 500,
      select: { leadId: true, startsAt: true },
    }),
  ])
  const appointments: Record<string, string> = {}
  for (const s of upcoming) appointments[s.leadId] ??= s.startsAt.toISOString()
  return { bookedWeek, confirmedToday, appointments }
}
