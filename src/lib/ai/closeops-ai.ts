import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { can, clientScope, ForbiddenError, type SessionUser } from '@/lib/rbac'
import { getAIProvider } from './index'
import { buildAssistContext } from './assists'
import type { CloserBriefContent } from './provider'

/**
 * Close-rate operations AI: probability-to-close scoring and Closer Briefs.
 *
 * Scoring persists exactly two fields on Client — aiCloseProbability and
 * aiCloseProbabilityAt. The reasons behind a score are returned to the caller
 * for display and stored nowhere: the number is a prioritization signal, not a
 * record of judgment. Briefs persist as CloserBrief rows; viewedAt/viewedById
 * power the adoption metric in closeops.ts and are set only on a genuine view.
 *
 * AI calls always run OUTSIDE any database transaction — a model call can take
 * tens of seconds and must never hold a connection open.
 */

// ─── Serialized views (safe for client components via `import type`) ─────────

export type CloseScoreView = {
  clientId: string
  probability: number
  reasons: string[]
  confidence: 'low' | 'medium' | 'high'
  scoredAt: string
  provider: string
  model: string | null
}

export type BriefView = {
  id: string
  clientId: string
  content: CloserBriefContent
  provider: string
  model: string | null
  generatedAt: string
  requestedByName: string | null
  viewedAt: string | null
  viewedByName: string | null
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Coerces a stored content JSON into a well-formed brief; missing pieces render empty. */
export function asBriefContent(value: unknown): CloserBriefContent {
  const raw = (value ?? {}) as Record<string, unknown>
  const objections = Array.isArray(raw.objections)
    ? raw.objections
        .map((o) => ({ objection: str((o as Record<string, unknown>)?.objection), response: str((o as Record<string, unknown>)?.response) }))
        .filter((o) => o.objection)
    : []
  return {
    situation: str(raw.situation),
    highlights: strArray(raw.highlights),
    objections,
    talkingPoints: strArray(raw.talkingPoints),
    recommendedNextStep: str(raw.recommendedNextStep),
  }
}

type BriefRow = Prisma.CloserBriefGetPayload<{
  include: { requestedBy: { select: { name: true } }; viewedBy: { select: { name: true } } }
}>

function toBriefView(row: BriefRow): BriefView {
  return {
    id: row.id,
    clientId: row.clientId,
    content: asBriefContent(row.content),
    provider: row.provider,
    model: row.model,
    generatedAt: row.generatedAt.toISOString(),
    requestedByName: row.requestedBy?.name ?? null,
    viewedAt: row.viewedAt?.toISOString() ?? null,
    viewedByName: row.viewedBy?.name ?? null,
  }
}

/** Briefs for one client, newest first, scope-checked. */
export async function listBriefViews(user: SessionUser, clientId: string, take = 10): Promise<BriefView[]> {
  const rows = await db.closerBrief.findMany({
    where: { clientId, client: clientScope(user) },
    include: { requestedBy: { select: { name: true } }, viewedBy: { select: { name: true } } },
    orderBy: { generatedAt: 'desc' },
    take,
  })
  return rows.map(toBriefView)
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export type RescoreResult = { ok: true; score: CloseScoreView } | { ok: false; error: string }

/**
 * Scores one client and persists the number + timestamp on the Client row.
 * The reasons come back to the caller only — nothing else is stored.
 */
export async function rescoreClient(user: SessionUser, clientId: string): Promise<RescoreResult> {
  if (!can(user, 'ai:run')) throw new ForbiddenError('You do not have permission to run AI analysis.')

  const context = await buildAssistContext(user, clientId)
  if (!context) return { ok: false, error: 'Client not found or out of your scope.' }

  const provider = getAIProvider()
  const result = await provider.scoreCloseProbability(context)

  const scoredAt = new Date()
  await db.client.update({
    where: { id: clientId },
    data: { aiCloseProbability: result.probability, aiCloseProbabilityAt: scoredAt },
  })

  await recordAudit(user, {
    action: 'client.ai_scored',
    entityType: 'Client',
    entityId: clientId,
    summary: `AI close probability ${result.probability}% (${result.confidence} confidence, ${provider.name}) for ${context.client.firstName} ${context.client.lastName}`,
  })

  return {
    ok: true,
    score: {
      clientId,
      probability: result.probability,
      reasons: result.reasons,
      confidence: result.confidence,
      scoredAt: scoredAt.toISOString(),
      provider: provider.name,
      model: provider.model,
    },
  }
}

/**
 * Batch entry point: scores clients in the caller's scope that have no score
 * yet or whose score is older than 7 days. Live files only. Sequential on
 * purpose — each score is a model call.
 */
export async function scoreUnscoredClients(
  user: SessionUser,
  limit = 25,
): Promise<{ scored: number; skipped: number; candidates: number }> {
  if (!can(user, 'ai:run')) throw new ForbiddenError('You do not have permission to run AI analysis.')

  const staleCutoff = new Date(Date.now() - 7 * 86_400_000)
  const rows = await db.client.findMany({
    where: {
      ...clientScope(user),
      status: 'ACTIVE',
      currentStage: { isTerminal: false },
      OR: [{ aiCloseProbability: null }, { aiCloseProbabilityAt: null }, { aiCloseProbabilityAt: { lt: staleCutoff } }],
    },
    orderBy: { lastActivityAt: 'desc' },
    take: Math.min(Math.max(1, limit), 100),
    select: { id: true },
  })

  let scored = 0
  let skipped = 0
  for (const row of rows) {
    try {
      const result = await rescoreClient(user, row.id)
      if (result.ok) scored++
      else skipped++
    } catch {
      skipped++
    }
  }
  return { scored, skipped, candidates: rows.length }
}

// ─── Closer Briefs ───────────────────────────────────────────────────────────

export type GenerateBriefResult = { ok: true; brief: BriefView } | { ok: false; error: string }

/** Generates a fresh pre-call brief and stores it as a CloserBrief row. */
export async function generateBrief(user: SessionUser, clientId: string): Promise<GenerateBriefResult> {
  if (!can(user, 'ai:run')) throw new ForbiddenError('You do not have permission to run AI analysis.')

  const context = await buildAssistContext(user, clientId)
  if (!context) return { ok: false, error: 'Client not found or out of your scope.' }

  const provider = getAIProvider()
  const content = await provider.generateCloserBrief(context)

  const row = await db.closerBrief.create({
    data: {
      organizationId: user.organizationId,
      clientId,
      requestedById: user.id,
      provider: provider.name,
      model: provider.model,
      content: content as unknown as Prisma.InputJsonValue,
    },
    include: { requestedBy: { select: { name: true } }, viewedBy: { select: { name: true } } },
  })

  await recordAudit(user, {
    action: 'client.brief_generated',
    entityType: 'CloserBrief',
    entityId: row.id,
    summary: `Generated Closer Brief (${provider.name}) for ${context.client.firstName} ${context.client.lastName}`,
  })

  return { ok: true, brief: toBriefView(row) }
}

export type MarkBriefViewedResult = { ok: true; alreadyViewed: boolean } | { ok: false; error: string }

/**
 * Records the first genuine view of a brief — called when a person actually
 * opens it, never on page load. First viewer wins; later views are no-ops.
 * This single timestamp powers the "AI Brief adoption on calls" phase metric.
 */
export async function markBriefViewed(user: SessionUser, briefId: string): Promise<MarkBriefViewedResult> {
  const brief = await db.closerBrief.findFirst({
    where: { id: briefId, client: clientScope(user) },
    select: { id: true, clientId: true, viewedAt: true },
  })
  if (!brief) return { ok: false, error: 'Brief not found or out of your scope.' }
  if (brief.viewedAt) return { ok: true, alreadyViewed: true }

  // Atomic claim: only the request that flips the unset viewedAt records it.
  const claimed = await db.closerBrief.updateMany({
    where: { id: briefId, viewedAt: null },
    data: { viewedAt: new Date(), viewedById: user.id },
  })
  if (claimed.count === 0) return { ok: true, alreadyViewed: true }

  await recordAudit(user, {
    action: 'client.brief_viewed',
    entityType: 'CloserBrief',
    entityId: briefId,
    summary: `Closer Brief opened by ${user.name}`,
  })
  return { ok: true, alreadyViewed: false }
}
