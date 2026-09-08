import Link from 'next/link'
import { ArrowRight, BrainCircuit, Sparkles } from 'lucide-react'
import { can, type SessionUser } from '@/lib/rbac'
import { db } from '@/lib/db'
import { number, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { clampScore, kindChipClass } from '@/components/engine/engine-view'

/**
 * Compact dashboard surface of the Prodigy Engine — the top pending insights
 * plus a link to the /engine review desk. Follows the AttentionCard idiom:
 * self-gating (ai:review re-checked here, never trusted from the page) and
 * fully serialized before anything renders.
 */

const PREVIEW_LIMIT = 3

export async function InsightsCard({ user }: { user: SessionUser }) {
  // Re-check access here — this is a public-facing async component, never rely
  // on the page that renders it. Only ai:review holders see engine output.
  if (!can(user, 'ai:review')) return null

  const [rows, pendingCount] = await Promise.all([
    db.insight.findMany({
      where: { organizationId: user.organizationId, status: 'PENDING_REVIEW' },
      orderBy: [{ score: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: PREVIEW_LIMIT,
      select: { id: true, kind: true, title: true, score: true, createdAt: true },
    }),
    db.insight.count({
      where: { organizationId: user.organizationId, status: 'PENDING_REVIEW' },
    }),
  ])

  const top = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    score: clampScore(row.score),
    createdAgo: relativeTime(row.createdAt),
  }))
  const remaining = pendingCount - top.length

  return (
    <section className="bg-card rounded-lg border">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">Prodigy Engine</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            AI-proposed insights awaiting your review
          </p>
        </div>
        {pendingCount > 0 && (
          <span className="bg-primary/10 text-primary inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums">
            {number(pendingCount)}
          </span>
        )}
      </header>

      {top.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-5">
          <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full">
            <BrainCircuit className="size-4.5" />
          </span>
          <div>
            <p className="text-sm font-medium">Nothing waiting for review.</p>
            <p className="text-muted-foreground text-xs">
              The engine scans your book daily — new proposals land here for your verdict.
            </p>
          </div>
        </div>
      ) : (
        <ul className="divide-y">
          {top.map((insight) => (
            <li key={insight.id}>
              <Link
                href="/engine"
                className="hover:bg-muted/40 flex items-start gap-2.5 px-4 py-2.5 transition-colors"
              >
                <Sparkles className="text-primary mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{insight.title}</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    <span
                      className={cn(
                        'mr-1.5 inline-flex items-center rounded-full px-1.5 py-px text-[0.625rem] font-semibold tracking-wide uppercase',
                        kindChipClass(insight.kind),
                      )}
                    >
                      {insight.kind}
                    </span>
                    {insight.createdAgo}
                  </p>
                </div>
                {insight.score !== null && (
                  <span
                    className="text-muted-foreground shrink-0 text-xs font-medium tabular-nums"
                    title={`Priority score ${insight.score} of 100`}
                  >
                    {insight.score}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <footer className="border-t px-4 py-2.5">
        <Link
          href="/engine"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium transition-colors"
        >
          {remaining > 0 ? `Review all — ${number(remaining)} more` : 'Open the engine'}
          <ArrowRight className="size-3.5" />
        </Link>
      </footer>
    </section>
  )
}
