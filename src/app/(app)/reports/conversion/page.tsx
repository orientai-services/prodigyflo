import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { requireUser } from '@/lib/rbac'
import { getFunnel, getStageAging } from '@/lib/analytics'
import { requireAnalyticsLevel } from '@/lib/reporting'
import { PageHeader } from '@/components/page-header'
import { FunnelChart } from '@/components/charts/funnel-chart'
import { Button } from '@/components/ui/button'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { StageBadge } from '@/components/stage-badge'
import { duration, number } from '@/lib/format'

export const metadata = { title: 'Conversion funnel' }

export default async function ConversionReportPage() {
  const user = await requireUser()
  requireAnalyticsLevel(user)

  const [funnel, aging] = await Promise.all([getFunnel(user), getStageAging(user)])
  const activeAging = aging.filter((s) => s.inStage > 0 || s.sample > 0)

  return (
    <>
      <PageHeader
        title="Conversion funnel"
        description="Stage-to-stage conversion for every client you can see, plus how long each stage takes"
        actions={
          <Button variant="outline" size="sm" render={<Link href="/reports" />}>
            <ChevronLeft className="size-3.5" />
            All reports
          </Button>
        }
      />

      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[3fr_2fr]">
        <FunnelChart
          steps={funnel}
          description={`Every client created to date · n=${number(funnel[0]?.count ?? 0)}`}
        />

        <CollapsibleSection
          variant="card"
          className="self-start"
          storageKey="report-conversion-aging"
          title="Time spent per stage"
          description="Average time to leave each stage, and how many clients are sitting there right now"
          summary={`${number(activeAging.length)} stages`}
        >
          <div className="scroll-x">
            <table className="w-full min-w-[24rem] text-sm tabular-nums">
              <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Stage</th>
                  <th className="px-4 py-2 text-right">In stage now</th>
                  <th className="px-4 py-2 text-right">Avg time</th>
                  <th className="px-4 py-2 text-right">SLA</th>
                </tr>
              </thead>
              <tbody>
                {activeAging.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-muted-foreground px-4 py-8 text-center text-sm">
                      No stage history yet.
                    </td>
                  </tr>
                ) : (
                  activeAging.map((s) => {
                    const overSla =
                      s.slaHours !== null && s.avgMinutes !== null && s.avgMinutes > s.slaHours * 60
                    return (
                      <tr key={s.key} className="hover:bg-muted/40 border-b transition-colors last:border-0">
                        <td className="px-4 py-2">
                          <StageBadge stageKey={s.key} name={s.name} category={s.category} />
                        </td>
                        <td className="px-4 py-2 text-right">{number(s.inStage)}</td>
                        <td className={overSla ? 'text-danger px-4 py-2 text-right font-medium' : 'px-4 py-2 text-right'}>
                          {s.avgMinutes === null ? '—' : duration(s.avgMinutes)}
                          {s.sample > 0 && (
                            <span className="text-muted-foreground ml-1 text-xs font-normal">n={s.sample}</span>
                          )}
                        </td>
                        <td className="text-muted-foreground px-4 py-2 text-right text-xs">
                          {s.slaHours === null ? '—' : `${s.slaHours}h`}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </CollapsibleSection>
      </div>
    </>
  )
}
