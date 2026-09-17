import { CheckCircle2, XCircle } from 'lucide-react'
import { db } from '@/lib/db'
import { can, requirePermissionPage } from '@/lib/rbac'
import { isAIConfigured } from '@/lib/ai'
import { INSIGHT_SCAN_KIND } from '@/lib/engine/insights'
import { hasActiveRun } from '@/lib/engine/runner'
import { humanize, number, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DeskChrome } from '@/components/desk/desk-chrome'
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
  title,
  description,
  count,
}: {
  title: string
  description: string
  count?: number
}) {
  return (
    <div className="desk-cal-head" style={{ padding: 0 }}>
      <div>
        <h2 className="font-heading" style={{ fontSize: 24 }}>
          {title}
        </h2>
        <p className="desk-muted" style={{ marginBottom: 0 }}>
          {description}
        </p>
      </div>
      {typeof count === 'number' && count > 0 && <span className="desk-muted">{number(count)}</span>}
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
    <DeskChrome
      title="Engine"
      description="The engine scans the book and proposes insights. A named human accepts or dismisses every one. No invented score."
      actions={canRun ? <RunNowButton activeRun={activeRun} /> : undefined}
    >
      <div className="desk-pills">
        <span className="desk-pill">
          <span
            aria-hidden
            className={cn(
              'size-1.5 rounded-full',
              activeRun
                ? 'bg-warning motion-safe:animate-pulse'
                : RUN_DOT[lastRun ? runTone(lastRun.status) : 'muted'],
            )}
          />
          {activeRun ? 'Scan in progress' : lastRun ? `Last run ${lastRun.startedAgo}` : 'No runs yet'}
        </span>
        <span className={`desk-pill${live ? ' on' : ''}`}>{live ? 'Live AI — Anthropic' : 'Mock provider'}</span>
        <span className="desk-pill">Scans daily</span>
        {pending.length > 0 && <span className="desk-pill">{number(pending.length)} awaiting review</span>}
      </div>

      <section className="desk-card desk-block">
        <SectionHeading
          title="Awaiting review"
          description="Highest-priority first — accept what you will act on, dismiss the rest."
          count={pending.length}
        />
        {pending.length === 0 ? (
          <p className="desk-empty">
            {runs.length === 0
              ? 'The engine has not run yet. Start a scan and proposals land here.'
              : 'Every proposal has been reviewed. The next scan may surface new ones.'}
          </p>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2" style={{ marginTop: 12 }}>
            {pending.map((insight) => (
              <InsightReviewCard key={insight.id} insight={insight} />
            ))}
          </div>
        )}
      </section>

      <section className="desk-card desk-block">
        <SectionHeading
          title="Review history"
          description="Your verdicts and, once measured, what actually moved."
          count={reviewed.length}
        />
        {reviewed.length === 0 ? (
          <p className="desk-empty">Accepted and dismissed insights appear here, with measured KPI outcomes.</p>
        ) : (
          <ul>
            {reviewed.map((item) => {
              const accepted = item.status === 'ACCEPTED'
              const StatusIcon = accepted ? CheckCircle2 : XCircle
              return (
                <li key={item.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--desk-line)' }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`desk-tag ${accepted ? 'ok' : ''}`}>
                      <StatusIcon className="size-3" />
                      {accepted ? 'Accepted' : 'Dismissed'}
                    </span>
                    <span className={cn('desk-tag', kindChipClass(item.kind))}>{item.kind}</span>
                    <span className="desk-muted" style={{ marginLeft: 'auto', marginBottom: 0 }}>
                      {item.reviewer ?? 'Unknown reviewer'}
                      {item.reviewedAgo ? ` · ${item.reviewedAgo}` : ''}
                    </span>
                  </div>
                  <p style={{ marginTop: 6, fontWeight: 600 }}>{item.title}</p>
                  {item.note && (
                    <p className="desk-muted">
                      &ldquo;{item.note}&rdquo;
                    </p>
                  )}
                  {item.outcome && (
                    <div className="desk-pills" style={{ marginTop: 8, marginBottom: 0 }}>
                      <span className="desk-muted" style={{ marginBottom: 0 }}>
                        Measured outcome
                      </span>
                      {item.outcome.deltas.length === 0 ? (
                        <span className="desk-muted" style={{ marginBottom: 0 }}>
                          no KPI movement yet
                        </span>
                      ) : (
                        item.outcome.deltas.map((d) => (
                          <span
                            key={d.key}
                            title={`${humanize(d.key)}: ${d.before} to ${d.after}`}
                            className="desk-pill"
                          >
                            {humanize(d.key)} {formatChange(d.change)}
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

      <section className="desk-card desk-block">
        <SectionHeading
          title="Run history"
          description="Every engine run and its collect, retrieve, analyze, persist, measure pipeline."
          count={runs.length}
        />
        {runs.length === 0 ? (
          <p className="desk-empty">
            {canRun
              ? 'Press Run now to start the first insight scan, or wait for the daily schedule.'
              : 'The daily schedule will start the first insight scan automatically.'}
          </p>
        ) : (
          <div className="scroll-x" style={{ marginTop: 12 }}>
            <table className="desk-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Steps</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{run.startedAgo}</td>
                    <td>{humanize(run.kind)}</td>
                    <td>
                      <span className={cn('desk-tag', RUN_PILL[runTone(run.status)])}>{run.status.toLowerCase()}</span>
                      {run.error && (
                        <div className="desk-muted" style={{ marginBottom: 0 }} title={run.error}>
                          {run.error}
                        </div>
                      )}
                    </td>
                    <td>
                      <StepTracker steps={run.steps} />
                    </td>
                    <td>{run.duration ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </DeskChrome>
  )
}
