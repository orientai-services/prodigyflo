import 'server-only'
import { redirect } from 'next/navigation'
import type { Prisma, SavedFilter, StageKey } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { ForbiddenError, clientScope, userScope, type SessionUser } from '@/lib/rbac'
import { computeMetrics, filterWhere, type AnalyticsFilters } from '@/lib/analytics'
import { StageTransitionError, moveClientToStage } from '@/lib/stage-transitions'
import { fullName, rate } from '@/lib/format'

/** The row shape `computeMetrics` consumes — mirrored from analytics.ts. */
type MetricsRow = Parameters<typeof computeMetrics>[0][number]

const METRICS_SELECT = {
  id: true,
  ownerId: true,
  teamId: true,
  regionId: true,
  campaignId: true,
  leadSourceId: true,
  createdAt: true,
  firstContactAt: true,
  stageEnteredAt: true,
  estimatedValue: true,
  lostReason: true,
  currentStage: { select: { key: true, slaHours: true } },
  stageHistory: { select: { toKey: true, enteredAt: true } },
  appointments: { select: { status: true, startsAt: true } },
  deal: { select: { status: true, value: true, wonAt: true } },
} satisfies Prisma.ClientSelect

// ── Access ───────────────────────────────────────────────────────────────────

export type AnalyticsLevel = 'org' | 'region' | 'team'

/**
 * Gate for the reporting and performance pages: the caller must hold at least
 * team-level analytics. Data itself is always scoped through `clientScope`, so
 * the level only describes how wide that scope happens to be.
 */
export function analyticsLevel(user: SessionUser): AnalyticsLevel | null {
  if (user.permissions.has('analytics:org')) return 'org'
  if (user.permissions.has('analytics:region')) return 'region'
  if (user.permissions.has('analytics:team')) return 'team'
  return null
}

export function requireAnalyticsLevel(user: SessionUser): AnalyticsLevel {
  const level = analyticsLevel(user)
  if (!level) redirect('/forbidden')
  return level
}

export const LEVEL_LABEL: Record<AnalyticsLevel, string> = {
  org: 'entire organization',
  region: 'your region',
  team: 'your team',
}

// ── Date ranges ──────────────────────────────────────────────────────────────

export type RangeKey = '30' | '90' | 'all'

export function dateRange(param: string | undefined): { key: RangeKey; from?: Date; label: string } {
  const key: RangeKey = param === '90' ? '90' : param === 'all' ? 'all' : param === '30' ? '30' : '30'
  if (key === 'all') return { key, label: 'All time' }
  const days = key === '90' ? 90 : 30
  const from = new Date(Date.now() - days * 86_400_000)
  return { key, from, label: `Last ${days} days` }
}

// ── Document completion ──────────────────────────────────────────────────────

/** Statuses that mean a file actually arrived, whatever happened to it after. */
const RECEIVED_STATUSES = ['RECEIVED', 'PROCESSING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED'] as const

export type DocumentCompletionRow = {
  requirementId: string
  name: string
  packageName: string
  isRequired: boolean
  isAttorneyRequired: boolean
  requested: number
  received: number
  approved: number
  rejected: number
  receivedRate: number | null
  approvedRate: number | null
}

/** Per-requirement funnel: how many were requested, arrived, and passed review. */
export async function getDocumentCompletion(user: SessionUser): Promise<DocumentCompletionRow[]> {
  const [requirements, grouped] = await Promise.all([
    db.documentRequirement.findMany({
      where: { package: { organizationId: user.organizationId } },
      select: {
        id: true,
        name: true,
        isRequired: true,
        isAttorneyRequired: true,
        position: true,
        package: { select: { name: true } },
      },
      orderBy: [{ packageId: 'asc' }, { position: 'asc' }],
    }),
    db.clientDocument.groupBy({
      by: ['requirementId', 'status'],
      where: { requirementId: { not: null }, client: clientScope(user) },
      _count: { _all: true },
    }),
  ])

  const byRequirement = new Map<string, { requested: number; received: number; approved: number; rejected: number }>()
  for (const g of grouped) {
    if (!g.requirementId) continue
    const acc = byRequirement.get(g.requirementId) ?? { requested: 0, received: 0, approved: 0, rejected: 0 }
    acc.requested += g._count._all
    if ((RECEIVED_STATUSES as readonly string[]).includes(g.status)) acc.received += g._count._all
    if (g.status === 'APPROVED') acc.approved += g._count._all
    if (g.status === 'REJECTED') acc.rejected += g._count._all
    byRequirement.set(g.requirementId, acc)
  }

  return requirements.map((r) => {
    const c = byRequirement.get(r.id) ?? { requested: 0, received: 0, approved: 0, rejected: 0 }
    return {
      requirementId: r.id,
      name: r.name,
      packageName: r.package.name,
      isRequired: r.isRequired,
      isAttorneyRequired: r.isAttorneyRequired,
      ...c,
      receivedRate: rate(c.received, c.requested),
      approvedRate: rate(c.approved, c.requested),
    }
  })
}

// ── Submissions ──────────────────────────────────────────────────────────────

export type SubmissionTrendPoint = {
  label: string
  created: number
  submitted: number
  approved: number
}

/** Weekly submission activity for the trend chart. */
export async function getSubmissionTrend(user: SessionUser, weeks = 12): Promise<SubmissionTrendPoint[]> {
  const start = new Date(Date.now() - weeks * 7 * 86_400_000)
  const submissions = await db.submission.findMany({
    where: {
      client: clientScope(user),
      OR: [{ createdAt: { gte: start } }, { submittedAt: { gte: start } }, { approvedAt: { gte: start } }],
    },
    select: { createdAt: true, submittedAt: true, approvedAt: true },
  })

  const buckets: SubmissionTrendPoint[] = []
  for (let i = weeks - 1; i >= 0; i--) {
    const from = new Date(Date.now() - (i + 1) * 7 * 86_400_000)
    const to = new Date(Date.now() - i * 7 * 86_400_000)
    const inWindow = (d: Date | null) => Boolean(d && d >= from && d < to)
    buckets.push({
      label: to.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      created: submissions.filter((s) => inWindow(s.createdAt)).length,
      submitted: submissions.filter((s) => inWindow(s.submittedAt)).length,
      approved: submissions.filter((s) => inWindow(s.approvedAt)).length,
    })
  }
  return buckets
}

/** Current submission counts by status, in lifecycle order. */
export async function getSubmissionStatusBreakdown(user: SessionUser) {
  const ORDER = [
    'DRAFT', 'READY', 'SUBMITTED', 'ACKNOWLEDGED',
    'CORRECTIONS_REQUESTED', 'RESUBMITTED', 'APPROVED', 'REJECTED',
  ] as const
  const grouped = await db.submission.groupBy({
    by: ['status'],
    where: { client: clientScope(user) },
    _count: { _all: true },
  })
  const byStatus = new Map(grouped.map((g) => [g.status, g._count._all]))
  return ORDER.map((status) => ({ status, count: byStatus.get(status) ?? 0 }))
}

// ── Overdue follow-ups ───────────────────────────────────────────────────────

export type OverdueTaskRow = {
  id: string
  title: string
  priority: string
  dueAt: Date
  overdueHours: number
  assigneeName: string | null
  client: { id: string; firstName: string; lastName: string; stageName: string } | null
}

/** Open tasks past their due date, for clients the caller can see. */
export async function getOverdueTasks(user: SessionUser, limit = 100): Promise<OverdueTaskRow[]> {
  const now = new Date()
  const tasks = await db.task.findMany({
    where: {
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      dueAt: { lt: now },
      OR: [
        { client: { is: clientScope(user) } },
        // Clientless tasks surface only for people the caller can already see.
        { clientId: null, assignee: { is: userScope(user) } },
      ],
    },
    select: {
      id: true,
      title: true,
      priority: true,
      dueAt: true,
      assignee: { select: { name: true } },
      client: {
        select: { id: true, firstName: true, lastName: true, currentStage: { select: { name: true } } },
      },
    },
    orderBy: { dueAt: 'asc' },
    take: limit,
  })

  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    priority: t.priority,
    dueAt: t.dueAt!,
    overdueHours: (now.getTime() - t.dueAt!.getTime()) / 3_600_000,
    assigneeName: t.assignee?.name ?? null,
    client: t.client
      ? {
          id: t.client.id,
          firstName: t.client.firstName,
          lastName: t.client.lastName,
          stageName: t.client.currentStage.name,
        }
      : null,
  }))
}

export type SlaExpiredRow = {
  id: string
  firstName: string
  lastName: string
  stageName: string
  stageKey: StageKey
  stageCategory: string
  slaHours: number
  stageEnteredAt: Date
  overdueHours: number
  lastActivityAt: Date
  ownerName: string | null
  estimatedValue: Prisma.Decimal | null
}

/**
 * Active clients whose stage SLA has expired AND who have had no recorded
 * activity since the deadline passed — the ones nobody is touching.
 */
export async function getSlaExpiredClients(user: SessionUser, limit = 100): Promise<SlaExpiredRow[]> {
  const clients = await db.client.findMany({
    where: {
      AND: [
        clientScope(user),
        { status: 'ACTIVE' },
        { currentStage: { isTerminal: false, slaHours: { not: null } } },
      ],
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      stageEnteredAt: true,
      lastActivityAt: true,
      estimatedValue: true,
      owner: { select: { name: true } },
      currentStage: { select: { key: true, name: true, category: true, slaHours: true } },
    },
    take: 500,
  })

  const now = Date.now()
  return clients
    .map((c) => {
      const sla = c.currentStage.slaHours ?? 0
      const deadline = c.stageEnteredAt.getTime() + sla * 3_600_000
      return { ...c, deadline, overdueHours: (now - deadline) / 3_600_000 }
    })
    .filter((c) => c.overdueHours > 0 && c.lastActivityAt.getTime() < c.deadline)
    .sort((a, b) => b.overdueHours - a.overdueHours)
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      stageName: c.currentStage.name,
      stageKey: c.currentStage.key,
      stageCategory: c.currentStage.category,
      slaHours: c.currentStage.slaHours ?? 0,
      stageEnteredAt: c.stageEnteredAt,
      overdueHours: c.overdueHours,
      lastActivityAt: c.lastActivityAt,
      ownerName: c.owner?.name ?? null,
      estimatedValue: c.estimatedValue,
    }))
}

/** Headline counts for the overdue tiles — cheap enough to call from any page. */
export async function getOverdueSummary(user: SessionUser) {
  const [tasks, slaExpired] = await Promise.all([
    getOverdueTasks(user, 500),
    getSlaExpiredClients(user, 500),
  ])
  return { overdueTasks: tasks.length, slaExpired: slaExpired.length }
}

// ── Manager performance ──────────────────────────────────────────────────────

export type WorkloadRow = {
  id: string
  name: string
  teamName: string | null
  active: number
  capacity: number
  utilization: number
}

/**
 * Active client load per closer, limited to closers the caller can see.
 * (analytics.getWorkloadDistribution is org-wide; this one follows scope.)
 */
export async function getScopedWorkload(user: SessionUser): Promise<WorkloadRow[]> {
  const [closers, counts] = await Promise.all([
    db.user.findMany({
      where: { AND: [userScope(user), { role: { key: 'CLOSER' }, isActive: true }] },
      select: { id: true, name: true, maxWorkload: true, team: { select: { name: true } } },
      orderBy: { name: 'asc' },
    }),
    db.client.groupBy({
      by: ['ownerId'],
      where: { AND: [clientScope(user), { status: 'ACTIVE' }] },
      _count: { _all: true },
    }),
  ])
  const byOwner = new Map(counts.map((c) => [c.ownerId, c._count._all]))
  return closers
    .map((c) => ({
      id: c.id,
      name: c.name,
      teamName: c.team?.name ?? null,
      active: byOwner.get(c.id) ?? 0,
      capacity: c.maxWorkload,
      utilization: rate(byOwner.get(c.id) ?? 0, c.maxWorkload) ?? 0,
    }))
    .sort((a, b) => b.utilization - a.utilization)
}

export type CloserPerformanceRow = {
  id: string
  name: string
  teamName: string | null
  metrics: ReturnType<typeof computeMetrics>
  belowMinimumSample: boolean
}

/** Per-closer conversion and revenue, scoped to people and clients in reach. */
export async function getCloserPerformance(
  user: SessionUser,
  f: AnalyticsFilters = {},
  minimumSample = 10,
): Promise<CloserPerformanceRow[]> {
  const [closers, rows] = await Promise.all([
    db.user.findMany({
      where: { AND: [userScope(user), { role: { key: 'CLOSER' } }] },
      select: { id: true, name: true, team: { select: { name: true } } },
      orderBy: { name: 'asc' },
    }),
    db.client.findMany({ where: filterWhere(user, f), select: METRICS_SELECT }) as unknown as Promise<MetricsRow[]>,
  ])

  const byOwner = new Map<string, MetricsRow[]>()
  for (const row of rows) {
    if (!row.ownerId) continue
    const list = byOwner.get(row.ownerId) ?? []
    list.push(row)
    byOwner.set(row.ownerId, list)
  }

  return closers
    .map((c) => {
      const own = byOwner.get(c.id) ?? []
      return {
        id: c.id,
        name: c.name,
        teamName: c.team?.name ?? null,
        metrics: computeMetrics(own),
        belowMinimumSample: own.length < minimumSample,
      }
    })
    .sort((a, b) => {
      if (a.belowMinimumSample !== b.belowMinimumSample) return a.belowMinimumSample ? 1 : -1
      return b.metrics.revenue - a.metrics.revenue
    })
}

// ── Bulk operations ──────────────────────────────────────────────────────────
// The cores live here (not in the 'use server' file) so they are directly
// testable with a constructed SessionUser and reusable by the board.

export type BulkRowResult = { id: string; name: string; ok: boolean; error?: string }

const REASON_FIELD: Partial<Record<StageKey, 'lostReason' | 'holdReason' | 'disqualifiedReason'>> = {
  CLOSED_LOST: 'lostReason',
  ON_HOLD: 'holdReason',
  NOT_QUALIFIED: 'disqualifiedReason',
}

/**
 * Moves each client through the gated single-client path. One client's blocker
 * never aborts the batch — every row reports its own outcome.
 */
export async function bulkMoveClients(
  user: SessionUser,
  clientIds: string[],
  toStageKey: StageKey,
  reason?: string,
): Promise<BulkRowResult[]> {
  if (!user.permissions.has('clients:advance_stage')) throw new ForbiddenError()

  const inScope = await db.client.findMany({
    where: { AND: [clientScope(user), { id: { in: clientIds } }] },
    select: { id: true, firstName: true, lastName: true },
  })
  const scopeById = new Map(inScope.map((c) => [c.id, c]))

  const results: BulkRowResult[] = []
  for (const id of clientIds) {
    const client = scopeById.get(id)
    if (!client) {
      results.push({ id, name: 'Unknown client', ok: false, error: 'Not found or outside your scope.' })
      continue
    }
    try {
      const reasonField = REASON_FIELD[toStageKey]
      if (reasonField && reason) {
        await db.client.update({ where: { id }, data: { [reasonField]: reason } })
      }
      await moveClientToStage({ user, clientId: id, toStageKey, reason })
      results.push({ id, name: fullName(client), ok: true })
    } catch (error) {
      const message =
        error instanceof StageTransitionError
          ? [error.message, ...error.blockers].join(' ')
          : 'This move failed unexpectedly.'
      results.push({ id, name: fullName(client), ok: false, error: message })
    }
  }
  return results
}

/** Reassigns clients to a new owner (or unassigns with null). Audited per client. */
export async function reassignClients(
  user: SessionUser,
  clientIds: string[],
  ownerId: string | null,
): Promise<BulkRowResult[]> {
  if (user.role !== 'SUPER_ADMIN' || !user.permissions.has('clients:reassign')) throw new ForbiddenError()

  let ownerName: string | null = null
  if (ownerId) {
    const owner = await db.user.findFirst({
      where: { AND: [userScope(user), { id: ownerId, isActive: true, role: { key: 'CLOSER' } }] },
      select: { id: true, name: true, teamId: true },
    })
    if (!owner) throw new ForbiddenError('That owner is not available to you.')
    ownerName = owner.name
  }

  const inScope = await db.client.findMany({
    where: { AND: [clientScope(user), { id: { in: clientIds } }] },
    select: { id: true, firstName: true, lastName: true, ownerId: true, owner: { select: { name: true } } },
  })
  const scopeById = new Map(inScope.map((c) => [c.id, c]))

  const results: BulkRowResult[] = []
  for (const id of clientIds) {
    const client = scopeById.get(id)
    if (!client) {
      results.push({ id, name: 'Unknown client', ok: false, error: 'Not found or outside your scope.' })
      continue
    }
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff:${user.organizationId}`}))`
      if (ownerId && !await tx.user.findFirst({ where: { id: ownerId, organizationId: user.organizationId, isActive: true, deletedAt: null, role: { key: 'CLOSER' } } })) throw new ForbiddenError('That closer is no longer active.')
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${id} FOR UPDATE`
      const now = new Date()
      await tx.assignment.updateMany({ where: { clientId: id, role: 'CLOSER', isActive: true }, data: { isActive: false, unassignedAt: now } })
      if (ownerId) await tx.assignment.create({ data: { clientId: id, assigneeId: ownerId, assignedById: user.id, role: 'CLOSER', reason: 'Manual reassignment' } })
      await tx.client.update({ where: { id }, data: { ownerId, lastActivityAt: now } })
      await tx.appointment.updateMany({ where: { clientId: id, startsAt: { gte: now }, status: { in: ['SCHEDULED', 'CONFIRMED'] } }, data: { ownerId } })
    })
    await recordAudit(user, {
      action: 'client.reassigned',
      entityType: 'Client',
      entityId: id,
      summary: `${client.owner?.name ?? 'Unassigned'} → ${ownerName ?? 'Unassigned'}`,
      before: { ownerId: client.ownerId },
      after: { ownerId },
    })
    results.push({ id, name: fullName(client), ok: true })
  }
  return results
}

/** Adds the same internal note to each selected client. Audited per client. */
export async function addNoteToClients(
  user: SessionUser,
  clientIds: string[],
  body: string,
): Promise<BulkRowResult[]> {
  if (!user.permissions.has('clients:update')) throw new ForbiddenError()

  const inScope = await db.client.findMany({
    where: { AND: [clientScope(user), { id: { in: clientIds } }] },
    select: { id: true, firstName: true, lastName: true },
  })
  const scopeById = new Map(inScope.map((c) => [c.id, c]))

  const results: BulkRowResult[] = []
  for (const id of clientIds) {
    const client = scopeById.get(id)
    if (!client) {
      results.push({ id, name: 'Unknown client', ok: false, error: 'Not found or outside your scope.' })
      continue
    }
    await db.note.create({ data: { clientId: id, authorId: user.id, body, isInternal: true } })
    await db.client.update({ where: { id }, data: { lastActivityAt: new Date() } })
    await recordAudit(user, {
      action: 'client.note_added',
      entityType: 'Client',
      entityId: id,
      summary: `Bulk note: ${body.slice(0, 80)}${body.length > 80 ? '…' : ''}`,
    })
    results.push({ id, name: fullName(client), ok: true })
  }
  return results
}

// ── Saved filters ────────────────────────────────────────────────────────────

/** Filters visible to this user on a route: their own plus org-shared ones. */
export function savedFilterVisibleWhere(user: SessionUser, route = '/clients'): Prisma.SavedFilterWhereInput {
  return {
    organizationId: user.organizationId,
    route,
    OR: [{ userId: user.id }, { isShared: true }],
  }
}

/** A saved filter is deletable by its creator, or by anyone who manages users. */
export function canDeleteSavedFilter(
  user: SessionUser,
  filter: Pick<SavedFilter, 'userId' | 'organizationId'>,
): boolean {
  if (filter.organizationId !== user.organizationId) return false
  return filter.userId === user.id || user.permissions.has('users:manage')
}
