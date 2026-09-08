import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { currency } from '@/lib/format'
import { utcFromZoned, zonedParts } from '@/lib/huddle'
import { claimOrgSettingsValue, mergeOrgSettings } from '@/lib/org-settings'
import { clientScope, type SessionUser } from '@/lib/rbac'
import { loadActor } from '@/lib/automation/actor'

/**
 * Monday-morning weekly digest — last week's org-wide numbers, delivered to
 * the notification bell of managers and admins so the week starts from data.
 *
 * Everything here is measurement: the digest informs, humans act. The job
 * runner calls `sendWeeklyDigests` every five minutes; the
 * `Organization.settings.digest.lastSentWeek` guard makes it fire exactly
 * once per org each Monday (org timezone).
 */

// ── Pure week math (tested in digest.test.ts) ────────────────────────────────

const DAY_MS = 86_400_000

/** ISO-8601 week key ("2026-W35") for a local calendar date. */
export function isoWeekKey(year: number, month: number, day: number): string {
  // Thursday rule on UTC math: the ISO week/year of a date are those of the
  // Thursday in its Mon-Sun week.
  const d = new Date(Date.UTC(year, month - 1, day))
  const dow = d.getUTCDay() || 7 // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dow)
  const isoYear = d.getUTCFullYear()
  const days = (d.getTime() - Date.UTC(isoYear, 0, 1)) / DAY_MS
  const week = Math.ceil((days + 1) / 7)
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

/** ISO day-of-week (Mon=1 … Sun=7) of an instant in a timezone. */
export function isoWeekday(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone)
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() || 7
}

/** True when `date` falls on a Monday on the org's wall clock. */
export function isMondayIn(date: Date, timeZone: string): boolean {
  return isoWeekday(date, timeZone) === 1
}

export type WeekWindow = {
  /** UTC instant of last Monday 00:00 local. */
  start: Date
  /** UTC instant of this week's Monday 00:00 local (exclusive). */
  end: Date
  /** ISO week key of the digest week, e.g. "2026-W34" — the send guard. */
  weekKey: string
  /** Human range, e.g. "Aug 17–23" or "Aug 31 – Sep 6". */
  label: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The most recent COMPLETE Mon-Sun week before `now` in `timeZone`: on Monday
 * that is the week ending yesterday; any other day it is the same window, so
 * the digest content is stable however late in the week it is composed.
 */
export function lastWeekWindow(now: Date, timeZone: string): WeekWindow {
  const p = zonedParts(now, timeZone)
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() || 7
  // Roll local calendar dates via UTC math so month/year carries are exact.
  const lastMonday = new Date(Date.UTC(p.year, p.month - 1, p.day - (dow - 1) - 7))
  const thisMonday = new Date(Date.UTC(p.year, p.month - 1, p.day - (dow - 1)))
  const lastSunday = new Date(lastMonday.getTime() + 6 * DAY_MS)

  const from = { y: lastMonday.getUTCFullYear(), m: lastMonday.getUTCMonth() + 1, d: lastMonday.getUTCDate() }
  const to = { y: lastSunday.getUTCFullYear(), m: lastSunday.getUTCMonth() + 1, d: lastSunday.getUTCDate() }
  const label =
    from.m === to.m
      ? `${MONTHS[from.m - 1]} ${from.d}–${to.d}`
      : `${MONTHS[from.m - 1]} ${from.d} – ${MONTHS[to.m - 1]} ${to.d}`

  return {
    start: utcFromZoned(timeZone, from.y, from.m, from.d),
    end: utcFromZoned(
      timeZone,
      thisMonday.getUTCFullYear(),
      thisMonday.getUTCMonth() + 1,
      thisMonday.getUTCDate(),
    ),
    weekKey: isoWeekKey(from.y, from.m, from.d),
    label,
  }
}

// ── Pure body composition (tested in digest.test.ts) ─────────────────────────

export type WeeklyStats = {
  label: string
  newLeads: number
  qualified: number
  wins: number
  revenue: number
  /** Won / (won + lost) among decided qualified leads; null until a sample exists. */
  closeRatePct: number | null
  calls: number
  /** % of calls preceded by a viewed AI brief; null when no calls. */
  briefAdoptionPct: number | null
  nurtureConfirmed: number
  /** Closer with the most wins; null when nothing was won. */
  topCloser: { name: string; wins: number } | null
}

/** Compact single-paragraph body — notifications render plain text. */
export function composeDigestBody(stats: WeeklyStats): string {
  const parts: string[] = []
  const wins =
    stats.wins > 0
      ? `${stats.wins} ${stats.wins === 1 ? 'win' : 'wins'} for ${currency(stats.revenue)}`
      : 'no wins'
  let headline = `Last week (${stats.label}): ${stats.newLeads} new leads, ${stats.qualified} qualified, ${wins}`
  if (stats.closeRatePct !== null) headline += ` (${stats.closeRatePct}% close rate)`
  parts.push(`${headline}.`)

  let activity = `${stats.calls} calls logged`
  if (stats.briefAdoptionPct !== null) activity += ` (${stats.briefAdoptionPct}% with an AI brief)`
  activity += `, ${stats.nurtureConfirmed} nurture ${stats.nurtureConfirmed === 1 ? 'touch' : 'touches'} confirmed`
  parts.push(`${activity}.`)

  if (stats.topCloser) {
    parts.push(
      `Top closer: ${stats.topCloser.name} with ${stats.topCloser.wins} ${stats.topCloser.wins === 1 ? 'win' : 'wins'}.`,
    )
  }
  parts.push('Full breakdown on the Performance page.')
  return parts.join(' ')
}

/**
 * How wide the recipient's numbers are. Derived from the recipient's own
 * client-read permission (see `digestScopeFor`), so the title never claims
 * more reach than the body was scoped to.
 */
export type DigestScope = 'org' | 'region' | 'team'

const SCOPE_WORD: Record<DigestScope, string> = {
  org: 'Company',
  region: 'Your region',
  team: 'Your team',
}

/** The digest scope a recipient sees, from their client-read permission. */
export function digestScopeFor(user: Pick<SessionUser, 'permissions'>): DigestScope {
  if (user.permissions.has('clients:read_all')) return 'org'
  if (user.permissions.has('clients:read_region')) return 'region'
  return 'team'
}

/**
 * Titles the digest for its recipient. Without a scope it keeps the neutral
 * org-wide title; with one it names the reach ("Company last week",
 * "Your team last week") so a manager sees at a glance that the numbers are
 * theirs, not the whole company's.
 */
export function composeDigestTitle(label: string, scope?: DigestScope): string {
  if (!scope) return `Weekly digest · ${label}`
  return `${SCOPE_WORD[scope]} last week · ${label}`
}

/**
 * Where-clause for the digest's "qualified" number: DISTINCT clients that
 * entered QUALIFIED during the week. Counting StageHistory rows instead would
 * double-count a client that bounced back into QUALIFIED within the week,
 * drifting from the sibling metrics, which are all client populations.
 */
export function qualifiedInWeekWhere(
  orgClients: Prisma.ClientWhereInput,
  inWeek: { gte: Date; lt: Date },
): Prisma.ClientWhereInput {
  return { ...orgClients, stageHistory: { some: { toKey: 'QUALIFIED', enteredAt: inWeek } } }
}

// ── Composition (per-recipient scoped queries) ───────────────────────────────

async function orgTimezone(organizationId: string): Promise<string> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  })
  return org?.timezone ?? 'America/Los_Angeles'
}

/**
 * Last week's numbers for ONE recipient as a bell-ready { title, body }.
 *
 * Every client population is filtered through `clientScope(recipient)` — the
 * same source of truth every page uses — so a SALES_MANAGER sees only their
 * team's leads/deals/calls, a REGIONAL_MANAGER their region's, and an ADMIN+
 * the whole org. The title names the scope so the reach is never ambiguous.
 * The week window (org timezone) is identical for every recipient in the org.
 */
export async function composeWeeklyDigest(
  recipient: SessionUser,
  now = new Date(),
): Promise<{ title: string; body: string }> {
  const organizationId = recipient.organizationId
  const timezone = await orgTimezone(organizationId)
  const week = lastWeekWindow(now, timezone)
  const inWeek = { gte: week.start, lt: week.end }
  // The recipient's own visibility — org / region / team / assigned — already
  // constrained to their organization and to non-deleted clients.
  const scoped: Prisma.ClientWhereInput = clientScope(recipient)

  const [newLeads, qualified, wonDeals, outcomes, calls, nurtureConfirmed] = await Promise.all([
    db.client.count({ where: { ...scoped, createdAt: inWeek } }),
    db.client.count({ where: qualifiedInWeekWhere(scoped, inWeek) }),
    db.deal.findMany({
      where: { status: 'WON', wonAt: inWeek, client: scoped },
      select: { value: true, client: { select: { owner: { select: { name: true } } } } },
    }),
    // Decided-in-week outcomes among leads that ever reached QUALIFIED —
    // mirrors getCloseOpsMetrics so the digest matches the dashboards.
    db.client.findMany({
      where: {
        ...scoped,
        stageHistory: { some: { toKey: 'QUALIFIED' } },
        currentStage: { key: { in: ['CLOSED_WON', 'CLOSED_LOST'] } },
        stageEnteredAt: inWeek,
      },
      select: { currentStage: { select: { key: true } } },
    }),
    db.communication.findMany({
      where: { channel: 'CALL', occurredAt: inWeek, client: scoped },
      select: { clientId: true, occurredAt: true },
    }),
    // Scope nurture through the client too — an org-wide count would leak
    // other teams' touches to a team-scoped manager.
    db.nurtureTouch.count({ where: { confirmedAt: inWeek, client: scoped } }),
  ])

  // Was each call preceded by a viewed brief? (Mirrors closeops adoption.)
  // clientIds already come from scoped calls, so the briefs are in-scope.
  const clientIds = [...new Set(calls.map((c) => c.clientId))]
  const briefs =
    clientIds.length > 0
      ? await db.closerBrief.findMany({
          where: { organizationId, clientId: { in: clientIds }, viewedAt: { not: null } },
          select: { clientId: true, generatedAt: true },
        })
      : []
  const earliestBrief = new Map<string, number>()
  for (const b of briefs) {
    const t = b.generatedAt.getTime()
    const prev = earliestBrief.get(b.clientId)
    if (prev === undefined || t < prev) earliestBrief.set(b.clientId, t)
  }
  const briefed = calls.filter((c) => {
    const t = earliestBrief.get(c.clientId)
    return t !== undefined && t <= c.occurredAt.getTime()
  }).length

  const won = outcomes.filter((c) => c.currentStage.key === 'CLOSED_WON').length
  const decided = outcomes.length

  // Top closer by wins, attributed to the client's owner.
  const winsByCloser = new Map<string, number>()
  for (const d of wonDeals) {
    const name = d.client.owner?.name
    if (name) winsByCloser.set(name, (winsByCloser.get(name) ?? 0) + 1)
  }
  let topCloser: WeeklyStats['topCloser'] = null
  for (const [name, wins] of winsByCloser) {
    if (!topCloser || wins > topCloser.wins) topCloser = { name, wins }
  }

  const stats: WeeklyStats = {
    label: week.label,
    newLeads,
    qualified,
    wins: wonDeals.length,
    revenue: wonDeals.reduce((sum, d) => sum + Number(d.value), 0),
    closeRatePct: decided > 0 ? Math.round((won / decided) * 100) : null,
    calls: calls.length,
    briefAdoptionPct: calls.length > 0 ? Math.round((briefed / calls.length) * 100) : null,
    nurtureConfirmed,
    topCloser,
  }
  return {
    title: composeDigestTitle(week.label, digestScopeFor(recipient)),
    body: composeDigestBody(stats),
  }
}

// ── Delivery (called from the jobs runner) ───────────────────────────────────

/**
 * Roles whose bell receives the digest. Each recipient's digest is now
 * composed and scoped individually through `clientScope` (see
 * `composeWeeklyDigest`), so managers see only their own team's / region's
 * numbers — no org-wide leak. That makes it safe to include the manager roles
 * alongside the org-wide admins.
 */
const DIGEST_ROLES = ['SUPER_ADMIN', 'ADMIN', 'REGIONAL_MANAGER', 'SALES_MANAGER'] as const

export type DigestRunResult = {
  /** Orgs for which it is currently Monday. */
  mondays: number
  /** Digests actually composed and delivered this run. */
  sent: number
  /** Notification rows created. */
  recipients: number
}

/**
 * For each org where it is Monday (org tz) and this week's digest has not gone
 * out yet, compose last week's numbers and notify the admins. The
 * `settings.digest.lastSentWeek` ISO-week guard is CLAIMED atomically before
 * composing (a conditional jsonb merge that only matches while the key is not
 * yet this week's), so overlapping 5-minute job runs cannot both send; if the
 * send then fails, the winner releases the claim and the next run retries.
 */
export async function sendWeeklyDigests(now = new Date()): Promise<DigestRunResult> {
  const totals: DigestRunResult = { mondays: 0, sent: 0, recipients: 0 }
  const orgs = await db.organization.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, timezone: true },
  })

  for (const org of orgs) {
    try {
      const timezone = org.timezone || 'America/Los_Angeles'
      if (!isMondayIn(now, timezone)) continue
      totals.mondays += 1

      const week = lastWeekWindow(now, timezone)
      // Claim BEFORE composing: the conditional merge only matches while
      // lastSentWeek is not yet this week's key, so of two overlapping runs
      // exactly one claims the week and sends.
      const claimed = await claimOrgSettingsValue(org.id, 'digest', 'lastSentWeek', week.weekKey)
      if (!claimed) continue

      try {
        const managers = await db.user.findMany({
          where: {
            organizationId: org.id,
            isActive: true,
            deletedAt: null,
            role: { key: { in: [...DIGEST_ROLES] } },
          },
          select: { id: true },
        })

        // Compose each recipient's OWN scoped digest — a manager's numbers are
        // their team's/region's, an admin's the whole org. loadActor rebuilds
        // the recipient's SessionUser (role + permissions from the DB) exactly
        // as a real session would, so clientScope scopes their queries.
        const notifications: Prisma.NotificationCreateManyInput[] = []
        for (const m of managers) {
          const recipient = await loadActor(m.id)
          if (!recipient) continue
          const { title, body } = await composeWeeklyDigest(recipient, now)
          notifications.push({
            organizationId: org.id,
            userId: m.id,
            kind: 'SYSTEM' as const,
            title,
            body,
            href: '/performance',
          })
        }
        if (notifications.length > 0) {
          await db.notification.createMany({ data: notifications })
        }

        // System job — no session actor; mirror the automation engine's audit shape.
        await db.auditEvent.create({
          data: {
            organizationId: org.id,
            actorLabel: 'Weekly digest',
            action: 'digest.weekly_sent',
            entityType: 'Organization',
            entityId: org.id,
            summary: `Weekly digest ${week.weekKey} (${week.label}) delivered to ${notifications.length} manager${notifications.length === 1 ? '' : 's'}`,
          },
        })
        totals.sent += 1
        totals.recipients += notifications.length
      } catch (err) {
        // We hold the claim, so releasing it cannot race another run; the
        // guard goes clear again and the next 5-minute run retries the send.
        await mergeOrgSettings(org.id, 'digest', { lastSentWeek: null }).catch(() => {})
        throw err
      }
    } catch {
      // One org failing must not stall the runner.
    }
  }
  return totals
}
