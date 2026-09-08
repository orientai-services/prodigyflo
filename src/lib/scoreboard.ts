import 'server-only'
import { db } from '@/lib/db'
import { clientScope, userScope, type SessionUser } from '@/lib/rbac'
import type { CloseOpsConfig } from '@/lib/closeops'
import { dayRangeUtc, getOrgTimezone, zonedParts } from '@/lib/huddle'
import { adherencePct, parseAdherence } from '@/lib/adherence'
import { brierScore } from '@/lib/calibration'

/**
 * Closer scoreboard — the rep-facing slice of the Phase 1-3 operating model
 * (see closeops.ts). Phase 2 calls for "gamification tied to AI accuracy":
 * points reward outcomes that correlate with the AI being right (hot-scored
 * wins), process adherence (AI Brief on every call, QA quality), and penalize
 * the one behavior every phase caps — letting live leads go stale.
 *
 * Everything that scores or ranks is a pure function so the math is
 * transparent, testable, and rendered verbatim in the UI. Points never decide
 * anything about a client; they only rank closers.
 */

// ── Scoring rules (pure) ─────────────────────────────────────────────────────

export type PointRuleKey = 'win' | 'hotWin' | 'briefedCall' | 'fullFunnel' | 'qa' | 'leak'

export type PointRule = {
  key: PointRuleKey
  label: string
  each: number
  /** Human description shown in the "how points work" legend. */
  unit: string
}

/**
 * The whole system, in one place. QA earns +1 per score point ABOVE 7 (an 8
 * earns 1, a 10 earns 3) so average calls score nothing and excellence
 * compounds. Leaks subtract while the lead stays stale, so the fastest way to
 * climb the board is to touch your pipeline — totals can go negative on
 * purpose; hiding the hole would hide the problem.
 */
export const POINT_RULES: readonly PointRule[] = [
  { key: 'win', label: 'Deal won', each: 10, unit: 'per closed-won deal in range' },
  {
    key: 'hotWin',
    label: 'Hot-scored win',
    each: 5,
    unit: 'bonus when the win was at/above the hot-lead AI threshold',
  },
  {
    key: 'briefedCall',
    label: 'Call with AI Brief',
    each: 2,
    unit: 'per call made after viewing the Closer Brief',
  },
  {
    key: 'fullFunnel',
    label: 'Full-funnel call',
    each: 1,
    unit: 'per logged call at 100% 5-step funnel adherence',
  },
  { key: 'qa', label: 'QA excellence', each: 1, unit: 'per QA score point above 7' },
  {
    key: 'leak',
    label: 'Leaking lead',
    each: -3,
    unit: 'per live lead currently past the no-activity window',
  },
] as const

export type ScoreInputs = {
  wins: number
  /** Wins whose client was scored at/above the hot-lead threshold. */
  hotWins: number
  /** Calls made after a Closer Brief for that client was VIEWED. */
  briefedCalls: number
  /** Logged calls whose recorded 5-step funnel adherence was 100%. */
  fullFunnelCalls: number
  /** Call-QA scores (1-10) received in range. */
  qaScores: number[]
  /** Live owned leads currently inside the leakage window. */
  leakingLeads: number
}

export type PointsLine = {
  key: PointRuleKey
  label: string
  count: number
  each: number
  points: number
}

const clampCount = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

/** Turns raw activity into a fully itemized points total. Pure. */
export function computePoints(s: ScoreInputs): { total: number; lines: PointsLine[] } {
  const wins = clampCount(s.wins)
  const counts: Record<PointRuleKey, number> = {
    win: wins,
    // A hot win is still a win — the bonus can never exceed the win count.
    hotWin: Math.min(clampCount(s.hotWins), wins),
    briefedCall: clampCount(s.briefedCalls),
    fullFunnel: clampCount(s.fullFunnelCalls),
    qa: s.qaScores.reduce((sum, score) => sum + Math.max(0, Math.min(10, score) - 7), 0),
    leak: clampCount(s.leakingLeads),
  }
  const lines = POINT_RULES.map((r) => ({
    key: r.key,
    label: r.label,
    count: counts[r.key],
    each: r.each,
    points: counts[r.key] * r.each,
  }))
  return { total: lines.reduce((sum, l) => sum + l.points, 0), lines }
}

/**
 * Competition ranking: sorted by points, ties share a rank and the next rank
 * skips (1, 2, 2, 4). Revenue then name only break DISPLAY order, never rank.
 */
export function rankRows<T extends { points: number; revenueWon: number; name: string }>(
  rows: T[],
): (T & { rank: number })[] {
  const sorted = [...rows].sort(
    (a, b) => b.points - a.points || b.revenueWon - a.revenueWon || a.name.localeCompare(b.name),
  )
  let lastPoints = Number.NaN
  let lastRank = 0
  return sorted.map((r, i) => {
    const rank = r.points === lastPoints ? lastRank : i + 1
    lastPoints = r.points
    lastRank = rank
    return { ...r, rank }
  })
}

// ── AI alignment (pure) ──────────────────────────────────────────────────────

/**
 * How closely a closer's OWN decided outcomes tracked the AI score: 1 − Brier,
 * as a 0-100 "AI-alignment %". 100 means their wins were all high-scored and
 * their losses low-scored — they and the model agree. This is a READ signal,
 * not a points lever: it says whether the AI reads this closer's book well, so a
 * high-alignment closer can trust a hot score and a low-alignment one should
 * lean on their own judgment. Null below `minSample`, where one deal swings it.
 *
 * We deliberately did NOT add a POINT_RULES entry for it. The points model
 * already rewards trusting a good signal through `hotWin` (a win at/above the
 * hot-lead threshold), and alignment is a property of the model↔closer fit, not
 * an action a closer takes — scoring it would punish closers the AI happens to
 * read poorly for reasons outside their control. So it ships as a column.
 */
export function aiAlignmentPct(
  rows: { probability: number; won: boolean }[],
  minSample = 5,
): number | null {
  if (rows.length < minSample) return null
  const brier = brierScore(rows)
  if (brier === null) return null
  return Math.round((1 - brier) * 1000) / 10
}

// ── Brief adoption (pure) ────────────────────────────────────────────────────

/**
 * Earliest brief-VIEW instant per client. Adoption means the closer actually
 * read a brief before dialing — generation alone proves nothing, so only
 * `viewedAt` counts. Mirrors getCloseOpsMetrics (closeops.ts).
 */
export function firstBriefViewByClient(
  briefs: { clientId: string; viewedAt: Date | null }[],
): Map<string, number> {
  const first = new Map<string, number>()
  for (const b of briefs) {
    if (!b.viewedAt) continue
    const t = b.viewedAt.getTime()
    const prev = first.get(b.clientId)
    if (prev === undefined || t < prev) first.set(b.clientId, t)
  }
  return first
}

/** A call scores as briefed only when a brief was viewed at/before the call. */
export function callHadBrief(
  firstViewByClient: Map<string, number>,
  call: { clientId: string; occurredAt: Date },
): boolean {
  const t = firstViewByClient.get(call.clientId)
  return t !== undefined && t <= call.occurredAt.getTime()
}

// ── Target coloring (pure) ───────────────────────────────────────────────────

export type Tone = 'good' | 'warn' | 'bad' | 'muted'

/** Green at/above target, amber within `warnRatio` of it, red below, muted with no data. */
export function toneVsTarget(value: number | null, target: number, warnRatio = 0.8): Tone {
  if (value === null) return 'muted'
  if (value >= target) return 'good'
  if (value >= target * warnRatio) return 'warn'
  return 'bad'
}

/** QA runs 1-10: 8+ is strong, 6-8 needs coaching, below 6 is a problem. */
export function qaTone(avg: number | null): Tone {
  if (avg === null) return 'muted'
  if (avg >= 8) return 'good'
  if (avg >= 6) return 'warn'
  return 'bad'
}

/** Zero leaks is the only "met"; one or two is a nudge, more is red. */
export function leakTone(count: number): Tone {
  if (count <= 0) return 'good'
  if (count <= 2) return 'warn'
  return 'bad'
}

// ── Date ranges ──────────────────────────────────────────────────────────────

export type ScoreboardRangeKey = 'week' | '30' | '90' | 'all'

export type ScoreboardRange = { key: ScoreboardRangeKey; from?: Date; label: string }

/**
 * Monday 00:00 of the week containing `now`, on the `timeZone` clock — the UTC
 * instant the org's closers see as the start of "this week".
 */
export function weekStartUtc(now: Date, timeZone: string): Date {
  const p = zonedParts(now, timeZone)
  // Weekday of the LOCAL calendar date (0=Sun..6=Sat), read back via UTC so
  // the server's own zone never leaks into the math.
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  return dayRangeUtc(now, timeZone, -((weekday + 6) % 7)).start
}

/**
 * Adds a "this week" window (Monday 00:00 in `timeZone` when given) to the
 * usual 30/90/all. Pass the org timezone wherever it is in hand; without one
 * the week falls back to the server clock, and getScoreboard re-anchors it —
 * see the range handling there.
 */
export function scoreboardRange(
  param: string | undefined,
  now = new Date(),
  timeZone?: string,
): ScoreboardRange {
  if (param === 'week') {
    if (timeZone) return { key: 'week', from: weekStartUtc(now, timeZone), label: 'This week' }
    const from = new Date(now)
    from.setHours(0, 0, 0, 0)
    from.setDate(from.getDate() - ((from.getDay() + 6) % 7))
    return { key: 'week', from, label: 'This week' }
  }
  if (param === 'all') return { key: 'all', label: 'All time' }
  const days = param === '90' ? 90 : 30
  return {
    key: days === 90 ? '90' : '30',
    from: new Date(now.getTime() - days * 86_400_000),
    label: `Last ${days} days`,
  }
}

// ── Scoreboard data ──────────────────────────────────────────────────────────

export type ScoreboardRow = {
  id: string
  name: string
  teamName: string | null
  capacity: number
  /** Live, non-terminal owned clients right now. */
  pipeline: number
  /** Of those, how many are past the leakage window. */
  leaking: number
  /** Terminal outcomes (in range) among owned clients that reached QUALIFIED. */
  qualifiedWon: number
  qualifiedLost: number
  closeRatePct: number | null
  /** Deals won in range (points + revenue basis). */
  wins: number
  hotWins: number
  revenueWon: number
  avgAiProbOnWonPct: number | null
  /** 1 − Brier over this closer's WON+LOST scored deals (0-100). Null below the sample floor. */
  aiAlignmentPct: number | null
  /** Decided, scored deals behind the alignment figure — its n. */
  aiReadSample: number
  calls: number
  briefedCalls: number
  briefAdoptionPct: number | null
  /** Average 5-step funnel adherence across logged calls that recorded a checklist. */
  adherencePct: number | null
  /** How many calls in range carried an adherence checklist (the average's n). */
  adherenceCalls: number
  fullFunnelCalls: number
  qaAvg: number | null
  qaCount: number
  coachingSessions: number
  points: number
  pointsLines: PointsLine[]
  rank: number
}

const pct1 = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null

/**
 * One row per active closer in the caller's scope. A manager sees the team,
 * an admin the org, a closer exactly themself — `userScope`/`clientScope`
 * decide, never this function.
 */
export async function getScoreboard(
  user: SessionUser,
  config: CloseOpsConfig,
  range?: Date | ScoreboardRange,
  now = new Date(),
): Promise<ScoreboardRow[]> {
  const scope = clientScope(user)
  // "This week" must cut at the ORG's Monday midnight, not the server's: a
  // ScoreboardRange with key 'week' is re-anchored here against the org
  // timezone. A bare Date (legacy callers) is trusted as-is.
  let from = range instanceof Date ? range : range?.from
  if (range && !(range instanceof Date) && range.key === 'week') {
    from = weekStartUtc(now, await getOrgTimezone(user.organizationId))
  }
  const leakageCutoff = new Date(now.getTime() - config.leakageDays * 86_400_000)
  const inRange = from ? { gte: from } : undefined

  const closers = await db.user.findMany({
    where: { AND: [userScope(user), { role: { key: 'CLOSER' }, isActive: true }] },
    select: { id: true, name: true, maxWorkload: true, team: { select: { name: true } } },
    orderBy: { name: 'asc' },
  })
  if (closers.length === 0) return []
  const closerIds = closers.map((c) => c.id)

  const [pipeline, leaking, outcomes, dealsWon, decidedDeals, calls, qaNotes, coaching] =
    await Promise.all([
    db.client.groupBy({
      by: ['ownerId'],
      where: { ...scope, status: 'ACTIVE', currentStage: { isTerminal: false } },
      _count: { _all: true },
    }),
    db.client.groupBy({
      by: ['ownerId'],
      where: {
        ...scope,
        status: 'ACTIVE',
        currentStage: { isTerminal: false },
        lastActivityAt: { lt: leakageCutoff },
      },
      _count: { _all: true },
    }),
    // Close rate on qualified: terminal clients that ever reached QUALIFIED.
    db.client.findMany({
      where: {
        ...scope,
        ownerId: { in: closerIds },
        stageHistory: { some: { toKey: 'QUALIFIED' } },
        currentStage: { key: { in: ['CLOSED_WON', 'CLOSED_LOST'] } },
        ...(inRange ? { stageEnteredAt: inRange } : {}),
      },
      select: { ownerId: true, currentStage: { select: { key: true } } },
    }),
    db.deal.findMany({
      where: { status: 'WON', ...(inRange ? { wonAt: inRange } : {}), client: scope },
      select: { value: true, client: { select: { ownerId: true, aiCloseProbability: true } } },
    }),
    // Decided scored clients for the AI-alignment read. Outcome is the terminal
    // STAGE, not a Deal row — losses rarely carry a Deal, so a deal-based query
    // would see only wins and read 100%. Range-bound on stage entry.
    db.client.findMany({
      where: {
        ...scope,
        ownerId: { in: closerIds },
        aiCloseProbability: { not: null },
        currentStage: { key: { in: ['CLOSED_WON', 'CLOSED_LOST'] } },
        ...(inRange ? { stageEnteredAt: inRange } : {}),
      },
      select: { ownerId: true, aiCloseProbability: true, currentStage: { select: { key: true } } },
    }),
    db.communication.findMany({
      where: {
        channel: 'CALL',
        userId: { in: closerIds },
        ...(inRange ? { occurredAt: inRange } : {}),
        client: scope,
      },
      select: {
        userId: true,
        clientId: true,
        occurredAt: true,
        call: { select: { adherence: true } },
      },
    }),
    db.coachingNote.findMany({
      where: {
        organizationId: user.organizationId,
        kind: 'CALL_QA',
        subjectId: { in: closerIds },
        score: { not: null },
        ...(inRange ? { createdAt: inRange } : {}),
      },
      select: { subjectId: true, score: true },
    }),
    db.coachingNote.groupBy({
      by: ['subjectId'],
      where: {
        organizationId: user.organizationId,
        kind: 'ONE_ON_ONE',
        subjectId: { in: closerIds },
        ...(inRange ? { createdAt: inRange } : {}),
      },
      _count: { _all: true },
    }),
  ])

  // Brief adoption, mirroring getCloseOpsMetrics: a call counts only when a
  // brief for that client had been VIEWED at/before the call — a brief opened
  // after hanging up never scores.
  let firstBriefView = new Map<string, number>()
  if (calls.length > 0) {
    const briefs = await db.closerBrief.findMany({
      where: {
        organizationId: user.organizationId,
        clientId: { in: [...new Set(calls.map((c) => c.clientId))] },
        viewedAt: { not: null },
      },
      select: { clientId: true, viewedAt: true },
    })
    firstBriefView = firstBriefViewByClient(briefs)
  }

  const pipelineByOwner = new Map(pipeline.map((g) => [g.ownerId, g._count._all]))
  const leakingByOwner = new Map(leaking.map((g) => [g.ownerId, g._count._all]))
  const coachingBySubject = new Map(coaching.map((g) => [g.subjectId, g._count._all]))

  const outcomesByOwner = new Map<string, { won: number; lost: number }>()
  for (const c of outcomes) {
    if (!c.ownerId) continue
    const acc = outcomesByOwner.get(c.ownerId) ?? { won: 0, lost: 0 }
    if (c.currentStage.key === 'CLOSED_WON') acc.won += 1
    else acc.lost += 1
    outcomesByOwner.set(c.ownerId, acc)
  }

  const dealsByOwner = new Map<
    string,
    { wins: number; hotWins: number; revenue: number; probs: number[] }
  >()
  for (const d of dealsWon) {
    const ownerId = d.client.ownerId
    if (!ownerId) continue
    const acc = dealsByOwner.get(ownerId) ?? { wins: 0, hotWins: 0, revenue: 0, probs: [] }
    acc.wins += 1
    acc.revenue += Number(d.value)
    const p = d.client.aiCloseProbability
    if (typeof p === 'number') {
      acc.probs.push(p)
      if (p >= config.hotLeadThreshold) acc.hotWins += 1
    }
    dealsByOwner.set(ownerId, acc)
  }

  // AI-alignment: per owner, their decided scored deals as {probability, won}.
  const alignmentByOwner = new Map<string, { probability: number; won: boolean }[]>()
  for (const d of decidedDeals) {
    const ownerId = d.ownerId
    const p = d.aiCloseProbability
    if (!ownerId || typeof p !== 'number') continue
    const list = alignmentByOwner.get(ownerId) ?? []
    list.push({ probability: p, won: d.currentStage.key === 'CLOSED_WON' })
    alignmentByOwner.set(ownerId, list)
  }

  const callsByUser = new Map<
    string,
    { total: number; briefed: number; adherencePcts: number[]; fullFunnel: number }
  >()
  for (const call of calls) {
    if (!call.userId) continue
    const acc =
      callsByUser.get(call.userId) ?? { total: 0, briefed: 0, adherencePcts: [], fullFunnel: 0 }
    acc.total += 1
    if (callHadBrief(firstBriefView, call)) acc.briefed += 1
    // Funnel adherence: only calls that recorded a checklist enter the average
    // (adherencePct is null on an empty payload), so pre-feature calls and
    // non-connected attempts never drag a closer to 0%.
    const pct = adherencePct(parseAdherence(call.call?.adherence))
    if (pct !== null) {
      acc.adherencePcts.push(pct)
      if (pct === 100) acc.fullFunnel += 1
    }
    callsByUser.set(call.userId, acc)
  }

  const qaBySubject = new Map<string, number[]>()
  for (const note of qaNotes) {
    if (typeof note.score !== 'number') continue
    const list = qaBySubject.get(note.subjectId) ?? []
    list.push(note.score)
    qaBySubject.set(note.subjectId, list)
  }

  const rows = closers.map((c) => {
    const outcome = outcomesByOwner.get(c.id) ?? { won: 0, lost: 0 }
    const deals = dealsByOwner.get(c.id) ?? { wins: 0, hotWins: 0, revenue: 0, probs: [] }
    const callStats =
      callsByUser.get(c.id) ?? { total: 0, briefed: 0, adherencePcts: [], fullFunnel: 0 }
    const qaScores = qaBySubject.get(c.id) ?? []
    const leakingCount = leakingByOwner.get(c.id) ?? 0

    const { total, lines } = computePoints({
      wins: deals.wins,
      hotWins: deals.hotWins,
      briefedCalls: callStats.briefed,
      fullFunnelCalls: callStats.fullFunnel,
      qaScores,
      leakingLeads: leakingCount,
    })

    return {
      id: c.id,
      name: c.name,
      teamName: c.team?.name ?? null,
      capacity: c.maxWorkload,
      pipeline: pipelineByOwner.get(c.id) ?? 0,
      leaking: leakingCount,
      qualifiedWon: outcome.won,
      qualifiedLost: outcome.lost,
      closeRatePct: pct1(outcome.won, outcome.won + outcome.lost),
      wins: deals.wins,
      hotWins: deals.hotWins,
      revenueWon: deals.revenue,
      avgAiProbOnWonPct:
        deals.probs.length > 0
          ? Math.round((deals.probs.reduce((a, b) => a + b, 0) / deals.probs.length) * 10) / 10
          : null,
      aiAlignmentPct: aiAlignmentPct(alignmentByOwner.get(c.id) ?? []),
      aiReadSample: (alignmentByOwner.get(c.id) ?? []).length,
      calls: callStats.total,
      briefedCalls: callStats.briefed,
      briefAdoptionPct: pct1(callStats.briefed, callStats.total),
      adherencePct:
        callStats.adherencePcts.length > 0
          ? Math.round(
              (callStats.adherencePcts.reduce((a, b) => a + b, 0) /
                callStats.adherencePcts.length) *
                10,
            ) / 10
          : null,
      adherenceCalls: callStats.adherencePcts.length,
      fullFunnelCalls: callStats.fullFunnel,
      qaAvg:
        qaScores.length > 0
          ? Math.round((qaScores.reduce((a, b) => a + b, 0) / qaScores.length) * 10) / 10
          : null,
      qaCount: qaScores.length,
      coachingSessions: coachingBySubject.get(c.id) ?? 0,
      points: total,
      pointsLines: lines,
    }
  })

  return rankRows(rows)
}
