import { CheckCircle2, ChevronsUp, Target } from 'lucide-react'
import { can } from '@/lib/rbac'
import {
  OPS_PHASES,
  evaluatePhase,
  getCloseOpsConfig,
  getCloseOpsMetrics,
  phaseDef,
} from '@/lib/closeops'
import { SALES_LEVEL_LABEL, requireSalesAccess } from '@/lib/coaching'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { CheckStateChip, SalesNav } from '../ui'
import { OpsSettings } from './ops-settings'

export const metadata = { title: 'Close-rate operations' }

export default async function CloseRateOpsPage() {
  const { user, level } = await requireSalesAccess()
  const canQualify = can(user, 'qualification:review')

  const config = await getCloseOpsConfig(user.organizationId)
  const def = phaseDef(config.phase)
  const metrics = await getCloseOpsMetrics(user, config)
  const checks = evaluatePhase(def, metrics)

  return (
    <>
      <PageHeader
        title="Close-rate operations"
        description={`The Phase 1 → 2 → 3 operating model, measured over the ${SALES_LEVEL_LABEL[level]}`}
      >
        <SalesNav current="ops" canQualify={canQualify} />
      </PageHeader>

      <div className="space-y-4 p-4 sm:p-6">
        {/* Phase progression */}
        <div className="grid gap-3 lg:grid-cols-3">
          {OPS_PHASES.map((phase) => {
            const isCurrent = phase.phase === config.phase
            const isPast = phase.phase < config.phase
            return (
              <div
                key={phase.phase}
                className={cn(
                  'bg-card rounded-xl border p-4',
                  isCurrent ? 'ring-primary/50 shadow-e1 ring-2' : 'opacity-80',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <Badge variant={isCurrent ? 'default' : 'outline'}>Phase {phase.phase}</Badge>
                  {isCurrent && (
                    <span className="text-primary text-xs font-semibold tracking-wide uppercase">
                      Current
                    </span>
                  )}
                  {isPast && (
                    <span className="text-success flex items-center gap-1 text-xs font-medium">
                      <CheckCircle2 className="size-3.5" /> Completed
                    </span>
                  )}
                </div>
                <h2 className="mt-2 text-sm font-semibold">{phase.name}</h2>
                <p className="text-muted-foreground mt-1 text-xs">{phase.objective}</p>

                <p className="text-muted-foreground mt-3 flex items-center gap-1 text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <Target className="size-3" /> Focus
                </p>
                <ul className="mt-1 space-y-1">
                  {phase.focusAreas.map((area) => (
                    <li key={area} className="flex items-start gap-1.5 text-xs">
                      <span className="bg-primary/60 mt-1.5 size-1 shrink-0 rounded-full" aria-hidden />
                      <span>{area}</span>
                    </li>
                  ))}
                </ul>

                <p className="text-muted-foreground mt-3 flex items-center gap-1 text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <ChevronsUp className="size-3" /> Advance when
                </p>
                <ul className="mt-1 space-y-1">
                  {phase.advanceCriteria.map((c) => (
                    <li key={c} className="flex items-start gap-1.5 text-xs">
                      <span className="bg-success/70 mt-1.5 size-1 shrink-0 rounded-full" aria-hidden />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>

        {/* Current-phase scoreboard */}
        <div className="bg-card shadow-e1 rounded-xl border">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Phase {def.phase} scoreboard</h2>
            <p className="text-muted-foreground text-xs">
              Target vs. actual over the last 90 days, scoped to the {SALES_LEVEL_LABEL[level]} ·
              &ldquo;measuring&rdquo; means not enough data to judge yet
            </p>
          </div>
          <div className="scroll-x">
            <table className="w-full min-w-[36rem] text-sm tabular-nums">
              <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Metric</th>
                  <th className="px-4 py-2 text-right">Actual</th>
                  <th className="px-4 py-2 text-right">Target</th>
                  <th className="px-4 py-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((check) => (
                  <tr key={check.label} className="border-b last:border-0">
                    <td className="px-4 py-2.5 font-medium">{check.label}</td>
                    <td
                      className={cn(
                        'px-4 py-2.5 text-right',
                        check.met === null && 'text-muted-foreground',
                      )}
                    >
                      {check.actual}
                    </td>
                    <td className="text-muted-foreground px-4 py-2.5 text-right">{check.target}</td>
                    <td className="px-4 py-2.5 text-right">
                      <CheckStateChip met={check.met} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {can(user, 'org:manage') && (
          <OpsSettings
            config={config}
            phases={OPS_PHASES.map((p) => ({
              phase: p.phase,
              name: p.name,
              hotLeadThreshold: p.hotLeadThreshold,
            }))}
          />
        )}
      </div>
    </>
  )
}
