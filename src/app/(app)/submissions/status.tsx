import type { SubmissionStatus } from '@prisma/client'
import { Badge } from '@/components/ui/badge'
import { humanize } from '@/lib/format'
import { cn } from '@/lib/utils'

const STATUS_CLASS: Record<SubmissionStatus, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  READY: 'bg-primary/10 text-primary',
  SUBMITTED: 'bg-primary/10 text-primary',
  ACKNOWLEDGED: 'bg-primary/10 text-primary',
  CORRECTIONS_REQUESTED: 'bg-warning/10 text-warning',
  RESUBMITTED: 'bg-primary/10 text-primary',
  APPROVED: 'bg-success/10 text-success',
  REJECTED: 'bg-destructive/10 text-destructive',
}

export function SubmissionStatusBadge({ status }: { status: SubmissionStatus }) {
  return (
    <Badge variant="outline" className={cn('border-transparent', STATUS_CLASS[status])}>
      {humanize(status)}
    </Badge>
  )
}
