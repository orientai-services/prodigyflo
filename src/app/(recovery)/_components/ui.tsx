import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'
import { BUCKET_LABEL, type RecoveryBucket } from '@/lib/recovery'
import { cn } from '@/lib/utils'

/** A brand surface card — rounded, airy, on the recovery surface token. */
export function RecCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-[var(--rec-border)] bg-[var(--rec-surface)] shadow-[0_1px_2px_rgba(16,40,30,0.04)]',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** A big, clear headline number — the recovery product speaks in outcomes. */
export function RecStat({
  label,
  value,
  hint,
  accent = false,
  icon,
}: {
  label: string
  value: string
  hint?: string
  accent?: boolean
  icon?: ReactNode
}) {
  return (
    <RecCard className="p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-[var(--rec-muted)] uppercase">{label}</span>
        {icon && <span className="text-[var(--rec-primary-ink)]">{icon}</span>}
      </div>
      <div
        className={cn(
          'mt-2 text-3xl font-semibold tracking-tight tabular-nums',
          accent ? 'text-[var(--rec-primary-ink)]' : 'text-[var(--rec-text)]',
        )}
      >
        {value}
      </div>
      {hint && <p className="mt-1 text-xs text-[var(--rec-muted)]">{hint}</p>}
    </RecCard>
  )
}

const BUCKET_STYLE: Record<RecoveryBucket, string> = {
  lost: 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
  on_hold: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  dormant: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
}

export function BucketPill({ bucket, className }: { bucket: RecoveryBucket; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
        BUCKET_STYLE[bucket],
        className,
      )}
    >
      {BUCKET_LABEL[bucket]}
    </span>
  )
}

/** Section heading used inside cards. */
export function SectionHead({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--rec-border)] px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--rec-text)]">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-[var(--rec-muted)]">{description}</p>}
      </div>
      {action}
    </div>
  )
}

/** A brand pill-link (used for "View all", pagination, etc.). */
export function RecPillLink({
  className,
  children,
  ...props
}: ComponentProps<typeof Link>) {
  return (
    <Link
      {...props}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-[var(--rec-border)] bg-[var(--rec-surface)] px-3 py-1.5 text-xs font-medium text-[var(--rec-text)] transition-colors hover:border-[var(--rec-primary-border)] hover:bg-[var(--rec-primary-soft)] hover:text-[var(--rec-primary-ink)]',
        className,
      )}
    >
      {children}
    </Link>
  )
}
