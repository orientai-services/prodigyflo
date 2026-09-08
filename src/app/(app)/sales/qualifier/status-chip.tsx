import { CircleCheck, CircleDashed, CircleX, Clock } from 'lucide-react'
import type { ReviewStatus } from '@/lib/qualifier'

/**
 * Qualifier decision chip — approved / needs review / rejected / stale.
 * Server-safe: pure render, shared by the qualifier queue and hot-leads pages.
 */
export function ReviewStatusChip({ status }: { status: ReviewStatus }) {
  if (status === 'approved') {
    return (
      <span className="bg-success/10 text-success inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium">
        <CircleCheck className="size-3" /> Approved
      </span>
    )
  }
  if (status === 'rejected') {
    return (
      <span className="bg-danger/10 text-danger inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium">
        <CircleX className="size-3" /> Rejected
      </span>
    )
  }
  if (status === 'stale') {
    return (
      <span className="bg-warning/10 text-warning inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium">
        <Clock className="size-3" /> Stale
      </span>
    )
  }
  return (
    <span className="text-muted-foreground bg-muted inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium">
      <CircleDashed className="size-3" /> Needs review
    </span>
  )
}
