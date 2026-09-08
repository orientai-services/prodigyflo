import 'server-only'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { can, type SessionUser } from '@/lib/rbac'
import { loadActor } from '@/lib/automation/actor'
import { getAIProvider } from '@/lib/ai'
import type {
  GenerateInsightsResult,
  InsightCitation,
  InsightProposal,
  PriorInsightFeedback,
} from '@/lib/ai/provider'
import { getMetrics, type CoreMetrics } from '@/lib/analytics'
import { getMarketingOverview, marketingRange } from '@/lib/marketing-metrics'
import { retrieveContext, type RetrievalSnippet, type RetrievalStat } from '@/lib/ai/retrieval'
import { defineDag, type DagStepContext } from './dag'
import { hasActiveRun, startRun } from './runner'
import { dedupeInsightProposals, kpiDelta } from './insight-rules'

/**
 * The 'insight_scan' DAG: collect KPIs → retrieve cited evidence (including
 * prior reviewed insights — the learning loop) → analyze with the AI provider
 * → persist deduplicated PENDING_REVIEW insights → measure outcomes of
 * insights accepted long enough ago to have landed.
 *
 * Every step runs under a named acting user (an org admin resolved at
 * schedule time, or the human who pressed Run now), so retrieval scope and
 * the ai:run permission are enforced identically to a manual AI call. The
 * model only ever produces PENDING_REVIEW rows — a named human accepts or
 * dismisses each one via the actions in `actions.ts`.
 */

export const INSIGHT_SCAN_KIND = 'insight_scan'

/** At most one scheduled scan per org per 24 hours. */
const SCAN_INTERVAL_MS = 24 * 3_600_000
/** An accepted insight gets this long to land before its outcome is measured. */
const MEASURE_AFTER_MS = 7 * 86_400_000
const RETRIEVAL_QUERY =
  'pipeline close rate stalled follow up lead cost spend qualification document consent risk'

type ScanInput = { actorUserId?: string }
type CollectOutput = { core: CoreMetrics; marketing: Record<string, number | null> }
type RetrieveOutput = { snippets: RetrievalSnippet[]; stats: RetrievalStat[] }
type AnalyzeOutput = { provider: string; model: string | null; insights: InsightProposal[] }

/**
 * Resolves the acting user stored in the run input. Loaded fresh every step,
 * so a deactivated account or a revoked ai:run permission stops the scan at
 * the next step instead of being trusted from schedule time.
 */
async function resolveActor(ctx: DagStepContext): Promise<SessionUser> {
  const actorUserId = (ctx.input as ScanInput | null)?.actorUserId
  const actor = await loadActor(actorUserId)
  if (!actor || actor.organizationId !== ctx.organizationId) {
    throw new Error('The acting user for this run is no longer active.')
  }
  if (!can(actor, 'ai:run')) {
    throw new Error('The acting user no longer holds the ai:run permission.')
  }
  return actor
}

/** System-actor audit row, same shape as digest.ts / freshenScores. */
async function recordEngineAudit(
  organizationId: string,
  action: string,
  entityId: string,
  summary: string,
): Promise<void> {
  await db.auditEvent.create({
    data: {
      organizationId,
      actorLabel: 'Prodigy Engine',
      action,
      entityType: 'EngineRun',
      entityId,
      summary,
    },
  })
}

defineDag({
  kind: INSIGHT_SCAN_KIND,
  steps: [
    {
      key: 'collect',
      async run(ctx) {
        const actor = await resolveActor(ctx)
        const [core, overview] = await Promise.all([
          getMetrics(actor),
          getMarketingOverview(actor, marketingRange('30')),
        ])
        const output: CollectOutput = {
          core,
          marketing: {
            leads30d: overview.totals.leads,
            leadsDeltaPct: overview.totals.leadsDeltaPct,
            unattributed: overview.totals.unattributed,
            spend: overview.ads.spend,
            clicks: overview.ads.clicks,
            costPerLead: overview.ads.costPerLead,
            costPerQualified: overview.ads.costPerQualified,
          },
        }
        return output
      },
    },
    {
      key: 'retrieve',
      dependsOn: ['collect'],
      async run(ctx) {
        const actor = await resolveActor(ctx)
        // pastInsights rides along here: ACCEPTED/DISMISSED rows with review
        // notes and outcomes, so generation sees what the org adopted.
        const result = await retrieveContext(actor, RETRIEVAL_QUERY, { perRetrieverLimit: 6 })
        return result satisfies RetrieveOutput
      },
    },
    {
      key: 'analyze',
      dependsOn: ['retrieve'],
      async run(ctx) {
        await resolveActor(ctx) // permission re-check before spending model tokens
        const kpis = ctx.outputs.collect as CollectOutput
        const { snippets } = ctx.outputs.retrieve as RetrieveOutput

        const prior = await db.insight.findMany({
          where: { organizationId: ctx.organizationId, status: { in: ['ACCEPTED', 'DISMISSED'] } },
          orderBy: [{ reviewedAt: 'desc' }, { createdAt: 'desc' }],
          take: 25,
          select: { kind: true, title: true, status: true, reviewNote: true, outcome: true },
        })
        const priorFeedback: PriorInsightFeedback[] = prior.map((p) => ({
          kind: p.kind,
          title: p.title,
          status: p.status as 'ACCEPTED' | 'DISMISSED',
          reviewNote: p.reviewNote,
          outcome: p.outcome,
        }))

        // The model call happens here — the runner executes step bodies
        // outside every transaction, so this can be slow without harm.
        const provider = getAIProvider()
        const result: GenerateInsightsResult = await provider.generateInsights({
          kpis: kpis as unknown as Record<string, unknown>,
          snippets,
          priorFeedback,
        })
        const output: AnalyzeOutput = {
          provider: provider.name,
          model: provider.model,
          insights: result.insights,
        }
        return output
      },
    },
    {
      key: 'persist',
      dependsOn: ['analyze'],
      async run(ctx) {
        const { insights, provider } = ctx.outputs.analyze as AnalyzeOutput
        const { snippets } = ctx.outputs.retrieve as RetrieveOutput

        const open = await db.insight.findMany({
          where: { organizationId: ctx.organizationId, status: 'PENDING_REVIEW' },
          select: { kind: true, title: true },
        })
        const fresh = dedupeInsightProposals(insights, open)

        if (fresh.length > 0) {
          await db.insight.createMany({
            data: fresh.map((p) => ({
              organizationId: ctx.organizationId,
              runId: ctx.runId,
              kind: p.kind,
              title: p.title.slice(0, 200),
              body: p.body,
              // Every insight carries citations — when a proposal arrived
              // without any, the retrieval snippets stand in as its evidence.
              evidence: (p.evidence.length > 0
                ? p.evidence
                : (snippets.slice(0, 3) as InsightCitation[])) as unknown as Prisma.InputJsonValue,
              score: Math.round(p.score),
              status: 'PENDING_REVIEW',
            })),
          })
        }
        await recordEngineAudit(
          ctx.organizationId,
          'engine.insights_persisted',
          ctx.runId,
          `Insight scan (${provider}) persisted ${fresh.length} insight${fresh.length === 1 ? '' : 's'} for review; ${insights.length - fresh.length} deduplicated against open ones`,
        )
        return { created: fresh.length, deduped: insights.length - fresh.length }
      },
    },
    {
      key: 'measure',
      dependsOn: ['persist'],
      async run(ctx) {
        const actor = await resolveActor(ctx)
        const due = await db.insight.findMany({
          where: {
            organizationId: ctx.organizationId,
            status: 'ACCEPTED',
            outcome: { equals: Prisma.AnyNull },
            reviewedAt: { lt: new Date(Date.now() - MEASURE_AFTER_MS) },
          },
          orderBy: { reviewedAt: 'asc' },
          take: 20,
          select: { id: true, runId: true, title: true },
        })
        if (due.length === 0) return { measured: 0 }

        const current = await getMetrics(actor)
        let measured = 0
        for (const insight of due) {
          // Baseline = the KPI snapshot the insight's own run collected, so
          // the delta measures what changed since the insight was proposed.
          let baseline: Record<string, unknown> | null = null
          if (insight.runId) {
            const collect = await db.engineStep.findFirst({
              where: { runId: insight.runId, key: 'collect', status: 'COMPLETED' },
              select: { output: true },
            })
            const core = (collect?.output as { core?: Record<string, unknown> } | null)?.core
            if (core && typeof core === 'object') baseline = core
          }
          const outcome = {
            measuredAt: new Date().toISOString(),
            baselineAvailable: baseline !== null,
            delta: baseline ? kpiDelta(baseline, current as unknown as Record<string, unknown>) : null,
          }
          await db.insight.update({
            where: { id: insight.id },
            data: { outcome: outcome as Prisma.InputJsonValue },
          })
          measured += 1
        }
        await recordEngineAudit(
          ctx.organizationId,
          'engine.outcomes_measured',
          ctx.runId,
          `Measured KPI outcomes for ${measured} accepted insight${measured === 1 ? '' : 's'}`,
        )
        return { measured }
      },
    },
  ],
})

// ─── Scheduling ──────────────────────────────────────────────────────────────

export type ScheduleResult = { started: number; skipped: number }

/**
 * Jobs-tick guard: starts at most one insight_scan per org per 24 hours,
 * checked from the latest EngineRun of that kind (any status counts — a
 * failed run does not retrigger until the window passes, and a run still in
 * flight always blocks a new one). The org must have an active admin holding
 * ai:run to act for; orgs without one are skipped.
 */
export async function scheduleInsightScan(now: Date = new Date()): Promise<ScheduleResult> {
  const result: ScheduleResult = { started: 0, skipped: 0 }

  const admins = await db.user.findMany({
    where: { isActive: true, deletedAt: null, role: { key: { in: ['ADMIN', 'SUPER_ADMIN'] } } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, organizationId: true },
  })
  const perOrg = new Map<string, string>()
  for (const a of admins) if (!perOrg.has(a.organizationId)) perOrg.set(a.organizationId, a.id)

  for (const [organizationId, userId] of perOrg) {
    try {
      const latest = await db.engineRun.findFirst({
        where: { organizationId, kind: INSIGHT_SCAN_KIND },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, status: true },
      })
      const withinWindow =
        latest !== null && now.getTime() - latest.createdAt.getTime() < SCAN_INTERVAL_MS
      const stillRunning = latest !== null && (latest.status === 'PENDING' || latest.status === 'RUNNING')
      if (withinWindow || stillRunning) {
        result.skipped += 1
        continue
      }

      const actor = await loadActor(userId)
      if (!actor || !can(actor, 'ai:run')) {
        result.skipped += 1
        continue
      }

      const run = await startRun(organizationId, INSIGHT_SCAN_KIND, { actorUserId: actor.id })
      await recordEngineAudit(
        organizationId,
        'engine.run_scheduled',
        run.id,
        'Scheduled daily insight scan',
      )
      result.started += 1
    } catch {
      // one org failing must not stall the runner
      result.skipped += 1
    }
  }
  return result
}

export type StartScanResult = { ok: true; runId: string } | { ok: false; error: string }

/**
 * Manual start (the /engine "Run now" button). Bypasses the 24h window — a
 * human asked — but never stacks on a run that is still in flight. The caller
 * must already be permission-gated (ai:run); the pressing user becomes the
 * run's acting user, so the scan sees exactly their scope.
 */
export async function startInsightScan(user: SessionUser): Promise<StartScanResult> {
  if (!can(user, 'ai:run')) {
    return { ok: false, error: 'You do not have permission to run AI analysis.' }
  }
  if (await hasActiveRun(user.organizationId, INSIGHT_SCAN_KIND)) {
    return { ok: false, error: 'An insight scan is already running for your organization.' }
  }
  const run = await startRun(user.organizationId, INSIGHT_SCAN_KIND, { actorUserId: user.id })
  return { ok: true, runId: run.id }
}
