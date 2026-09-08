import Link from 'next/link'
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Info,
  Sparkles,
} from 'lucide-react'
import { getHygieneReport, type HygieneCheckResult, type HygieneGrade } from '@/lib/hygiene'
import { SALES_LEVEL_LABEL, requireSalesAccess } from '@/lib/coaching'
import { can } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { Badge } from '@/components/ui/badge'
import { number, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SalesNav } from '../ui'

export const metadata = { title: 'Data health' }

// SalesNav's `current` union gains 'hygiene' when the orchestrator wires the tab;
// widen here so this slice typechecks standalone in the meantime.

const GRADE_TEXT: Record<HygieneGrade, string> = {
  clean: 'text-success',
  good: 'text-success',
  fair: 'text-warning',
  poor: 'text-danger',
}

const GRADE_VERDICT: Record<HygieneGrade, string> = {
  clean: 'Spotless — the book is clean.',
  good: 'Healthy, with a few things to tidy.',
  fair: 'Some drift — worth an hour today.',
  poor: 'Needs attention before it costs deals.',
}

const SEVERITY_META = {
  critical: {
    Icon: AlertCircle,
    ring: 'ring-danger/30',
    accent: 'text-danger',
    badge: 'bg-danger/10 text-danger',
    label: 'Critical',
  },
  warning: {
    Icon: AlertTriangle,
    ring: 'ring-warning/30',
    accent: 'text-warning',
    badge: 'bg-warning/10 text-warning',
    label: 'Warning',
  },
  info: {
    Icon: Info,
    ring: 'ring-border',
    accent: 'text-primary',
    badge: 'bg-primary/10 text-primary',
    label: 'Watch',
  },
} as const

function ScoreRing({ score, grade }: { score: number; grade: HygieneGrade }) {
  const r = 52
  const c = 2 * Math.PI * r
  const offset = c * (1 - Math.max(0, Math.min(100, score)) / 100)
  return (
    <div className={cn('relative size-32 shrink-0', GRADE_TEXT[grade])}>
      <svg viewBox="0 0 120 120" className="size-full -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="10" className="stroke-muted" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-semibold tracking-tight tabular-nums">{score}</span>
        <span className="text-muted-foreground text-[0.625rem] font-semibold tracking-[0.08em] uppercase">
          / 100
        </span>
      </div>
    </div>
  )
}

function CheckCard({ check }: { check: HygieneCheckResult }) {
  const clean = check.count === 0
  const meta = SEVERITY_META[check.severity]
  const Icon = clean ? CheckCircle2 : meta.Icon

  return (
    <div className={cn('bg-card rounded-xl border p-4 shadow-e1 ring-1', clean ? 'ring-success/20' : meta.ring)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Icon className={cn('mt-0.5 size-4 shrink-0', clean ? 'text-success' : meta.accent)} />
          <div>
            <h3 className="text-sm font-semibold">{check.label}</h3>
            <p className="text-muted-foreground mt-0.5 text-xs">{check.description}</p>
          </div>
        </div>
        {clean ? (
          <span className="bg-success/10 text-success inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium">
            <CheckCircle2 className="size-3" /> Clean
          </span>
        ) : (
          <span
            className={cn(
              'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm font-semibold tabular-nums',
              meta.badge,
            )}
          >
            {number(check.count)}
          </span>
        )}
      </div>

      {!clean && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {check.sampleClients.map((s) => (
              <Link
                key={s.id}
                href={`/clients/${s.id}`}
                className="bg-surface-sunk hover:bg-muted inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
              >
                <span className="font-medium">{s.name}</span>
                <span className="text-muted-foreground">· {s.stage}</span>
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {check.count > check.sampleClients.length && (
              <span className="text-muted-foreground text-xs tabular-nums">
                +{number(check.count - check.sampleClients.length)} more
              </span>
            )}
            {check.href && (
              <Link
                href={check.href}
                className="text-primary inline-flex items-center gap-1 text-xs font-medium hover:underline"
              >
                View in Clients <ArrowRight className="size-3" />
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default async function DataHealthPage() {
  const { user, level } = await requireSalesAccess()
  const canQualify = can(user, 'qualification:review')
  const report = await getHygieneReport(user)
  const allClear = report.totalIssues === 0
  const cleanChecks = report.checks.filter((c) => c.count === 0).length

  return (
    <>
      <PageHeader
        title="Data health"
        description={`Daily data-cleanliness check over the ${SALES_LEVEL_LABEL[level]} — Phase 1's "clean data hygiene" gate`}
        actions={
          <Badge variant="outline" className="tabular-nums">
            Updated {relativeTime(report.generatedAt)}
          </Badge>
        }
      >
        <SalesNav current="hygiene" canQualify={canQualify} />
      </PageHeader>

      <div className="space-y-4 p-4 sm:p-6">
        {/* Headline: score ring + verdict */}
        <div className="bg-card shadow-e1 flex flex-col items-center gap-5 rounded-xl border p-5 sm:flex-row sm:p-6">
          <ScoreRing score={report.score} grade={report.grade} />
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <p className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
              Hygiene score
            </p>
            <p className={cn('mt-1 text-lg font-semibold', GRADE_TEXT[report.grade])}>
              {GRADE_VERDICT[report.grade]}
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {allClear ? (
                <>
                  All {report.checks.length} checks pass across {number(report.liveCount)} live{' '}
                  {report.liveCount === 1 ? 'client' : 'clients'}.
                </>
              ) : (
                <>
                  {number(cleanChecks)} of {report.checks.length} checks clean ·{' '}
                  {number(report.totalIssues)} {report.totalIssues === 1 ? 'record' : 'records'} flagged
                  across {number(report.liveCount)} live{' '}
                  {report.liveCount === 1 ? 'client' : 'clients'}.
                </>
              )}
            </p>
          </div>
        </div>

        {allClear && (
          <div className="border-success/30 bg-success/5 flex items-center gap-3 rounded-xl border p-4">
            <span className="bg-success/15 text-success flex size-10 shrink-0 items-center justify-center rounded-full">
              <Sparkles className="size-5" />
            </span>
            <div>
              <p className="text-success text-sm font-semibold">Clean book — nothing to fix.</p>
              <p className="text-muted-foreground text-sm">
                Every hygiene check is passing. Keep the daily rhythm and the Phase 1 data gate stays green.
              </p>
            </div>
          </div>
        )}

        <StatGrid>
          <StatTile label="Hygiene score" value={`${report.score}`} hint="0–100, higher is cleaner" />
          <StatTile
            label="Records flagged"
            value={number(report.totalIssues)}
            hint={allClear ? 'Nothing needs attention' : 'May span more than one check'}
          />
          <StatTile
            label="Checks clean"
            value={`${cleanChecks}/${report.checks.length}`}
            hint="Passing hygiene checks"
          />
          <StatTile
            label="Live clients"
            value={number(report.liveCount)}
            hint="Active, non-terminal — the book"
          />
        </StatGrid>

        {/* Checklist */}
        <div className="grid gap-3 lg:grid-cols-2">
          {report.checks.map((check) => (
            <CheckCard key={check.key} check={check} />
          ))}
        </div>
      </div>
    </>
  )
}
