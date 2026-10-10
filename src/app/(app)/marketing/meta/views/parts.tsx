import { CheckCircle2, CircleDashed, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { currency, humanize, number } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { AccountCard, SyncState } from '@/lib/meta/ads/read'

/**
 * Small presentational pieces shared by the Meta Ads views. Server-safe: the
 * only client pieces are the shadcn Tooltip primitives, which receive plain
 * elements as props.
 */

/** Plain-English explanations for every piece of ads jargon on the page. */
export const GLOSSARY = {
  spend: 'Money spent on ads in this period.',
  leads:
    "Counted on the day the lead came in, like ProdigyFlo. Ads Manager's default view counts the day the ad was seen, so its lead number can differ slightly.",
  cpl: 'Spend divided by leads.',
  ctr: 'Share of people who clicked after seeing the ad.',
  cpc: "Average cost of one click on the ad's link.",
  cpm: 'Cost for every 1,000 times the ad was shown.',
  reach: 'People who saw the ad at least once.',
  frequency: 'How many times, on average, each person saw the ad.',
  impressions: 'Times the ad was shown.',
  roas: 'Revenue divided by ad spend. 2.00× means $2 back for every $1 spent.',
  metaLeads: 'Leads Meta credits to this ad.',
  crmLeads: 'Leads in ProdigyFlo that came from this ad.',
  remainder:
    "Spend from ads that were removed or archived in Meta. It's counted in the totals so they match the account.",
  noLeads: 'This ad spent money every day in this streak without bringing a lead.',
  seenTooOften: 'People saw this ad more than 2.5 times each in the last 7 days. It may be wearing out.',
  lowCtr: 'Fewer than 1 in 100 people clicked in the last 7 days.',
} as const

/** A jargon word with a dotted underline and a plain-English tooltip. */
export function Term({ tip, children, className }: { tip: string; children: React.ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className={cn(
              'cursor-help underline decoration-dotted decoration-from-font underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              className,
            )}
          >
            {children}
          </span>
        }
      />
      <TooltipContent className="max-w-64 text-pretty">{tip}</TooltipContent>
    </Tooltip>
  )
}

/** Dollars with cents under $1,000, whole dollars above. "—" for null. */
export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return currency(value, { cents: Math.abs(value) < 1000 })
}

/** Always with cents: unit costs like CPL, CPC and CPM. */
export function unitCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return currency(value, { cents: true })
}

/** Meta reports CTR as a percentage already (1.25 means 1.25%). */
export function ctrText(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return `${value.toFixed(2)}%`
}

export function frequencyText(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return value.toFixed(2)
}

export function count(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : number(value)
}

const STATUS_WORDS: Record<string, string> = {
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  ARCHIVED: 'Archived',
  DELETED: 'Deleted',
  CAMPAIGN_PAUSED: 'Campaign paused',
  ADSET_PAUSED: 'Ad set paused',
  WITH_ISSUES: 'Has issues',
  DISAPPROVED: 'Rejected by Meta',
  PENDING_REVIEW: 'In review',
  IN_PROCESS: 'Processing',
  PREAPPROVED: 'Approved, waiting',
  PENDING_BILLING_INFO: 'Needs billing info',
}

/** Campaign, ad set and ad delivery status in plain words. */
export function statusWords(status: string | null | undefined): string {
  if (!status) return '—'
  return STATUS_WORDS[status] ?? humanize(status)
}

export function StatusBadge({ status, removed }: { status: string; removed?: boolean }) {
  if (removed) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Removed
      </Badge>
    )
  }
  const tone =
    status === 'ACTIVE'
      ? 'text-success border-success/40'
      : status === 'WITH_ISSUES' || status === 'DISAPPROVED'
        ? 'text-danger border-danger/40'
        : status === 'ARCHIVED' || status === 'DELETED'
          ? 'text-muted-foreground'
          : undefined
  return (
    <Badge variant="outline" className={tone}>
      {statusWords(status)}
    </Badge>
  )
}

const TONE_CLASS: Record<AccountCard['statusTone'], string> = {
  ok: 'text-success border-success/40',
  warn: 'text-warning border-warning/40',
  bad: 'text-danger border-danger/40',
}

export function AccountStatusPill({ account }: { account: Pick<AccountCard, 'statusWords' | 'statusTone'> }) {
  return (
    <Badge variant="outline" className={TONE_CLASS[account.statusTone]}>
      {account.statusWords}
    </Badge>
  )
}

/** Live / Sample data / Not connected. */
export function ModeBadge({ mode }: { mode: SyncState['mode'] }) {
  if (mode === 'live') {
    return (
      <Badge variant="outline" className="text-success border-success/40">
        Live
      </Badge>
    )
  }
  if (mode === 'mock') {
    return (
      <Badge variant="outline" className="text-warning border-warning/40">
        Sample data
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Not connected
    </Badge>
  )
}

/** Name/value pair used on account and cycle cards. */
export function Fact({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums">{children}</dd>
    </div>
  )
}

export type CheckState = 'ok' | 'bad' | 'unknown'

/** One row of a checklist. Red rows are problems, never soft notes. */
export function CheckRow({
  state,
  label,
  detail,
  children,
}: {
  state: CheckState
  label: React.ReactNode
  detail?: React.ReactNode
  children?: React.ReactNode
}) {
  const Icon = state === 'ok' ? CheckCircle2 : state === 'bad' ? X : CircleDashed
  return (
    <li className="flex items-start gap-2.5 py-2">
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          state === 'ok' && 'text-success',
          state === 'bad' && 'text-destructive',
          state === 'unknown' && 'text-muted-foreground',
        )}
      />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm', state === 'bad' && 'text-destructive font-medium')}>
          <span className="sr-only">{state === 'ok' ? 'OK: ' : state === 'bad' ? 'Problem: ' : 'Not checked yet: '}</span>
          {label}
        </p>
        {detail && <p className="text-muted-foreground mt-0.5 text-xs">{detail}</p>}
        {children}
      </div>
    </li>
  )
}
