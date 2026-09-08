import Link from 'next/link'
import { Eye, FileText, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { briefStatus, probabilityTier } from '@/lib/coaching'
import type { PhaseCheck } from '@/lib/closeops'

/** Sub-navigation shared by every /sales page. */
export function SalesNav({
  current,
  canQualify = false,
}: {
  current: 'overview' | 'huddle' | 'hot-leads' | 'qualifier' | 'nurture' | 'ops' | 'coaching' | 'accuracy' | 'hygiene'
  /** Pass `can(user, 'qualification:review')` — the Qualifier tab 403s without it. */
  canQualify?: boolean
}) {
  const TABS = [
    { key: 'overview', href: '/sales', label: 'Overview' },
    { key: 'huddle', href: '/sales/huddle', label: 'Daily huddle' },
    { key: 'hot-leads', href: '/sales/hot-leads', label: 'Hot leads' },
    { key: 'qualifier', href: '/sales/qualifier', label: 'Qualifier' },
    { key: 'nurture', href: '/sales/nurture', label: 'Pre-call nurture' },
    { key: 'ops', href: '/sales/ops', label: 'Close-rate ops' },
    { key: 'coaching', href: '/sales/coaching', label: 'Coaching & QA' },
    { key: 'accuracy', href: '/sales/accuracy', label: 'AI accuracy' },
    { key: 'hygiene', href: '/sales/hygiene', label: 'Data health' },
  ] as const
  const tabs = TABS.filter((t) => t.key !== 'qualifier' || canQualify)
  return (
    <div className="bg-surface-sunk mt-4 flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border p-0.5">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors',
            current === t.key
              ? 'bg-surface-raised shadow-e1'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  )
}

const TIER_CLASSES = {
  scorching: 'bg-success text-white',
  hot: 'bg-success/15 text-success',
  warm: 'bg-warning/15 text-warning',
} as const

/** Color-graded AI probability badge — hotter reads stronger. */
export function ProbabilityBadge({ value }: { value: number }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full px-2 text-xs font-semibold tabular-nums',
        TIER_CLASSES[probabilityTier(value)],
      )}
    >
      {Math.round(value)}%
    </span>
  )
}

/** none / generated / viewed chip for the latest AI Closer Brief. */
export function BriefChip({
  generatedAt,
  viewedAt,
}: {
  generatedAt: Date | null
  viewedAt: Date | null
}) {
  const status = briefStatus(generatedAt, viewedAt)
  if (status === 'viewed') {
    return (
      <span className="bg-success/10 text-success inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium">
        <Eye className="size-3" /> Brief viewed
      </span>
    )
  }
  if (status === 'generated') {
    return (
      <span className="bg-warning/10 text-warning inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium">
        <FileText className="size-3" /> Generated, unread
      </span>
    )
  }
  return (
    <span className="text-muted-foreground bg-muted inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium">
      <Minus className="size-3" /> No brief
    </span>
  )
}

/** met / behind / measuring state chip for a phase target row. */
export function CheckStateChip({ met }: { met: boolean | null }) {
  if (met === null) {
    return (
      <span className="text-muted-foreground bg-muted inline-flex h-5 items-center rounded-full px-2 text-xs font-medium">
        Measuring
      </span>
    )
  }
  return met ? (
    <span className="bg-success/10 text-success inline-flex h-5 items-center rounded-full px-2 text-xs font-medium">
      On target
    </span>
  ) : (
    <span className="bg-danger/10 text-danger inline-flex h-5 items-center rounded-full px-2 text-xs font-medium">
      Behind
    </span>
  )
}

/**
 * One of the five phase-metric cards on the overview: the actual number, the
 * phase target underneath, and the met/behind/measuring state.
 */
export function PhaseMetricCard({ check, sample }: { check: PhaseCheck; sample?: string }) {
  return (
    <div className="bg-card rounded-lg border p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-muted-foreground text-xs font-medium">{check.label}</p>
        <CheckStateChip met={check.met} />
      </div>
      <p
        className={cn(
          'mt-1.5 tracking-tight tabular-nums',
          check.met === null
            ? 'text-muted-foreground text-lg font-medium'
            : 'text-2xl font-semibold',
        )}
      >
        {check.actual}
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        Target <span className="tabular-nums">{check.target}</span>
        {sample && (
          <>
            <span aria-hidden> · </span>
            <span className="tabular-nums">{sample}</span>
          </>
        )}
      </p>
    </div>
  )
}
