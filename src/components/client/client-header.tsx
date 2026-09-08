import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { can, requireUser, requireClientInScope } from '@/lib/rbac'
import { db } from '@/lib/db'
import { StageBadge } from '@/components/stage-badge'
import { SlaIndicator } from '@/components/sla-indicator'
import { Badge } from '@/components/ui/badge'
import { currency, fullName, humanize, relativeTime } from '@/lib/format'
import { StageAdvance, type StageOption } from '@/app/(app)/clients/[clientId]/stage-advance'

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ACTIVE: 'secondary',
  ON_HOLD: 'outline',
  DISQUALIFIED: 'destructive',
  CLOSED_WON: 'default',
  CLOSED_LOST: 'destructive',
}

/**
 * The record header: identity, stage, status, owner, source, value, last
 * activity, and the stage-advance control for users who may move stages.
 */
export async function ClientHeader({ clientId }: { clientId: string }) {
  const user = await requireUser()
  const client = await requireClientInScope(user, clientId)

  const [details, stages] = await Promise.all([
    db.client.findUniqueOrThrow({
      where: { id: client.id },
      include: {
        currentStage: true,
        owner: { select: { name: true } },
        team: { select: { name: true } },
        leadSource: { select: { name: true } },
      },
    }),
    db.pipelineStage.findMany({
      where: { pipelineId: client.pipelineId },
      select: { key: true, name: true },
    }),
  ])

  const stageByKey = new Map(stages.map((s) => [s.key, s.name]))
  const options: StageOption[] = details.currentStage.allowedNextKeys
    .filter((k) => stageByKey.has(k))
    .map((k) => ({ key: k, name: stageByKey.get(k)! }))
  for (const k of ['ON_HOLD', 'CLOSED_LOST'] as const) {
    if (details.currentStage.key !== k && stageByKey.has(k) && !options.some((o) => o.key === k)) {
      options.push({ key: k, name: stageByKey.get(k)!, universal: true })
    }
  }

  return (
    <div className="border-b px-4 py-4 sm:px-6">
      <Link
        href="/clients"
        className="text-muted-foreground hover:text-foreground mb-2 inline-flex items-center gap-1 text-xs"
      >
        <ChevronLeft className="size-3.5" />
        All clients
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{fullName(details)}</h1>
            <StageBadge
              stageKey={details.currentStage.key}
              name={details.currentStage.name}
              category={details.currentStage.category}
            />
            <Badge variant={STATUS_VARIANT[details.status] ?? 'outline'}>{humanize(details.status)}</Badge>
          </div>
          <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span>
              Owner:{' '}
              <span className="text-foreground font-medium">
                {details.owner?.name ?? 'Unassigned'}
              </span>
              {details.team ? ` · ${details.team.name}` : ''}
            </span>
            <span>Source: {details.leadSource?.name ?? '—'}</span>
            <span className="tabular-nums">Value: {currency(details.estimatedValue)}</span>
            <span>Last activity {relativeTime(details.lastActivityAt)}</span>
            <span className="inline-flex items-center gap-1">
              In stage:
              <SlaIndicator since={details.stageEnteredAt} slaHours={details.currentStage.slaHours} />
            </span>
          </div>
        </div>

        {can(user, 'clients:advance_stage') && (
          <StageAdvance clientId={details.id} currentStageName={details.currentStage.name} options={options} />
        )}
      </div>
    </div>
  )
}
