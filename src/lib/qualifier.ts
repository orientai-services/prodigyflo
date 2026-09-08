import 'server-only'
import type { HotLeadDecision, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { ForbiddenError, clientScope, type SessionUser } from '@/lib/rbac'
import { getHotLeads, type CloseOpsConfig, type HotLead } from '@/lib/closeops'
import { dayRangeUtc, getOrgTimezone } from '@/lib/huddle'

/**
 * Lead Qualifier workflow — Phase 2 of the close-rate operating model.
 *
 * A human qualifier reviews every hot lead before closers work it. The AI
 * probability only informs the review; the APPROVED/REJECTED decision is
 * always a person's, and nothing here blocks a closer — status is a signal.
 */

// ── Pure status logic (tested in qualifier.test.ts) ──────────────────────────

export type ReviewStatus = 'approved' | 'rejected' | 'needs_review' | 'stale'

/** An approval goes stale when the score drifts further than this many points. */
export const STALE_DRIFT_POINTS = 10

export type LatestReview = {
  decision: HotLeadDecision
  probabilityAtReview: number | null
  createdAt: Date
}

export type CurrentScore = {
  aiCloseProbability: number | null
  aiCloseProbabilityAt: Date | null
}

/**
 * The latest review decides the status. An APPROVED review only stands while
 * the score it judged still does: a drift of more than STALE_DRIFT_POINTS, or
 * a rescore after the review, sends the lead back to the queue as 'stale'.
 */
export function reviewStatus(review: LatestReview | null, current: CurrentScore): ReviewStatus {
  if (!review) return 'needs_review'
  if (review.decision === 'REJECTED') return 'rejected'
  if (
    review.probabilityAtReview !== null &&
    current.aiCloseProbability !== null &&
    Math.abs(current.aiCloseProbability - review.probabilityAtReview) > STALE_DRIFT_POINTS
  ) {
    return 'stale'
  }
  if (
    current.aiCloseProbabilityAt !== null &&
    current.aiCloseProbabilityAt.getTime() > review.createdAt.getTime()
  ) {
    return 'stale'
  }
  return 'approved'
}

export type CoverageSummary = {
  total: number
  approved: number
  needsReview: number
  stale: number
  rejected: number
  /** Approved-and-fresh share of the hot list. Null when there are no hot leads. */
  approvedPct: number | null
}

/** Roll a list of statuses into the coverage numbers the dashboard shows. */
export function summarizeCoverage(statuses: ReviewStatus[]): CoverageSummary {
  const total = statuses.length
  const count = (s: ReviewStatus) => statuses.filter((x) => x === s).length
  const approved = count('approved')
  return {
    total,
    approved,
    needsReview: count('needs_review'),
    stale: count('stale'),
    rejected: count('rejected'),
    approvedPct: total > 0 ? Math.round((approved / total) * 1000) / 10 : null,
  }
}

// ── Queries ──────────────────────────────────────────────────────────────────

export type ReviewInfo = {
  status: ReviewStatus
  decision: HotLeadDecision | null
  reason: string | null
  reviewerName: string | null
  reviewedAt: Date | null
  probabilityAtReview: number | null
}

const NO_REVIEW: ReviewInfo = {
  status: 'needs_review',
  decision: null,
  reason: null,
  reviewerName: null,
  reviewedAt: null,
  probabilityAtReview: null,
}

/**
 * Latest-review status per client, computed against each client's current
 * score. Clients outside the caller's scope are silently omitted.
 */
export async function getReviewStatusMap(
  user: SessionUser,
  clientIds: string[],
): Promise<Map<string, ReviewInfo>> {
  const map = new Map<string, ReviewInfo>()
  if (clientIds.length === 0) return map

  const ids = [...new Set(clientIds)]
  const [clients, reviews] = await Promise.all([
    db.client.findMany({
      where: { ...clientScope(user), id: { in: ids } },
      select: { id: true, aiCloseProbability: true, aiCloseProbabilityAt: true },
    }),
    db.hotLeadReview.findMany({
      where: { organizationId: user.organizationId, clientId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      select: {
        clientId: true,
        decision: true,
        reason: true,
        probabilityAtReview: true,
        createdAt: true,
        reviewer: { select: { name: true } },
      },
    }),
  ])

  // Ordered newest-first, so the first row seen per client is the latest.
  const latest = new Map<string, (typeof reviews)[number]>()
  for (const r of reviews) if (!latest.has(r.clientId)) latest.set(r.clientId, r)

  for (const c of clients) {
    const r = latest.get(c.id)
    if (!r) {
      map.set(c.id, NO_REVIEW)
      continue
    }
    map.set(c.id, {
      status: reviewStatus(r, c),
      decision: r.decision,
      reason: r.reason,
      reviewerName: r.reviewer.name,
      reviewedAt: r.createdAt,
      probabilityAtReview: r.probabilityAtReview,
    })
  }
  return map
}

export type QualifierQueueItem = HotLead & { review: ReviewInfo }

/**
 * The exact where-clause getHotLeads (closeops.ts) queries with — duplicated
 * here so the queue and coverage can size themselves against the FULL hot set
 * instead of inheriting getHotLeads' row limit. Keep the two in sync.
 */
export function hotLeadWhere(user: SessionUser, config: CloseOpsConfig): Prisma.ClientWhereInput {
  return {
    ...clientScope(user),
    status: 'ACTIVE',
    currentStage: { isTerminal: false, category: { not: 'SUBMISSION' } },
    aiCloseProbability: { gte: config.hotLeadThreshold },
  }
}

/** Hot leads still waiting on a qualifier: never reviewed, or approval gone stale. */
export async function getQualifierQueue(
  user: SessionUser,
  config: CloseOpsConfig,
): Promise<QualifierQueueItem[]> {
  // getHotLeads defaults to the hottest 100 — fine for a dashboard preview,
  // but this queue's promise is "every hot lead gets reviewed", so size the
  // fetch to the whole hot set rather than silently dropping leads past a cap.
  const hotTotal = await db.client.count({ where: hotLeadWhere(user, config) })
  if (hotTotal === 0) return []
  const leads = await getHotLeads(user, config, hotTotal)
  const statuses = await getReviewStatusMap(
    user,
    leads.map((l) => l.id),
  )
  return leads
    .map((lead) => ({ ...lead, review: statuses.get(lead.id) ?? NO_REVIEW }))
    .filter((l) => l.review.status === 'needs_review' || l.review.status === 'stale')
}

/** Coverage of the FULL current hot list: how much of it carries a fresh approval. */
export async function getQualifierCoverage(
  user: SessionUser,
  config: CloseOpsConfig,
): Promise<CoverageSummary> {
  // The percentage must stay honest past getHotLeads' row limit, so coverage
  // walks a lean, uncapped id query over the same where-clause.
  const hot = await db.client.findMany({
    where: hotLeadWhere(user, config),
    select: { id: true },
  })
  const statuses = await getReviewStatusMap(
    user,
    hot.map((h) => h.id),
  )
  return summarizeCoverage(hot.map((h) => (statuses.get(h.id) ?? NO_REVIEW).status))
}

/** Decisions recorded today — the org-timezone calendar day — in the caller's client scope. */
export async function getQualifierDayCounts(
  user: SessionUser,
  now = new Date(),
): Promise<{ approvedToday: number; rejectedToday: number }> {
  // "Today" is the org's day, cut against the same clock as the huddle board —
  // never the server's local midnight.
  const day = dayRangeUtc(now, await getOrgTimezone(user.organizationId))
  const rows = await db.hotLeadReview.groupBy({
    by: ['decision'],
    where: {
      organizationId: user.organizationId,
      createdAt: { gte: day.start, lt: day.end },
      client: clientScope(user),
    },
    _count: { _all: true },
  })
  const countFor = (d: HotLeadDecision) => rows.find((r) => r.decision === d)?._count._all ?? 0
  return { approvedToday: countFor('APPROVED'), rejectedToday: countFor('REJECTED') }
}

// ── Mutation ─────────────────────────────────────────────────────────────────

export type RecordReviewResult =
  | { ok: true; decision: HotLeadDecision; clientName: string }
  | { ok: false; error: string }

/**
 * Record a human qualification decision on a hot lead. Captures the client's
 * current AI probability so a later rescore can flag the approval as stale.
 */
export async function recordHotLeadReview(
  user: SessionUser,
  input: { clientId: string; decision: HotLeadDecision; reason?: string },
): Promise<RecordReviewResult> {
  if (!user.permissions.has('qualification:review')) {
    throw new ForbiddenError('qualification:review required')
  }

  const reason = input.reason?.trim() || null
  if (input.decision === 'REJECTED' && !reason) {
    return { ok: false, error: 'A rejection needs a reason — the closer team sees it.' }
  }

  const client = await db.client.findFirst({
    where: { ...clientScope(user), id: input.clientId },
    select: { id: true, firstName: true, lastName: true, aiCloseProbability: true, ownerId: true },
  })
  if (!client) return { ok: false, error: 'Lead not found in your scope.' }

  await db.hotLeadReview.create({
    data: {
      organizationId: user.organizationId,
      clientId: client.id,
      reviewerId: user.id,
      decision: input.decision,
      reason,
      probabilityAtReview:
        client.aiCloseProbability === null ? null : Math.round(client.aiCloseProbability),
    },
  })

  const clientName = `${client.firstName} ${client.lastName}`.trim()
  const at =
    client.aiCloseProbability === null ? 'unscored' : `at ${Math.round(client.aiCloseProbability)}%`
  await recordAudit(user, {
    action: input.decision === 'APPROVED' ? 'hotlead.approved' : 'hotlead.rejected',
    entityType: 'Client',
    entityId: client.id,
    summary:
      input.decision === 'APPROVED'
        ? `Qualifier approved hot lead ${clientName} (${at}) for closer work${reason ? ` — ${reason}` : ''}`
        : `Qualifier rejected hot lead ${clientName} (${at}) — ${reason}`,
  })

  // The owning closer hears about the decision without watching the queue.
  if (client.ownerId && client.ownerId !== user.id) {
    await db.notification.create({
      data: {
        organizationId: user.organizationId,
        userId: client.ownerId,
        kind: 'SYSTEM',
        title:
          input.decision === 'APPROVED'
            ? `Hot lead approved: ${clientName}`
            : `Hot lead held back: ${clientName}`,
        body:
          input.decision === 'APPROVED'
            ? `The qualifier cleared ${clientName} (${at}) for closer work.`
            : `The qualifier held ${clientName} back — ${reason}`,
        href: `/clients/${client.id}`,
      },
    })
  }

  return { ok: true, decision: input.decision, clientName }
}
