import 'server-only'
import type { Prisma, StageKey } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'
import { DEFAULT_STAGES } from '@/lib/pipeline'
import { rate } from '@/lib/format'

export type AnalyticsFilters = {
  from?: Date
  to?: Date
  regionId?: string
  teamId?: string
  ownerId?: string
  campaignId?: string
  leadSourceId?: string
}

const STAGE_POSITION = new Map(DEFAULT_STAGES.map((s) => [s.key, s.position]))

/** Stage a client must have *reached* for the funnel step to count. */
const FUNNEL_STEPS: { key: string; label: string; stage: StageKey }[] = [
  { key: 'leads', label: 'Leads', stage: 'NEW_LEAD' },
  { key: 'survey', label: 'Survey completed', stage: 'SURVEY_COMPLETED' },
  { key: 'consent', label: 'Consent given', stage: 'CONSENT_PENDING' },
  { key: 'credit', label: 'Credit reviewed', stage: 'CREDIT_PULL_COMPLETED' },
  { key: 'qualified', label: 'Qualified', stage: 'QUALIFIED' },
  { key: 'appointment', label: 'Appointment set', stage: 'APPOINTMENT_SCHEDULED' },
  { key: 'presented', label: 'Presented', stage: 'PRESENTATION_COMPLETED' },
  { key: 'documents', label: 'Documents collected', stage: 'DOCUMENT_COLLECTION' },
  { key: 'submitted', label: 'Submitted', stage: 'SUBMITTED' },
  { key: 'won', label: 'Closed won', stage: 'CLOSED_WON' },
]

export function filterWhere(user: SessionUser, f: AnalyticsFilters = {}): Prisma.ClientWhereInput {
  const and: Prisma.ClientWhereInput[] = [clientScope(user)]

  if (f.from || f.to) {
    and.push({ createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } })
  }
  if (f.regionId) and.push({ regionId: f.regionId })
  if (f.teamId) and.push({ teamId: f.teamId })
  if (f.ownerId) and.push({ ownerId: f.ownerId })
  if (f.campaignId) and.push({ campaignId: f.campaignId })
  if (f.leadSourceId) and.push({ leadSourceId: f.leadSourceId })

  return { AND: and }
}

type ClientAnalyticsRow = {
  id: string
  ownerId: string | null
  teamId: string | null
  regionId: string | null
  campaignId: string | null
  leadSourceId: string | null
  createdAt: Date
  firstContactAt: Date | null
  stageEnteredAt: Date
  estimatedValue: Prisma.Decimal | null
  lostReason: string | null
  currentStage: { key: StageKey; slaHours: number | null }
  stageHistory: { toKey: StageKey; enteredAt: Date }[]
  appointments: { status: string; startsAt: Date }[]
  deal: { status: string; value: Prisma.Decimal; wonAt: Date | null } | null
}

async function loadRows(user: SessionUser, f: AnalyticsFilters): Promise<ClientAnalyticsRow[]> {
  return db.client.findMany({
    where: filterWhere(user, f),
    select: {
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
    },
  }) as unknown as Promise<ClientAnalyticsRow[]>
}

const reached = (row: ClientAnalyticsRow, stage: StageKey) =>
  row.stageHistory.some((h) => h.toKey === stage) ||
  (STAGE_POSITION.get(row.currentStage.key) ?? -1) >= (STAGE_POSITION.get(stage) ?? 99)

const num = (d: Prisma.Decimal | null | undefined) => (d ? Number(d.toString()) : 0)

export type CoreMetrics = {
  total: number
  contacted: number
  qualified: number
  appointmentsSet: number
  appointmentsHeld: number
  presented: number
  submitted: number
  won: number
  lost: number
  revenue: number
  pipelineValue: number
  avgDealSize: number | null
  /** Hours from creation to first recorded contact. */
  medianSpeedToContactHours: number | null
  /** Days from creation to won. */
  avgCycleDays: number | null
  contactRate: number | null
  qualificationRate: number | null
  appointmentRate: number | null
  showRate: number | null
  presentationRate: number | null
  closeRate: number | null
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function computeMetrics(rows: ClientAnalyticsRow[]): CoreMetrics {
  const total = rows.length
  const contacted = rows.filter((r) => r.firstContactAt).length
  const qualified = rows.filter((r) => reached(r, 'QUALIFIED')).length
  const appointmentsSet = rows.filter((r) => r.appointments.length > 0).length
  const appointmentsHeld = rows.filter((r) =>
    r.appointments.some((a) => a.status === 'COMPLETED'),
  ).length
  const presented = rows.filter((r) => reached(r, 'PRESENTATION_COMPLETED')).length
  const submitted = rows.filter((r) => reached(r, 'SUBMITTED')).length
  const wonRows = rows.filter((r) => r.currentStage.key === 'CLOSED_WON')
  const lost = rows.filter((r) => r.currentStage.key === 'CLOSED_LOST').length

  const revenue = wonRows.reduce((sum, r) => sum + (r.deal ? num(r.deal.value) : num(r.estimatedValue)), 0)
  const openRows = rows.filter(
    (r) => !['CLOSED_WON', 'CLOSED_LOST', 'NOT_QUALIFIED'].includes(r.currentStage.key),
  )
  const pipelineValue = openRows.reduce((sum, r) => sum + num(r.estimatedValue), 0)

  const speeds = rows
    .filter((r) => r.firstContactAt)
    .map((r) => (r.firstContactAt!.getTime() - r.createdAt.getTime()) / 3_600_000)
    .filter((h) => h >= 0)

  const cycles = wonRows
    .map((r) => {
      const wonAt = r.deal?.wonAt ?? r.stageEnteredAt
      return (wonAt.getTime() - r.createdAt.getTime()) / 86_400_000
    })
    .filter((d) => d >= 0)

  return {
    total,
    contacted,
    qualified,
    appointmentsSet,
    appointmentsHeld,
    presented,
    submitted,
    won: wonRows.length,
    lost,
    revenue,
    pipelineValue,
    avgDealSize: wonRows.length ? revenue / wonRows.length : null,
    medianSpeedToContactHours: median(speeds),
    avgCycleDays: cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null,
    contactRate: rate(contacted, total),
    qualificationRate: rate(qualified, total),
    appointmentRate: rate(appointmentsSet, qualified),
    showRate: rate(appointmentsHeld, appointmentsSet),
    presentationRate: rate(presented, appointmentsSet),
    closeRate: rate(wonRows.length, wonRows.length + lost),
  }
}

export async function getMetrics(user: SessionUser, f: AnalyticsFilters = {}): Promise<CoreMetrics> {
  return computeMetrics(await loadRows(user, f))
}

/** Funnel with per-step conversion and drop-off. */
export async function getFunnel(user: SessionUser, f: AnalyticsFilters = {}) {
  const rows = await loadRows(user, f)
  const counts = FUNNEL_STEPS.map((step) => ({
    ...step,
    count: rows.filter((r) => reached(r, step.stage)).length,
  }))

  return counts.map((step, i) => {
    const prev = i === 0 ? step.count : counts[i - 1].count
    return {
      key: step.key,
      label: step.label,
      count: step.count,
      /** Share of the very first step. */
      ofTotal: rate(step.count, counts[0].count),
      /** Share of the immediately preceding step. */
      stepConversion: i === 0 ? null : rate(step.count, prev),
      droppedOff: i === 0 ? 0 : Math.max(0, prev - step.count),
    }
  })
}

/** Average time spent in each stage, plus how many are sitting there now. */
export async function getStageAging(user: SessionUser, f: AnalyticsFilters = {}) {
  const [current, history] = await Promise.all([
    db.client.groupBy({
      by: ['currentStageId'],
      where: filterWhere(user, f),
      _count: { _all: true },
    }),
    db.stageHistory.groupBy({
      by: ['toKey'],
      where: { client: filterWhere(user, f), durationMinutes: { not: null } },
      _avg: { durationMinutes: true },
      _count: { _all: true },
    }),
  ])

  const stages = await db.pipelineStage.findMany({
    where: { pipeline: { organizationId: user.organizationId, isDefault: true } },
    orderBy: { position: 'asc' },
  })

  const currentByStage = new Map(current.map((c) => [c.currentStageId, c._count._all]))
  const avgByKey = new Map(history.map((h) => [h.toKey, h._avg.durationMinutes]))

  return stages.map((s) => ({
    key: s.key,
    name: s.name,
    category: s.category,
    position: s.position,
    slaHours: s.slaHours,
    inStage: currentByStage.get(s.id) ?? 0,
    avgMinutes: avgByKey.get(s.key) ?? null,
    sample: history.find((h) => h.toKey === s.key)?._count._all ?? 0,
  }))
}

export type LeaderboardRow = {
  id: string
  name: string
  teamName: string | null
  regionName: string | null
  metrics: CoreMetrics
  /** True when the sample is too small to rank fairly. */
  belowMinimumSample: boolean
}

/**
 * Per-closer performance. Rows below `minimumSample` are returned but flagged,
 * never silently dropped and never ranked against large samples.
 */
export async function getLeaderboard(
  user: SessionUser,
  f: AnalyticsFilters = {},
  minimumSample = 10,
): Promise<LeaderboardRow[]> {
  const rows = await loadRows(user, f)
  const owners = await db.user.findMany({
    where: {
      organizationId: user.organizationId,
      role: { key: 'CLOSER' },
      deletedAt: null,
      ...(f.regionId ? { regionId: f.regionId } : {}),
      ...(f.teamId ? { teamId: f.teamId } : {}),
    },
    select: {
      id: true,
      name: true,
      team: { select: { name: true } },
      region: { select: { name: true } },
    },
  })

  const byOwner = new Map<string, ClientAnalyticsRow[]>()
  for (const row of rows) {
    if (!row.ownerId) continue
    const list = byOwner.get(row.ownerId) ?? []
    list.push(row)
    byOwner.set(row.ownerId, list)
  }

  return owners
    .map((o) => {
      const ownerRows = byOwner.get(o.id) ?? []
      return {
        id: o.id,
        name: o.name,
        teamName: o.team?.name ?? null,
        regionName: o.region?.name ?? null,
        metrics: computeMetrics(ownerRows),
        belowMinimumSample: ownerRows.length < minimumSample,
      }
    })
    .sort((a, b) => {
      if (a.belowMinimumSample !== b.belowMinimumSample) return a.belowMinimumSample ? 1 : -1
      return b.metrics.revenue - a.metrics.revenue
    })
}

/** Attribution and spend efficiency by campaign. */
export async function getCampaignPerformance(user: SessionUser, f: AnalyticsFilters = {}) {
  const [campaigns, rows] = await Promise.all([
    db.campaign.findMany({
      where: { organizationId: user.organizationId },
      include: { leadSource: { select: { name: true, channel: true } } },
    }),
    loadRows(user, f),
  ])

  return campaigns
    .map((c) => {
      const mine = rows.filter((r) => r.campaignId === c.id)
      const m = computeMetrics(mine)
      const spend = num(c.spend)
      return {
        id: c.id,
        name: c.name,
        channel: c.leadSource?.channel ?? c.channel,
        sourceName: c.leadSource?.name ?? '—',
        spend,
        impressions: c.impressions,
        clicks: c.clicks,
        leads: m.total,
        qualified: m.qualified,
        appointments: m.appointmentsSet,
        won: m.won,
        revenue: m.revenue,
        costPerLead: m.total ? spend / m.total : null,
        costPerAppointment: m.appointmentsSet ? spend / m.appointmentsSet : null,
        cac: m.won ? spend / m.won : null,
        roas: spend ? m.revenue / spend : null,
        qualifiedRate: rate(m.qualified, m.total),
        closeRate: m.closeRate,
      }
    })
    .sort((a, b) => b.revenue - a.revenue)
}

export async function getSourcePerformance(user: SessionUser, f: AnalyticsFilters = {}) {
  const [sources, rows] = await Promise.all([
    db.leadSource.findMany({ where: { organizationId: user.organizationId } }),
    loadRows(user, f),
  ])

  return sources
    .map((s) => {
      const mine = rows.filter((r) => r.leadSourceId === s.id)
      const m = computeMetrics(mine)
      return {
        id: s.id,
        name: s.name,
        channel: s.channel,
        leads: m.total,
        qualified: m.qualified,
        won: m.won,
        revenue: m.revenue,
        qualifiedRate: rate(m.qualified, m.total),
        closeRate: m.closeRate,
      }
    })
    .sort((a, b) => b.leads - a.leads)
}

/** Monthly revenue and lead volume for trend charts. */
export async function getMonthlyTrend(user: SessionUser, months = 6, f: AnalyticsFilters = {}) {
  const rows = await loadRows(user, { ...f, from: undefined })
  const buckets: { month: string; label: string; leads: number; won: number; revenue: number }[] = []

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(1)
    d.setMonth(d.getMonth() - i)
    const start = new Date(d.getFullYear(), d.getMonth(), 1)
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1)

    const created = rows.filter((r) => r.createdAt >= start && r.createdAt < end)
    const won = rows.filter((r) => r.deal?.wonAt && r.deal.wonAt >= start && r.deal.wonAt < end)

    buckets.push({
      month: start.toISOString().slice(0, 7),
      label: start.toLocaleDateString('en-US', { month: 'short' }),
      leads: created.length,
      won: won.length,
      revenue: won.reduce((sum, r) => sum + num(r.deal!.value), 0),
    })
  }
  return buckets
}

/** Open clients past their stage SLA, ordered by how far past. */
export async function getAtRiskClients(user: SessionUser, limit = 10) {
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
      estimatedValue: true,
      owner: { select: { id: true, name: true } },
      currentStage: { select: { key: true, name: true, category: true, slaHours: true } },
    },
    take: 200,
  })

  return clients
    .map((c) => {
      const elapsed = (Date.now() - c.stageEnteredAt.getTime()) / 3_600_000
      return { ...c, elapsedHours: elapsed, overBy: elapsed - (c.currentStage.slaHours ?? 0) }
    })
    .filter((c) => c.overBy > 0)
    .sort((a, b) => b.overBy - a.overBy)
    .slice(0, limit)
}

export async function getLossReasons(user: SessionUser, f: AnalyticsFilters = {}) {
  const rows = await db.client.groupBy({
    by: ['lostReason'],
    where: { AND: [filterWhere(user, f), { lostReason: { not: null } }] },
    _count: { _all: true },
  })
  const total = rows.reduce((sum, r) => sum + r._count._all, 0)
  return rows
    .map((r) => ({ reason: r.lostReason!, count: r._count._all, share: rate(r._count._all, total) }))
    .sort((a, b) => b.count - a.count)
}

/** Active client load per closer, against their configured cap. */
export async function getWorkloadDistribution(user: SessionUser) {
  const closers = await db.user.findMany({
    where: { organizationId: user.organizationId, role: { key: 'CLOSER' }, deletedAt: null, isActive: true },
    select: {
      id: true,
      name: true,
      maxWorkload: true,
      team: { select: { name: true } },
      _count: { select: { ownedClients: { where: { status: 'ACTIVE', deletedAt: null } } } },
    },
  })

  return closers
    .map((c) => ({
      id: c.id,
      name: c.name,
      teamName: c.team?.name ?? null,
      active: c._count.ownedClients,
      capacity: c.maxWorkload,
      utilization: rate(c._count.ownedClients, c.maxWorkload) ?? 0,
    }))
    .sort((a, b) => b.utilization - a.utilization)
}
