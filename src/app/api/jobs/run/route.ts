import type { NextRequest } from 'next/server'
import { cronAuthorized } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { runDueWork } from '@/lib/automation/engine'
import { loadActor } from '@/lib/automation/actor'
import { clientScope } from '@/lib/rbac'
import { getAIProvider } from '@/lib/ai'
import { buildAssistContext } from '@/lib/ai/assists'
import { sendWeeklyDigests } from '@/lib/digest'
import { tickEngine } from '@/lib/engine/runner'
import { scheduleInsightScan } from '@/lib/engine/insights'
import { renewNumbers } from '@/lib/telephony/renewal'
import { runPendingScsDocumentExtractions, runPendingScsDocumentImports } from '@/lib/intake/scs-document-import'

export const maxDuration = 300

/** Per-org clients rescored per run — only matters while a backlog drains. */
const SCORE_BATCH_PER_ORG = 15

/**
 * Keeps AI close-probability scores fresh: for each org, use one of its active
 * admins for SCOPING only and rescore clients that are unscored or >7 days
 * stale. The stale cutoff is the rate limiter — steady state finds zero
 * candidates, so the per-run cap only matters while a backlog drains.
 *
 * Deliberately NOT scoreUnscoredClients()/rescoreClient(): those audit as the
 * acting human, and a timer-driven rescore attributed to an admin who never
 * acted is a false audit record. The candidate query mirrors
 * scoreUnscoredClients (closeops-ai.ts) exactly; the audit is written directly
 * with a system actorLabel and no actorId, same shape as digest.ts.
 */
async function freshenScores(): Promise<{ scored: number; skipped: number; candidates: number }> {
  const totals = { scored: 0, skipped: 0, candidates: 0 }
  const admins = await db.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      role: { key: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, organizationId: true },
  })
  const perOrg = new Map<string, string>()
  for (const a of admins) if (!perOrg.has(a.organizationId)) perOrg.set(a.organizationId, a.id)
  for (const userId of perOrg.values()) {
    try {
      const actor = await loadActor(userId)
      if (!actor || !actor.permissions.has('ai:run')) continue

      const staleCutoff = new Date(Date.now() - 7 * 86_400_000)
      const rows = await db.client.findMany({
        where: {
          ...clientScope(actor),
          status: 'ACTIVE',
          currentStage: { isTerminal: false },
          OR: [
            { aiCloseProbability: null },
            { aiCloseProbabilityAt: null },
            { aiCloseProbabilityAt: { lt: staleCutoff } },
          ],
        },
        orderBy: { lastActivityAt: 'desc' },
        take: SCORE_BATCH_PER_ORG,
        select: { id: true },
      })
      totals.candidates += rows.length

      const provider = getAIProvider()
      for (const row of rows) {
        try {
          const context = await buildAssistContext(actor, row.id)
          if (!context) {
            totals.skipped += 1
            continue
          }
          const result = await provider.scoreCloseProbability(context)
          await db.client.update({
            where: { id: row.id },
            data: { aiCloseProbability: result.probability, aiCloseProbabilityAt: new Date() },
          })
          // System job — no session actor; mirror digest.ts's audit shape.
          await db.auditEvent.create({
            data: {
              organizationId: actor.organizationId,
              actorLabel: 'Scheduled AI scoring',
              action: 'client.ai_scored',
              entityType: 'Client',
              entityId: row.id,
              summary: `AI close probability ${result.probability}% (${result.confidence} confidence, ${provider.name}) for ${context.client.firstName} ${context.client.lastName}`,
            },
          })
          totals.scored += 1
        } catch {
          totals.skipped += 1
        }
      }
    } catch {
      // one org failing must not stall the runner
    }
  }
  return totals
}

/**
 * Job-runner endpoint. Hit by Vercel Cron (`vercel.json`) or the droplet
 * systemd timer (deploy/jobs.timer) every five minutes. Accepts Bearer
 * CRON_SECRET or JOBS_TOKEN; refuses everything when neither is set.
 */
async function run(request: NextRequest) {
  if (!cronAuthorized(request, [process.env.JOBS_TOKEN])) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const startedAt = Date.now()
  const counts = await runDueWork(new Date())
  const scores = await freshenScores()
  // Monday-morning manager digest — the settings.digest.lastSentWeek guard
  // inside makes the 5-minute cadence deliver exactly once per org per week.
  const digest = await sendWeeklyDigests(new Date())
  // Prodigy Engine: schedule at most one insight scan per org per 24h (guarded
  // by the latest EngineRun's age), then advance a bounded batch of READY DAG
  // steps. Steps are claimed atomically (updateMany on READY), mirroring the
  // batch idiom of the sections above, so overlapping ticks never double-run.
  const engineScheduled = await scheduleInsightScan(new Date())
  const engineTick = await tickEngine(new Date())
  const engine = { ...engineScheduled, ...engineTick }
  // Monthly rent on every phone line. Self-limiting: a number is only picked up
  // once its nextRenewalAt has passed, so the 5-minute cadence charges once a
  // month per line. A wallet that cannot cover it suspends the line (never
  // releases it) and tells the account's admins.
  const telephony = await renewNumbers(new Date())
  const scsDocumentExtractions = await runPendingScsDocumentExtractions()
  const scsDocumentImports = await runPendingScsDocumentImports()
  return Response.json({ ok: true, tookMs: Date.now() - startedAt, ...counts, scores, digest, engine, telephony, scsDocumentImports, scsDocumentExtractions })
}

export const POST = run
export const GET = run
