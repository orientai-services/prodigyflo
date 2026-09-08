import type { DocumentStatus, ExtractionStatus, FieldVerification } from '@prisma/client'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { humanize } from '@/lib/format'

const DOC_STATUS_CLASSES: Record<DocumentStatus, string> = {
  REQUESTED: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  RECEIVED: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400',
  PROCESSING: 'bg-violet-500/10 text-violet-700 dark:text-violet-400',
  UNDER_REVIEW: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  MISSING_INFORMATION: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
  APPROVED: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  REJECTED: 'bg-red-500/10 text-red-700 dark:text-red-400',
  EXPIRED: 'bg-muted text-muted-foreground',
}

export function DocumentStatusBadge({ status, className }: { status: DocumentStatus; className?: string }) {
  return (
    <Badge variant="secondary" className={cn(DOC_STATUS_CLASSES[status], className)}>
      {humanize(status)}
    </Badge>
  )
}

const VERIFICATION_CLASSES: Record<FieldVerification, string> = {
  UNVERIFIED: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  VERIFIED: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  CORRECTED: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  REJECTED: 'bg-red-500/10 text-red-700 dark:text-red-400',
}

export function VerificationBadge({ verification }: { verification: FieldVerification }) {
  return (
    <Badge variant="secondary" className={VERIFICATION_CLASSES[verification]}>
      {humanize(verification)}
    </Badge>
  )
}

export function ExtractionStatusBadge({ status }: { status: ExtractionStatus }) {
  const cls =
    status === 'COMPLETED'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : status === 'FAILED'
        ? 'bg-red-500/10 text-red-700 dark:text-red-400'
        : 'bg-violet-500/10 text-violet-700 dark:text-violet-400'
  return (
    <Badge variant="secondary" className={cls}>
      {humanize(status)}
    </Badge>
  )
}

/** Visually graded confidence: red under the floor, amber mid, green high. */
export function ConfidenceMeter({ value }: { value: number }) {
  const color = value >= 90 ? 'bg-emerald-500' : value >= 60 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <span className="inline-flex items-center gap-1.5" title={`Extraction confidence ${value}%`}>
      <span className="bg-muted h-1.5 w-14 overflow-hidden rounded-full">
        <span className={cn('block h-full rounded-full', color)} style={{ width: `${Math.max(4, value)}%` }} />
      </span>
      <span className="text-muted-foreground text-xs tabular-nums">{value}%</span>
    </span>
  )
}

/** Mock adapters must be visible in the UI — this is that label. */
export function ProviderBadge({ provider, model }: { provider: string; model: string | null }) {
  if (provider === 'mock') {
    return (
      <Badge variant="outline" className="border-dashed text-muted-foreground" title="No real AI or OCR ran. Deterministic mock extraction — values still require human verification.">
        Mock extraction
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {provider}
      {model ? ` · ${model}` : ''}
    </Badge>
  )
}
