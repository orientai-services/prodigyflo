import 'server-only'
import { db } from '@/lib/db'
import { clientScope, userScope, type SessionUser } from '@/lib/rbac'
import { getCloseOpsConfig, getHotLeads, type HotLead } from '@/lib/closeops'
import { canCoach, coachingVisibleWhere } from '@/lib/coaching'
import { nurtureStatus, type NurtureStatus } from '@/lib/nurture'
import { adherencePct, parseAdherence } from '@/lib/adherence'

/**
 * Daily Huddle Board — the Phase 1 operating rhythm ("mandatory morning
 * huddles + end-of-day wraps") as one page read aloud in a stand-up.
 *
 * Everything here is measurement over the caller's `clientScope`: a manager
 * huddles the team, a closer huddles their own pipeline. AI numbers surface
 * only as prioritization signals — the huddle informs, humans act.
 */

// ── Pure date/timezone helpers (tested in huddle.test.ts) ────────────────────

export type HuddleMode = 'morning' | 'wrap'

/** Local hour (14:00) after which the board defaults to the end-of-day wrap. */
export const WRAP_CUTOVER_HOUR = 14

export type ZonedParts = {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
}

const partFormatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let dtf = partFormatters.get(timeZone)
  if (!dtf) {
    try {
      dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    } catch {
      // An unknown IANA name in Organization.timezone must never crash the
      // huddle — fall back to UTC rather than throwing at render time.
      dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    }
    partFormatters.set(timeZone, dtf)
  }
  return dtf
}

/** Wall-clock parts of an instant in a timezone. Invalid zones read as UTC. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // `hour12: false` can format midnight as "24" in some ICU versions.
    hour: get('hour') % 24,
    minute: get('minute'),
  }
}

/** Local hour of day (0-23) in the org timezone. */
export function localHour(date: Date, timeZone: string): number {
  return zonedParts(date, timeZone).hour
}

/** Morning before 14:00 org time, end-of-day wrap after. */
export function defaultHuddleMode(date: Date, timeZone: string): HuddleMode {
  return localHour(date, timeZone) < WRAP_CUTOVER_HOUR ? 'morning' : 'wrap'
}

/**
 * The UTC instant of a local wall-clock time in `timeZone`. Iterative offset
 * correction, so DST transitions land on the right side of the fold.
 */
export function utcFromZoned(
  timeZone: string,
  year: number,
  month: number, // 1-12
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute)
  let ts = target
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(ts), timeZone)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    ts += target - asUtc
  }
  return new Date(ts)
}

/**
 * [start, end) of the local calendar day containing `date`, as UTC instants.
 * `dayOffset` shifts whole local days: -1 = yesterday, +1 = tomorrow.
 */
export function dayRangeUtc(
  date: Date,
  timeZone: string,
  dayOffset = 0,
): { start: Date; end: Date } {
  const p = zonedParts(date, timeZone)
  // Roll the local calendar date via UTC math so month/year carries are exact.
  const rolled = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset))
  const y = rolled.getUTCFullYear()
  const m = rolled.getUTCMonth() + 1
  const d = rolled.getUTCDate()
  return {
    start: utcFromZoned(timeZone, y, m, d, 0, 0),
    end: utcFromZoned(timeZone, y, m, d + 1, 0, 0),
  }
}

// ── Shared context ───────────────────────────────────────────────────────────

/** The org's IANA timezone — the clock every huddle range is cut against. */
export async function getOrgTimezone(organizationId: string): Promise<string> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  })
  return org?.timezone ?? 'America/Los_Angeles'
}

export type HuddleAppointment = {
  id: string
  startsAt: Date
  type: string
  status: string
  clientId: string
  clientName: string
  ownerName: string | null
  aiCloseProbability: number | null
  nurture: NurtureStatus
}

function appointmentSelect() {
  return {
    id: true,
    startsAt: true,
    type: true,
    status: true,
    owner: { select: { name: true } },
    client: {
      select: {
        id: true,
        firstName: true,
        lastName: true,
        aiCloseProbability: true,
        nurtureTouches: { select: { confirmedAt: true } },
      },
    },
  } as const
}

type AppointmentRow = {
  id: string
  startsAt: Date
  type: string
  status: string
  owner: { name: string } | null
  client: {
    id: string
    firstName: string
    lastName: string
    aiCloseProbability: number | null
    nurtureTouches: { confirmedAt: Date | null }[]
  }
}

function toHuddleAppointment(a: AppointmentRow): HuddleAppointment {
  return {
    id: a.id,
    startsAt: a.startsAt,
    type: a.type,
    status: a.status,
    clientId: a.client.id,
    clientName: `${a.client.firstName} ${a.client.lastName}`,
    ownerName: a.owner?.name ?? null,
    aiCloseProbability: a.client.aiCloseProbability,
    nurture: nurtureStatus(a.client.nurtureTouches),
  }
}

// ── Morning huddle ───────────────────────────────────────────────────────────

export type LeakingLead = {
  id: string
  firstName: string
  lastName: string
  stageName: string
  ownerName: string | null
  lastActivityAt: Date
  aiCloseProbability: number | null
}

export type MorningHuddle = {
  timezone: string
  hotLeadThreshold: number
  leakageDays: number
  /** SCHEDULED/CONFIRMED appointments inside today's org-tz day. */
  appointments: HuddleAppointment[]
  /** Top of the call queue — hottest first. */
  hotLeads: HotLead[]
  /** Live, non-terminal leads silent past the leakage window (oldest first). */
  leaking: LeakingLead[]
  leakingTotal: number
  yesterday: { calls: number; wins: number; revenue: number }
}

const LEAK_LIST_LIMIT = 8

export async function getMorningHuddle(user: SessionUser, now = new Date()): Promise<MorningHuddle> {
  const [timezone, config] = await Promise.all([
    getOrgTimezone(user.organizationId),
    getCloseOpsConfig(user.organizationId),
  ])
  const scope = clientScope(user)
  const today = dayRangeUtc(now, timezone)
  const yesterday = dayRangeUtc(now, timezone, -1)
  const leakageCutoff = new Date(now.getTime() - config.leakageDays * 86_400_000)

  const leakingWhere = {
    ...scope,
    status: 'ACTIVE' as const,
    currentStage: { isTerminal: false },
    lastActivityAt: { lt: leakageCutoff },
  }

  const [appointments, hotLeads, leakingRows, leakingTotal, yCalls, yWon] = await Promise.all([
    db.appointment.findMany({
      where: {
        status: { in: ['SCHEDULED', 'CONFIRMED'] },
        startsAt: { gte: today.start, lt: today.end },
        client: scope,
      },
      orderBy: { startsAt: 'asc' },
      select: appointmentSelect(),
    }),
    getHotLeads(user, config, 10),
    db.client.findMany({
      where: leakingWhere,
      orderBy: { lastActivityAt: 'asc' },
      take: LEAK_LIST_LIMIT,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        lastActivityAt: true,
        aiCloseProbability: true,
        currentStage: { select: { name: true } },
        owner: { select: { name: true } },
      },
    }),
    db.client.count({ where: leakingWhere }),
    db.communication.count({
      where: {
        channel: 'CALL',
        occurredAt: { gte: yesterday.start, lt: yesterday.end },
        client: scope,
      },
    }),
    db.deal.aggregate({
      where: { status: 'WON', wonAt: { gte: yesterday.start, lt: yesterday.end }, client: scope },
      _count: { _all: true },
      _sum: { value: true },
    }),
  ])

  return {
    timezone,
    hotLeadThreshold: config.hotLeadThreshold,
    leakageDays: config.leakageDays,
    appointments: appointments.map(toHuddleAppointment),
    hotLeads,
    leaking: leakingRows.map((c) => ({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      stageName: c.currentStage.name,
      ownerName: c.owner?.name ?? null,
      lastActivityAt: c.lastActivityAt,
      aiCloseProbability: c.aiCloseProbability,
    })),
    leakingTotal,
    yesterday: {
      calls: yCalls,
      wins: yWon._count._all,
      revenue: Number(yWon._sum.value ?? 0),
    },
  }
}

// ── End-of-day wrap ──────────────────────────────────────────────────────────

export type CloserDayRow = {
  id: string
  name: string
  calls: number
  /** % of today's calls with a viewed brief generated before the call. */
  briefedPct: number | null
  wins: number
}

export type EodWrap = {
  timezone: string
  calls: number
  /** Average funnel adherence across today's scored calls. */
  avgAdherencePct: number | null
  adherenceScored: number
  wins: number
  revenue: number
  briefsGenerated: number
  briefsViewed: number
  nurtureSent: number
  nurtureConfirmed: number
  qaNotes: number
  /** Per-closer mini-rows; null when the caller only sees themself. */
  closers: CloserDayRow[] | null
  /** SCHEDULED/CONFIRMED appointments inside tomorrow's org-tz day. */
  tomorrow: HuddleAppointment[]
}

export async function getEodWrap(user: SessionUser, now = new Date()): Promise<EodWrap> {
  const timezone = await getOrgTimezone(user.organizationId)
  const scope = clientScope(user)
  const today = dayRangeUtc(now, timezone)
  const tomorrow = dayRangeUtc(now, timezone, 1)
  const inToday = { gte: today.start, lt: today.end }

  const [calls, wonDeals, briefsGenerated, briefsViewed, nurtureSent, nurtureConfirmed, qaNotes, tomorrowAppts] =
    await Promise.all([
      db.communication.findMany({
        where: { channel: 'CALL', occurredAt: inToday, client: scope },
        select: {
          userId: true,
          clientId: true,
          occurredAt: true,
          user: { select: { name: true } },
          call: { select: { adherence: true } },
        },
      }),
      db.deal.findMany({
        where: { status: 'WON', wonAt: inToday, client: scope },
        select: { value: true, client: { select: { ownerId: true } } },
      }),
      db.closerBrief.count({
        where: { organizationId: user.organizationId, generatedAt: inToday, client: scope },
      }),
      db.closerBrief.count({
        where: { organizationId: user.organizationId, viewedAt: inToday, client: scope },
      }),
      db.nurtureTouch.count({
        where: { organizationId: user.organizationId, sentAt: inToday, client: scope },
      }),
      db.nurtureTouch.count({
        where: { organizationId: user.organizationId, confirmedAt: inToday, client: scope },
      }),
      db.coachingNote.count({
        where: { AND: [coachingVisibleWhere(user), { createdAt: inToday }] },
      }),
      db.appointment.findMany({
        where: {
          status: { in: ['SCHEDULED', 'CONFIRMED'] },
          startsAt: { gte: tomorrow.start, lt: tomorrow.end },
          client: scope,
        },
        orderBy: { startsAt: 'asc' },
        select: appointmentSelect(),
      }),
    ])

  // Average adherence over calls that recorded a checklist.
  const scored = calls
    .map((c) => adherencePct(parseAdherence(c.call?.adherence)))
    .filter((p): p is number => p !== null)
  const avgAdherencePct =
    scored.length > 0 ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null

  const revenue = wonDeals.reduce((sum, d) => sum + Number(d.value), 0)

  // Per-closer mini-rows for anyone with team-or-wider reach.
  let closers: CloserDayRow[] | null = null
  if (canCoach(user)) {
    const roster = await db.user.findMany({
      where: { AND: [userScope(user), { role: { key: 'CLOSER' }, isActive: true }] },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })

    // Was each call preceded by a viewed brief? (Mirrors closeops adoption.)
    const clientIds = [...new Set(calls.map((c) => c.clientId))]
    const briefs =
      clientIds.length > 0
        ? await db.closerBrief.findMany({
            where: {
              organizationId: user.organizationId,
              clientId: { in: clientIds },
              viewedAt: { not: null },
            },
            select: { clientId: true, generatedAt: true },
          })
        : []
    const earliestBrief = new Map<string, number>()
    for (const b of briefs) {
      const t = b.generatedAt.getTime()
      const prev = earliestBrief.get(b.clientId)
      if (prev === undefined || t < prev) earliestBrief.set(b.clientId, t)
    }

    const byUser = new Map<string, { calls: number; briefed: number; wins: number }>()
    const bump = (id: string) => {
      const acc = byUser.get(id) ?? { calls: 0, briefed: 0, wins: 0 }
      byUser.set(id, acc)
      return acc
    }
    for (const c of calls) {
      if (!c.userId) continue
      const acc = bump(c.userId)
      acc.calls += 1
      const t = earliestBrief.get(c.clientId)
      if (t !== undefined && t <= c.occurredAt.getTime()) acc.briefed += 1
    }
    for (const d of wonDeals) {
      if (d.client.ownerId) bump(d.client.ownerId).wins += 1
    }

    closers = roster
      .map((u) => {
        const acc = byUser.get(u.id)
        return {
          id: u.id,
          name: u.name,
          calls: acc?.calls ?? 0,
          briefedPct: acc && acc.calls > 0 ? Math.round((acc.briefed / acc.calls) * 100) : null,
          wins: acc?.wins ?? 0,
        }
      })
      // Anyone who did something today floats up; idle roster stays visible.
      .sort((a, b) => b.wins - a.wins || b.calls - a.calls || a.name.localeCompare(b.name))
  }

  return {
    timezone,
    calls: calls.length,
    avgAdherencePct,
    adherenceScored: scored.length,
    wins: wonDeals.length,
    revenue,
    briefsGenerated,
    briefsViewed,
    nurtureSent,
    nurtureConfirmed,
    qaNotes,
    closers,
    tomorrow: tomorrowAppts.map(toHuddleAppointment),
  }
}
