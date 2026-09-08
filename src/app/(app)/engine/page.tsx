import { CheckCircle2, History, ListChecks, Sparkles, XCircle } from 'lucide-react'
import { db } from '@/lib/db'
import { can, requirePermissionPage } from '@/lib/rbac'
import { isAIConfigured } from '@/lib/ai'
import { INSIGHT_SCAN_KIND } from '@/lib/engine/insights'
import { hasActiveRun } from '@/lib/engine/runner'
import { humanize, number, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  clampScore,
  formatChange,
  kindChipClass,
  parseCitations,
  parseOutcome,
  runDuration,
  runTone,
  type OutcomeView,
  type StatusTone,
  type StepView,
} from '@/components/engine/engine-view'
import { StepTracker } from '@/components/engine/step-tracker'
import { RunNowButton } from '@/components/engine/run-now-button'
import {
  InsightReviewCard,
  type PendingInsightView,
} from '@/components/engine/insight-review-card'

export const metadata = { title: 'Prodigy Engine' }

/**
 * The Prodigy Engine review desk. The engine proposes; a named human decides —
 * this page is where that happens: score-sorted insights to accept or dismiss,
 * the review trail with measured outcomes, and every engine run with its
 * step-by-step pipeline state. All rows serialize to plain view shapes before
 * they cross the RSC boundary.
 */

type ReviewedView = {
  id: string
  kind: string
  title: string
  status: 'ACCEPTED' | 'DISMISSED'
  reviewer: string | null
  reviewedAgo: string | null
  note: string | null
  outcome: OutcomeView | null
}

type RunView = {
  id: string
  kind: string
  status: string
  startedAgo: string
  duration: string | null
  error: string | null
  steps: StepView[]
}

const RUN_PILL: Record<StatusTone, string> = {
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  muted: 'bg-muted text-muted-foreground',
}

const RUN_DOT: Record<StatusTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-muted-foreground/40',
}

function SectionHeading({
  icon: Icon,
  title,
  description,
  count,
}: {
  icon: typeof Sparkles
  title: string
  description: string
  count?: number
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <h2 className="text-sm font-semibold">{title}</h2>
      {typeof count === 'number' && count > 0 && (
        <span className="bg-muted text-foreground inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums">
          {number(count)}
        </span>
      )}
      <p className="text-muted-foreground w-full text-xs sm:w-auto">{description}</p>
    </div>
  )
}

export default async function EnginePage() {
  const user = await requirePermissionPage('ai:review')
  const canRun = can(user, 'ai:run')

  const [pendingRows, reviewedRows, runRows, activeRun] = await Promise.all([
    db.insight.findMany({
      where: { organizationId: user.organizationId, status: 'PENDING_REVIEW' },
      orderBy: [{ score: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 100,
    }),
    db.insight.findMany({
      where: { organizationId: user.organizationId, status: { in: ['ACCEPTED', 'DISMISSED'] } },
      orderBy: [{ reviewedAt: 'desc' }, { createdAt: 'desc' }],
      take: 25,
      include: { reviewedBy: { select: { name: true } } },
    }),
    db.engineRun.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        steps: { select: { key: true, status: true, attempts: true, error: true } },
      },
    }),
    hasActiveRun(user.organizationId, INSIGHT_SCAN_KIND),
  ])

  const pending: PendingInsightView[] = pendingRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    score: clampScore(row.score),
    createdAgo: relativeTime(row.createdAt),
    citations: parseCitations(row.evidence),
  }))

  const reviewed: ReviewedView[] = reviewedRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status === 'ACCEPTED' ? 'ACCEPTED' : 'DISMISSED',
    reviewer: row.reviewedBy?.name ?? null,
    reviewedAgo: row.reviewedAt ? relativeTime(row.reviewedAt) : null,
    note: row.reviewNote,
    outcome: parseOutcome(row.outcome),
  }))

  const runs: RunView[] = runRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    startedAgo: relativeTime(row.startedAt ?? row.createdAt),
    duration: runDuration(
      row.startedAt?.toISOString() ?? null,
      row.finishedAt?.toISOString() ?? null,
    ),
    error: row.error,
    steps: row.steps.map((s) => ({
      key: s.key,
      status: s.status as StepView['status'],
      attempts: s.attempts,
      error: s.error,
    })),
  }))

  const lastRun = runs[0]
  const live = isAIConfigured()

  return (
    <>
      <PageHeader
        title="Prodigy Engine"
        description="The engine scans your book, retrieves cited evidence and proposes insights — a named human accepts or dismisses every one."
        actions={canRun ? <RunNowButton activeRun={activeRun} /> : undefined}
      >
        {/* Status strip: run recency, provider mode and cadence at a glance. */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="bg-card inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1">
            <span
              aria-hidden
              className={cn(
                'size-1.5 rounded-full',
                activeRun
                  ? 'bg-warning motion-safe:animate-pulse'
                  : RUN_DOT[lastRun ? runTone(lastRun.status) : 'muted'],
              )}
            />
            {activeRun
              ? 'Scan in progress'
              : lastRun
                ? `Last run ${lastRun.startedAgo}`
                : 'No runs yet'}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium',
              live
                ? 'border-success/30 bg-success/5 text-success'
                : 'border-warning/30 bg-warning/5 text-warning',
            )}
          >
            {live ? 'Live AI — Anthropic' : 'Mock provider'}
          </span>
          <span className="bg-card text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1">
            Scans daily, automatically
          </span>
          {pending.length > 0 && (
            <span className="bg-primary/10 text-primary inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium tabular-nums">
              {number(pending.length)} awaiting review
            </span>
          )}
        </div>
      </PageHeader>

      <div className="space-y-4 p-4 sm:p-6">
        {/* Awaiting review */}
        <section className="space-y-3">
          <SectionHeading
            icon={Sparkles}
            title="Awaiting review"
            description="Highest-priority first — accept what you will act on, dismiss the rest."
            count={pending.length}
          />
          {pending.length === 0 ? (
            <div className="bg-card rounded-xl border">
              <EmptyState
                icon="Sparkles"
                title="No insights waiting for review"
                description={
                  runs.length === 0
                    ? 'The engine has not run yet. Start a scan and proposals will land here for your verdict.'
                    : 'Every proposal has been reviewed. The next scan may surface new ones.'
                }
              />
            </div>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {pending.map((insight) => (
                <InsightReviewCard key={insight.id} insight={insight} />
              ))}
            </div>
          )}
        </section>

        {/* Review history */}
        <section className="space-y-3">
          <SectionHeading
            icon={ListChecks}
            title="Review history"
            description="Your verdicts and, once measured, what actually moved."
            count={reviewed.length}
          />
          {reviewed.length === 0 ? (
            <div className="bg-card rounded-xl border">
              <EmptyState
                icon="ListChecks"
                title="No reviews yet"
                description="Accepted and dismissed insights appear here, with their measured KPI outcomes."
              />
            </div>
          ) : (
            <ul className="bg-card divide-y rounded-xl border">
              {reviewed.map((item) => {
                const accepted = item.status === 'ACCEPTED'
                const StatusIcon = accepted ? CheckCircle2 : XCircle
                return (
                  <li key={item.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'inline-flex h-5 items-center gap-1 rounded-full px-2 text-[0.625rem] font-semibold tracking-wide uppercase',
                          accepted ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
                        )}
                      >
                        <StatusIcon className="size-3" />
                        {accepted ? 'Accepted' : 'Dismissed'}
                      </span>
                      <span
                        className={cn(
                          'inline-flex h-5 items-center rounded-full px-2 text-[0.625rem] font-semibold tracking-wide uppercase',
                          kindChipClass(item.kind),
                        )}
                      >
                        {item.kind}
                      </span>
                      <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                        {item.reviewer ?? 'Unknown reviewer'}
                        {item.reviewedAgo ? ` · ${item.reviewedAgo}` : ''}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm font-medium">{item.title}</p>
                    {item.note && (
                      <p className="text-muted-foreground mt-1 text-xs italic">
                        &ldquo;{item.note}&rdquo;
                      </p>
                    )}
                    {item.outcome && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="text-muted-foreground text-[0.625rem] font-semibold tracking-wide uppercase">
                          Measured outcome
                        </span>
                        {item.outcome.deltas.length === 0 ? (
                          <span className="text-muted-foreground text-xs">no KPI movement yet</span>
                        ) : (
                          item.outcome.deltas.map((d) => (
                            <span
                              key={d.key}
                              title={`${humanize(d.key)}: ${d.before} to ${d.after}`}
                              className="bg-muted text-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs tabular-nums"
                            >
                              {humanize(d.key)}
                              <span
                                className={cn(
                                  'font-semibold',
                                  d.change > 0
                                    ? 'text-success'
                                    : d.change < 0
                                      ? 'text-danger'
                                      : 'text-muted-foreground',
                                )}
                              >
                                {formatChange(d.change)}
                              </span>
                            </span>
                          ))
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* Run history */}
        <section className="space-y-3">
          <SectionHeading
            icon={History}
            title="Run history"
            description="Every engine run and its collect, retrieve, analyze, persist, measure pipeline."
            count={runs.length}
          />
          {runs.length === 0 ? (
            <div className="bg-card rounded-xl border">
              <EmptyState
                icon="History"
                title="No engine runs yet"
                description={
                  canRun
                    ? 'Press Run now to start the first insight scan, or wait for the daily schedule.'
                    : 'The daily schedule will start the first insight scan automatically.'
                }
              />
            </div>
          ) : (
            <div className="bg-card overflow-hidden rounded-xl border">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Started</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Steps</TableHead>
                      <TableHead className="text-right">Duration</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell className="text-muted-foreground whitespace-nowrap">
                          {run.startedAgo}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{humanize(run.kind)}</TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              'inline-flex h-5 items-center rounded-full px-2 text-[0.625rem] font-semibold tracking-wide uppercase',
                              RUN_PILL[runTone(run.status)],
                            )}
                          >
                            {run.status.toLowerCase()}
                          </span>
                          {run.error && (
                            <p
                              className="text-danger mt-1 max-w-52 truncate text-xs"
                              title={run.error}
                            >
                              {run.error}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <StepTracker steps={run.steps} />
                        </TableCell>
                        <TableCell className="text-muted-foreground text-right tabular-nums whitespace-nowrap">
                          {run.duration ?? '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  )
}
