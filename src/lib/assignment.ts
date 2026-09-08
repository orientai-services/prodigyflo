import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { can, canAny, clientScope, ForbiddenError, userScope, type SessionUser } from '@/lib/rbac'
import { getAIProvider } from '@/lib/ai'
import { isAIConfigured } from '@/lib/ai/provider'
import type { AIMissing, AIReason, AssignmentInput, CloserCandidate } from '@/lib/ai/provider'

/**
 * AI closer assignment — human-in-the-loop.
 *
 * The provider ranks candidate closers (deterministic weighted scoring, see
 * src/lib/ai/scoring.ts) and the result is stored as a PENDING_REVIEW
 * AIRecommendation. Nothing about the client changes until a person with the
 * reassignment permission accepts the pick or overrides it with a reason.
 */

// ─── Pure candidate building (unit-tested in assignment.test.ts) ─────────────

export type CloserRow = {
  id: string
  name: string
  maxWorkload: number
  languages: string[]
  licensedIn: string[]
  specialties: string[]
  regionName: string | null
  teamName: string | null
}

export type CloserStats = {
  /** Live pipeline per owner: ACTIVE clients sitting in a non-terminal stage. */
  activeByOwner: ReadonlyMap<string, number>
  /** Terminal outcomes per owner among clients that reached QUALIFIED. */
  outcomesByOwner: ReadonlyMap<string, { won: number; lost: number }>
  /** Most recent CLOSER assignment per assignee, for fair rotation. */
  lastAssignedByAssignee: ReadonlyMap<string, Date>
}

/**
 * Folds roster rows and pipeline stats into the provider's candidate shape.
 * Close rate is only reported once at least one decided client exists; the
 * scoring layer additionally ignores samples that are too small to mean much.
 */
export function buildCloserCandidates(rows: CloserRow[], stats: CloserStats): CloserCandidate[] {
  return rows.map((r) => {
    const activeClients = stats.activeByOwner.get(r.id) ?? 0
    const outcomes = stats.outcomesByOwner.get(r.id) ?? { won: 0, lost: 0 }
    const decided = outcomes.won + outcomes.lost
    return {
      id: r.id,
      name: r.name,
      regionName: r.regionName,
      teamName: r.teamName,
      languages: r.languages,
      licensedIn: r.licensedIn,
      specialties: r.specialties,
      activeClients,
      capacity: Math.max(1, r.maxWorkload),
      closeRatePct: decided > 0 ? Math.round((outcomes.won / decided) * 1000) / 10 : null,
      sampleSize: decided,
      lastAssignedAt: stats.lastAssignedByAssignee.get(r.id)?.toISOString() ?? null,
    }
  })
}

// ─── Serialized views (safe for client components via `import type`) ─────────

export type RankedCloser = { id: string; name: string; score: number; disqualifiers: string[] }

export type AssignmentSuggestionView = {
  id: string
  status: 'PENDING_REVIEW' | 'ACCEPTED' | 'OVERRIDDEN' | 'DISMISSED'
  provider: string
  model: string | null
  summary: string | null
  confidence: number | null
  reasons: AIReason[]
  missingInformation: AIMissing[]
  recommendedCloserId: string | null
  recommendedCloserName: string | null
  ranking: RankedCloser[]
  createdAt: string
  reviewedByName: string | null
}

export type CloserOption = {
  id: string
  name: string
  teamName: string | null
  activeClients: number
  capacity: number
}

export type AssignmentPanelData = {
  clientId: string
  clientName: string
  ownerName: string | null
  assignment: {
    assigneeName: string
    assignedAt: string
    viaAI: boolean
    wasOverride: boolean
    assignedByName: string | null
  } | null
  pending: AssignmentSuggestionView | null
  lastDecision: AssignmentSuggestionView | null
  closers: CloserOption[]
  canSuggest: boolean
  canAssign: boolean
  canReview: boolean
  mock: boolean
  modelLabel: string | null
}

type RecRow = Prisma.AIRecommendationGetPayload<{ include: { reviewer: { select: { name: true } } } }>

function toSuggestionView(row: RecRow): AssignmentSuggestionView {
  const rec = (row.recommendation ?? {}) as Record<string, unknown>
  const rawRanking = Array.isArray(rec.ranking) ? (rec.ranking as Record<string, unknown>[]) : []
  return {
    id: row.id,
    status: row.status,
    provider: row.provider,
    model: row.model,
    summary: row.summary,
    confidence: row.confidence,
    reasons: Array.isArray(row.reasons) ? (row.reasons as AIReason[]) : [],
    missingInformation: Array.isArray(row.missingInformation) ? (row.missingInformation as AIMissing[]) : [],
    recommendedCloserId: typeof rec.closerId === 'string' ? rec.closerId : null,
    recommendedCloserName: typeof rec.closerName === 'string' ? rec.closerName : null,
    ranking: rawRanking
      .filter((r) => typeof r.id === 'string' && typeof r.name === 'string')
      .map((r) => ({
        id: r.id as string,
        name: r.name as string,
        score: typeof r.score === 'number' ? r.score : 0,
        disqualifiers: Array.isArray(r.disqualifiers) ? (r.disqualifiers as string[]) : [],
      })),
    createdAt: row.createdAt.toISOString(),
    reviewedByName: row.reviewer?.name ?? null,
  }
}

// ─── Candidate loading ───────────────────────────────────────────────────────

/** Active CLOSER-role users visible to the caller, with live pipeline stats. */
async function loadCandidates(user: SessionUser): Promise<CloserCandidate[]> {
  const users = await db.user.findMany({
    where: { AND: [userScope(user), { isActive: true, role: { key: 'CLOSER' } }] },
    select: {
      id: true,
      name: true,
      maxWorkload: true,
      languages: true,
      licensedIn: true,
      specialties: true,
      region: { select: { name: true } },
      team: { select: { name: true } },
    },
    orderBy: { name: 'asc' },
  })
  if (users.length === 0) return []
  const ids = users.map((u) => u.id)

  const [active, decided, lastAssigned] = await Promise.all([
    db.client.groupBy({
      by: ['ownerId'],
      where: {
        organizationId: user.organizationId,
        deletedAt: null,
        status: 'ACTIVE',
        currentStage: { isTerminal: false },
        ownerId: { in: ids },
      },
      _count: { _all: true },
    }),
    db.client.findMany({
      where: {
        organizationId: user.organizationId,
        deletedAt: null,
        ownerId: { in: ids },
        stageHistory: { some: { toKey: 'QUALIFIED' } },
        currentStage: { key: { in: ['CLOSED_WON', 'CLOSED_LOST'] } },
      },
      select: { ownerId: true, currentStage: { select: { key: true } } },
    }),
    db.assignment.groupBy({
      by: ['assigneeId'],
      where: { assigneeId: { in: ids }, role: 'CLOSER' },
      _max: { assignedAt: true },
    }),
  ])

  const activeByOwner = new Map<string, number>()
  for (const g of active) if (g.ownerId) activeByOwner.set(g.ownerId, g._count._all)

  const outcomesByOwner = new Map<string, { won: number; lost: number }>()
  for (const c of decided) {
    if (!c.ownerId) continue
    const o = outcomesByOwner.get(c.ownerId) ?? { won: 0, lost: 0 }
    if (c.currentStage.key === 'CLOSED_WON') o.won += 1
    else o.lost += 1
    outcomesByOwner.set(c.ownerId, o)
  }

  const lastAssignedByAssignee = new Map<string, Date>()
  for (const g of lastAssigned) if (g._max.assignedAt) lastAssignedByAssignee.set(g.assigneeId, g._max.assignedAt)

  const rows: CloserRow[] = users.map((u) => ({
    id: u.id,
    name: u.name,
    maxWorkload: u.maxWorkload,
    languages: u.languages,
    licensedIn: u.licensedIn,
    specialties: u.specialties,
    regionName: u.region?.name ?? null,
    teamName: u.team?.name ?? null,
  }))

  return buildCloserCandidates(rows, { activeByOwner, outcomesByOwner, lastAssignedByAssignee })
}

// ─── Panel data ──────────────────────────────────────────────────────────────

/**
 * The perms whose holders the assignment panel exists for. Anyone without at
 * least one (portal CLIENTs, document collectors) never sees AI analysis —
 * staff names, scores, disqualifiers, and reviewer names are internal.
 */
export const ASSIGNMENT_PANEL_PERMISSIONS = ['ai:run', 'ai:review', 'clients:reassign'] as const

export async function getAssignmentPanelData(
  user: SessionUser,
  clientId: string,
): Promise<AssignmentPanelData | null> {
  if (!canAny(user, [...ASSIGNMENT_PANEL_PERMISSIONS])) {
    throw new ForbiddenError('You do not have permission to view assignment analysis.')
  }

  const client = await db.client.findFirst({
    where: { AND: [clientScope(user), { id: clientId }] },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      owner: { select: { name: true } },
      assignments: {
        where: { role: 'CLOSER', isActive: true },
        orderBy: { assignedAt: 'desc' },
        take: 1,
        select: {
          assignedAt: true,
          wasOverride: true,
          aiRecommendationId: true,
          assignee: { select: { name: true } },
          assignedBy: { select: { name: true } },
        },
      },
    },
  })
  if (!client) return null

  const canSuggest = can(user, 'ai:run')
  const canAssign = can(user, 'clients:reassign')
  const canReview = can(user, 'ai:review')

  const [recs, candidates] = await Promise.all([
    db.aIRecommendation.findMany({
      where: { clientId, type: 'CLOSER_ASSIGNMENT' },
      include: { reviewer: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    canAssign || canSuggest ? loadCandidates(user) : Promise.resolve([]),
  ])

  const pendingRow = recs.find((r) => r.status === 'PENDING_REVIEW')
  const decidedRow = recs.find((r) => r.status !== 'PENDING_REVIEW')
  const active = client.assignments[0]

  const provider = getAIProvider()
  return {
    clientId: client.id,
    clientName: `${client.firstName} ${client.lastName}`,
    ownerName: client.owner?.name ?? null,
    assignment: active
      ? {
          assigneeName: active.assignee.name,
          assignedAt: active.assignedAt.toISOString(),
          viaAI: active.aiRecommendationId !== null && !active.wasOverride,
          wasOverride: active.wasOverride,
          assignedByName: active.assignedBy?.name ?? null,
        }
      : null,
    pending: pendingRow ? toSuggestionView(pendingRow) : null,
    lastDecision: decidedRow ? toSuggestionView(decidedRow) : null,
    closers: candidates.map((c) => ({
      id: c.id,
      name: c.name,
      teamName: c.teamName,
      activeClients: c.activeClients,
      capacity: c.capacity,
    })),
    canSuggest,
    canAssign,
    canReview,
    mock: !isAIConfigured(),
    modelLabel: provider.model,
  }
}

// ─── Suggest ─────────────────────────────────────────────────────────────────

export type SuggestionResult =
  | { ok: true; suggestion: AssignmentSuggestionView }
  | { ok: false; error: string }

/**
 * Builds the assignment input, asks the provider for a ranked recommendation,
 * and persists it as PENDING_REVIEW. The AI call happens outside any DB
 * transaction; this function changes nothing on the client record.
 */
export async function getAssignmentSuggestion(user: SessionUser, clientId: string): Promise<SuggestionResult> {
  if (!can(user, 'ai:run')) throw new ForbiddenError('You do not have permission to run AI analysis.')

  const client = await db.client.findFirst({
    where: { AND: [clientScope(user), { id: clientId }] },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      preferredLanguage: true,
      estimatedValue: true,
      region: { select: { name: true } },
      leadSource: { select: { name: true } },
      addresses: { orderBy: { isPrimary: 'desc' }, take: 1, select: { state: true } },
    },
  })
  if (!client) return { ok: false, error: 'Client not found or out of your scope.' }

  const candidates = await loadCandidates(user)
  if (candidates.length === 0) {
    return { ok: false, error: 'No active closers are available in your scope to consider.' }
  }

  const input: AssignmentInput = {
    client: {
      firstName: client.firstName,
      lastName: client.lastName,
      preferredLanguage: client.preferredLanguage,
      regionName: client.region?.name ?? null,
      state: client.addresses[0]?.state ?? null,
      leadSourceName: client.leadSource?.name ?? null,
      estimatedValue: client.estimatedValue === null ? null : Number(client.estimatedValue),
    },
    candidates,
  }

  // Provider call stays outside any DB transaction (it can take seconds).
  const provider = getAIProvider()
  const analysis = await provider.recommendCloser(input)

  const row = await db.aIRecommendation.create({
    data: {
      clientId: client.id,
      type: 'CLOSER_ASSIGNMENT',
      status: 'PENDING_REVIEW',
      provider: analysis.provider,
      model: analysis.model,
      summary: analysis.summary,
      confidence: Math.round(analysis.confidence),
      facts: analysis.facts as unknown as Prisma.InputJsonValue,
      inferences: analysis.inferences as unknown as Prisma.InputJsonValue,
      reasons: analysis.reasons as unknown as Prisma.InputJsonValue,
      missingInformation: analysis.missingInformation as unknown as Prisma.InputJsonValue,
      complianceFlags: analysis.complianceFlags as unknown as Prisma.InputJsonValue,
      recommendation: analysis.recommendation as Prisma.InputJsonValue,
      promptTokens: analysis.promptTokens ?? null,
      completionTokens: analysis.completionTokens ?? null,
    },
    include: { reviewer: { select: { name: true } } },
  })

  const view = toSuggestionView(row)
  await recordAudit(user, {
    action: 'ai.assignment.suggested',
    entityType: 'AIRecommendation',
    entityId: row.id,
    summary: `Suggested closer for ${client.firstName} ${client.lastName}: ${view.recommendedCloserName ?? 'no eligible closer'} (${analysis.provider})`,
  })

  return { ok: true, suggestion: view }
}

// ─── Apply (accept, override, or manual) ─────────────────────────────────────

export type ApplyAssignmentResult =
  | { ok: true; assigneeName: string; wasOverride: boolean }
  | { ok: false; error: string }

/**
 * Assigns a closer to the client. Same permission gate as bulk reassignment
 * (`clients:reassign`, see reassignClients in src/lib/reporting.ts). When a
 * recommendation is linked and the chosen closer differs from the AI pick, the
 * assignment is recorded as an override and requires a reason.
 */
export async function applyAssignment(
  user: SessionUser,
  input: { clientId: string; assigneeId: string; recommendationId?: string; overrideReason?: string },
): Promise<ApplyAssignmentResult> {
  if (!user.permissions.has('clients:reassign')) throw new ForbiddenError()

  const client = await db.client.findFirst({
    where: { AND: [clientScope(user), { id: input.clientId }] },
    select: { id: true, firstName: true, lastName: true, ownerId: true, owner: { select: { name: true } } },
  })
  if (!client) return { ok: false, error: 'Client not found or out of your scope.' }

  const assignee = await db.user.findFirst({
    where: { AND: [userScope(user), { id: input.assigneeId, isActive: true, role: { key: 'CLOSER' } }] },
    select: { id: true, name: true },
  })
  if (!assignee) throw new ForbiddenError('That closer is not available to you.')

  let rec: RecRow | null = null
  let aiPickId: string | null = null
  let aiPickName: string | null = null
  if (input.recommendationId) {
    rec = await db.aIRecommendation.findFirst({
      where: {
        id: input.recommendationId,
        clientId: client.id,
        type: 'CLOSER_ASSIGNMENT',
        client: clientScope(user),
      },
      include: { reviewer: { select: { name: true } } },
    })
    if (!rec) return { ok: false, error: 'That suggestion no longer exists.' }
    if (rec.status !== 'PENDING_REVIEW') return { ok: false, error: 'That suggestion was already reviewed.' }
    const r = (rec.recommendation ?? {}) as Record<string, unknown>
    aiPickId = typeof r.closerId === 'string' ? r.closerId : null
    aiPickName = typeof r.closerName === 'string' ? r.closerName : null
  }

  const wasOverride = aiPickId !== null && aiPickId !== assignee.id
  const overrideReason = input.overrideReason?.trim() || null
  if (wasOverride && !overrideReason) {
    return { ok: false, error: 'An override reason is required when you choose someone other than the AI pick.' }
  }

  const now = new Date()
  await db.$transaction(async (tx) => {
    await tx.assignment.updateMany({
      where: { clientId: client.id, role: 'CLOSER', isActive: true },
      data: { isActive: false, unassignedAt: now },
    })
    await tx.assignment.create({
      data: {
        clientId: client.id,
        assigneeId: assignee.id,
        assignedById: user.id,
        role: 'CLOSER',
        isActive: true,
        aiRecommendationId: rec?.id ?? null,
        wasOverride,
        overrideReason: wasOverride ? overrideReason : null,
        reason: rec
          ? wasOverride
            ? `Override of AI suggestion (${aiPickName ?? 'unknown'})`
            : 'Accepted AI suggestion'
          : 'Manual assignment',
      },
    })
    await tx.client.update({
      where: { id: client.id },
      data: { ownerId: assignee.id, lastActivityAt: now },
    })
    if (rec) {
      await tx.aIRecommendation.update({
        where: { id: rec.id },
        data: {
          status: wasOverride ? 'OVERRIDDEN' : 'ACCEPTED',
          reviewedById: user.id,
          reviewedAt: now,
          overrideReason: wasOverride ? overrideReason : null,
        },
      })
    }
  })

  await recordAudit(user, {
    action: 'client.closer_assigned',
    entityType: 'Client',
    entityId: client.id,
    summary: `${client.owner?.name ?? 'Unassigned'} → ${assignee.name}${
      rec
        ? wasOverride
          ? ` (override of AI pick ${aiPickName ?? '—'}: ${overrideReason})`
          : ' (accepted AI suggestion)'
        : ''
    }`,
    before: { ownerId: client.ownerId },
    after: { ownerId: assignee.id, aiRecommendationId: rec?.id ?? null, wasOverride },
  })

  // The closer hears they picked up a lead without being told in person.
  if (assignee.id !== user.id) {
    await db.notification.create({
      data: {
        organizationId: user.organizationId,
        userId: assignee.id,
        kind: 'ASSIGNMENT',
        title: `New lead assigned: ${client.firstName} ${client.lastName}`.trim(),
        body: `${user.name} assigned you this lead${rec && !wasOverride ? ' (AI-suggested, human-approved)' : ''}.`,
        href: `/clients/${client.id}`,
      },
    })
  }

  return { ok: true, assigneeName: assignee.name, wasOverride }
}

// ─── Dismiss ─────────────────────────────────────────────────────────────────

export type DismissSuggestionResult = { ok: true } | { ok: false; error: string }

/** Marks a pending suggestion DISMISSED. No client data changes. */
export async function dismissAssignmentSuggestion(
  user: SessionUser,
  input: { clientId: string; recommendationId: string },
): Promise<DismissSuggestionResult> {
  if (!can(user, 'ai:review')) throw new ForbiddenError('You do not have permission to review AI recommendations.')

  const rec = await db.aIRecommendation.findFirst({
    where: {
      id: input.recommendationId,
      clientId: input.clientId,
      type: 'CLOSER_ASSIGNMENT',
      status: 'PENDING_REVIEW',
      client: clientScope(user),
    },
    select: { id: true },
  })
  if (!rec) return { ok: false, error: 'That suggestion no longer exists or was already reviewed.' }

  await db.aIRecommendation.update({
    where: { id: rec.id },
    data: { status: 'DISMISSED', reviewedById: user.id, reviewedAt: new Date() },
  })
  await recordAudit(user, {
    action: 'ai.assignment.dismissed',
    entityType: 'AIRecommendation',
    entityId: rec.id,
    summary: 'Dismissed AI closer suggestion — no assignment was made',
  })
  return { ok: true }
}
