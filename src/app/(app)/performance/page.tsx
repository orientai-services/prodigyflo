import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertTriangle, Columns3, Download, Sparkles, Trophy, X } from 'lucide-react'
import { requireUser } from '@/lib/rbac'
import { LEVEL_LABEL, analyticsLevel, getOverdueSummary } from '@/lib/reporting'
import { getCloseOpsConfig, phaseDef } from '@/lib/closeops'
import {
  POINT_RULES,
  getScoreboard,
  leakTone,
  qaTone,
  scoreboardRange,
  toneVsTarget,
  type ScoreboardRangeKey,
  type ScoreboardRow,
  type Tone,
} from '@/lib/scoreboard'
import {
  hiddenColumnCount,
  scoreboardColumnMode,
  scoreboardColumns,
  type ScoreboardColumnKey,
  type ScoreboardColumnMode,
} from '@/components/dashboard/scoreboard-columns'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { EmptyState } from '@/components/empty-state'
import { cn } from '@/lib/utils'
import { currency, number, percent } from '@/lib/format'

export const metadata = { title: 'Performance' }

const RANGES: { key: ScoreboardRangeKey; label: string }[] = [
  { key: 'week', label: 'This week' },
  { key: '30', label: '30 days' },
  { key: '90', label: '90 days' },
  { key: 'all', label: 'All time' },
]

const TONE_CLASS: Record<Tone, string> = {
  good: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  muted: 'text-muted-foreground',
}

function RankBadge({ rank }: { rank: number }) {
  const medal =
    rank === 1
      ? 'bg-amber-400/15 text-amber-600 ring-amber-500/40 dark:text-amber-400'
      : rank === 2
        ? 'bg-slate-400/15 text-slate-500 ring-slate-400/40 dark:text-slate-300'
        : rank === 3
          ? 'bg-orange-700/15 text-orange-700 ring-orange-600/40 dark:text-orange-400'
          : null
  return (
    <span
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-full text-xs font-semibold tabular-nums',
        medal ? `${medal} ring-1` : 'bg-surface-sunk text-muted-foreground',
      )}
    >
      {rank}
    </span>
  )
}

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requireUser()
  const level = analyticsLevel(user)
  // Closers hold analytics:self — they get the board too, scoped to themselves.
  if (!level && !user.permissions.has('analytics:self')) redirect('/forbidden')
  const scopeLabel = level ? LEVEL_LABEL[level] : 'your own numbers'

  const params = await searchParams
  const range = scoreboardRange(typeof params.range === 'string' ? params.range : undefined)
  const selectedId = typeof params.closer === 'string' ? params.closer : undefined
  const colMode = scoreboardColumnMode(typeof params.cols === 'string' ? params.cols : undefined)
  const visible = new Set<ScoreboardColumnKey>(scoreboardColumns(colMode))
  const show = (key: ScoreboardColumnKey) => visible.has(key)

  const config = await getCloseOpsConfig(user.organizationId)
  const def = phaseDef(config.phase)
  const [rows, overdue] = await Promise.all([
    getScoreboard(user, config, range.from),
    getOverdueSummary(user),
  ])

  const totals = rows.reduce(
    (acc, r) => ({
      qualifiedWon: acc.qualifiedWon + r.qualifiedWon,
      qualifiedLost: acc.qualifiedLost + r.qualifiedLost,
      wins: acc.wins + r.wins,
      revenue: acc.revenue + r.revenueWon,
      calls: acc.calls + r.calls,
      briefedCalls: acc.briefedCalls + r.briefedCalls,
      pipeline: acc.pipeline + r.pipeline,
      leaking: acc.leaking + r.leaking,
    }),
    { qualifiedWon: 0, qualifiedLost: 0, wins: 0, revenue: 0, calls: 0, briefedCalls: 0, pipeline: 0, leaking: 0 },
  )
  const decided = totals.qualifiedWon + totals.qualifiedLost
  const teamCloseRate = decided > 0 ? (totals.qualifiedWon / decided) * 100 : null
  const teamAdoption = totals.calls > 0 ? (totals.briefedCalls / totals.calls) * 100 : null

  const selected = selectedId ? rows.find((r) => r.id === selectedId) : undefined
  const hrefFor = (patch: {
    range?: ScoreboardRangeKey
    closer?: string | null
    cols?: ScoreboardColumnMode
  }) => {
    const q = new URLSearchParams()
    const r = patch.range ?? range.key
    if (r !== '30') q.set('range', r)
    const c = patch.closer === undefined ? selectedId : patch.closer
    if (c) q.set('closer', c)
    const m = patch.cols ?? colMode
    if (m === 'all') q.set('cols', 'all')
    const qs = q.toString()
    return qs ? `/performance?${qs}` : '/performance'
  }

  return (
    <>
      <PageHeader
        title="Performance"
        description={`Closer scoreboard for ${scopeLabel} · ${range.label.toLowerCase()} · Phase ${config.phase}: ${def.name}`}
        actions={
          <>
            <Button variant="outline" size="sm" render={<a href={`/exports/scoreboard?range=${range.key}`} />}>
              <Download className="size-3.5" />
              Export CSV
            </Button>
            <div className="bg-surface-sunk flex items-center gap-0.5 rounded-lg border p-0.5">
              {RANGES.map((r) => (
                <Link
                  key={r.key}
                  href={hrefFor({ range: r.key })}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    range.key === r.key
                      ? 'bg-surface-raised shadow-e1'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {r.label}
                </Link>
              ))}
            </div>
          </>
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        <StatGrid>
          <StatTile
            label="Close rate on qualified"
            value={teamCloseRate === null ? '—' : percent(teamCloseRate, 1)}
            hint={`Phase ${config.phase} target ≥${def.targets.closeRatePct}%`}
            sample={`n=${number(decided)}`}
          />
          <StatTile
            label="Revenue won"
            value={currency(totals.revenue, { compact: true })}
            hint={range.label}
            sample={`${number(totals.wins)} deals`}
          />
          <StatTile
            label="AI Brief adoption"
            value={teamAdoption === null ? '—' : percent(teamAdoption, 1)}
            hint="Target: every call"
            sample={`${number(totals.briefedCalls)}/${number(totals.calls)} calls`}
          />
          <StatTile
            label="Leaking leads"
            value={number(totals.leaking)}
            hint={`No touch in ${config.leakageDays}+ days`}
            sample={`of ${number(totals.pipeline)} live`}
          />
        </StatGrid>

        {/* /reports/overdue requires team-level analytics — closers get the count without the link. */}
        {(overdue.overdueTasks > 0 || overdue.slaExpired > 0) &&
          (level ? (
            <Link
              href="/reports/overdue"
              className="border-warning/40 bg-warning/5 hover:bg-warning/10 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm transition-colors"
            >
              <AlertTriangle className="text-warning size-4 shrink-0" />
              <span>
                <span className="font-medium">
                  {number(overdue.overdueTasks + overdue.slaExpired)} follow-ups are slipping.
                </span>{' '}
                <span className="text-muted-foreground">See exactly which tasks and clients →</span>
              </span>
            </Link>
          ) : (
            <div className="border-warning/40 bg-warning/5 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm">
              <AlertTriangle className="text-warning size-4 shrink-0" />
              <span>
                <span className="font-medium">
                  {number(overdue.overdueTasks + overdue.slaExpired)} follow-ups are slipping.
                </span>{' '}
                <span className="text-muted-foreground">
                  Work them from each client&rsquo;s task list.
                </span>
              </span>
            </div>
          ))}

        {selected && (
          <CloserDetail
            row={selected}
            isSelf={selected.id === user.id}
            closeHref={hrefFor({ closer: null })}
            hotThreshold={config.hotLeadThreshold}
          />
        )}

        <div className="bg-card shadow-e1 rounded-xl border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <div>
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <Trophy className="text-warning size-4" /> Closer scoreboard
              </h2>
              <p className="text-muted-foreground text-xs">
                {range.label} · points reward wins the AI called right, AI Brief use, full-funnel
                calls, and QA quality — leaking leads subtract. Select a closer for the full breakdown.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground hidden text-xs tabular-nums sm:inline">
                Hot-lead threshold {config.hotLeadThreshold}%
              </span>
              <Link
                href={hrefFor({ cols: colMode === 'all' ? 'core' : 'all' })}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                  colMode === 'all'
                    ? 'bg-surface-raised shadow-e1'
                    : 'text-muted-foreground hover:text-foreground bg-surface-sunk',
                )}
              >
                <Columns3 className="size-3.5" />
                {colMode === 'all'
                  ? 'Fewer columns'
                  : `More columns (+${hiddenColumnCount(colMode)})`}
              </Link>
            </div>
          </div>

          {rows.length === 0 ? (
            <EmptyState
              icon="Users"
              title="No closers in your scope"
              description="When active closers own clients you can see, the scoreboard fills in here."
            />
          ) : (
            <div className="scroll-x">
              <table
                className={cn(
                  'w-full text-sm tabular-nums',
                  colMode === 'all' ? 'min-w-[82rem]' : 'min-w-[52rem]',
                )}
              >
                <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <tr>
                    <th className="w-12 px-4 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">Closer</th>
                    <th className="px-3 py-2 text-right">Points</th>
                    <th className="px-3 py-2 text-right">Pipeline</th>
                    <th className="px-3 py-2 text-right">Close rate</th>
                    <th className="px-3 py-2 text-right">Revenue won</th>
                    {show('avgAiOnWins') && <th className="px-3 py-2 text-right">Avg AI on wins</th>}
                    {show('aiRead') && <th className="px-3 py-2 text-right">AI read</th>}
                    <th className="px-3 py-2 text-right">Calls</th>
                    {show('adherence') && <th className="px-3 py-2 text-right">Funnel adherence</th>}
                    {show('qa') && <th className="px-3 py-2 text-right">QA avg</th>}
                    {show('coaching') && <th className="px-3 py-2 text-right">Coaching</th>}
                    <th className="px-4 py-2 text-right">Leaks</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const isSelf = r.id === user.id
                    return (
                      <tr
                        key={r.id}
                        className={cn(
                          'hover:bg-muted/40 border-b transition-colors last:border-0',
                          isSelf && 'bg-primary/5',
                          selected?.id === r.id && 'bg-muted/50',
                        )}
                      >
                        <td className="px-4 py-2.5">
                          <RankBadge rank={r.rank} />
                        </td>
                        <td className="px-3 py-2.5">
                          <Link href={hrefFor({ closer: r.id })} className="group block">
                            <span className="text-foreground font-medium group-hover:underline">
                              {r.name}
                            </span>
                            {isSelf && (
                              <span className="bg-primary/10 text-primary ml-1.5 rounded px-1 py-px text-[0.625rem] font-semibold uppercase">
                                You
                              </span>
                            )}
                            <span className="text-muted-foreground block text-xs">
                              {r.teamName ?? 'No team'}
                            </span>
                          </Link>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <span className={cn('text-base font-semibold', r.points < 0 && 'text-danger')}>
                            {number(r.points)}
                          </span>
                          <span className="text-muted-foreground block text-xs">
                            {number(r.wins)} wins
                            {r.hotWins > 0 && (
                              <span className="text-success"> · {number(r.hotWins)} hot</span>
                            )}
                          </span>
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2.5 text-right',
                            r.capacity > 0 && r.pipeline >= r.capacity && 'text-danger font-medium',
                          )}
                        >
                          {number(r.pipeline)}
                          <span className="text-muted-foreground text-xs"> / {number(r.capacity)}</span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <span className={TONE_CLASS[toneVsTarget(r.closeRatePct, def.targets.closeRatePct)]}>
                            {r.closeRatePct === null ? '—' : percent(r.closeRatePct, 1)}
                          </span>
                          <span className="text-muted-foreground ml-1 text-xs">
                            n={number(r.qualifiedWon + r.qualifiedLost)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium">{currency(r.revenueWon)}</td>
                        {show('avgAiOnWins') && (
                          <td className="px-3 py-2.5 text-right">
                            <span
                              className={
                                TONE_CLASS[toneVsTarget(r.avgAiProbOnWonPct, def.targets.avgAiProbabilityOnWonPct)]
                              }
                            >
                              {r.avgAiProbOnWonPct === null ? '—' : percent(r.avgAiProbOnWonPct, 1)}
                            </span>
                          </td>
                        )}
                        {show('aiRead') && (
                          <td className="px-3 py-2.5 text-right">
                            {r.aiAlignmentPct === null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span className={TONE_CLASS[toneVsTarget(r.aiAlignmentPct, 75)]}>
                                {percent(r.aiAlignmentPct, 0)}
                              </span>
                            )}
                            <span className="text-muted-foreground block text-xs">
                              {r.aiReadSample === 0 ? 'no decided' : `n=${number(r.aiReadSample)}`}
                            </span>
                          </td>
                        )}
                        <td className="px-3 py-2.5 text-right">
                          {number(r.calls)}
                          <span
                            className={cn('block text-xs', TONE_CLASS[toneVsTarget(r.briefAdoptionPct, 80)])}
                          >
                            {r.briefAdoptionPct === null ? 'no calls' : `${percent(r.briefAdoptionPct, 0)} briefed`}
                          </span>
                        </td>
                        {show('adherence') && (
                          <td className="px-3 py-2.5 text-right">
                            <span className={TONE_CLASS[toneVsTarget(r.adherencePct, 100)]}>
                              {r.adherencePct === null ? '—' : percent(r.adherencePct, 0)}
                            </span>
                            <span className="text-muted-foreground block text-xs">
                              {r.adherenceCalls === 0
                                ? 'no scored calls'
                                : `n=${number(r.adherenceCalls)}${r.fullFunnelCalls > 0 ? ` · ${number(r.fullFunnelCalls)} at 100%` : ''}`}
                            </span>
                          </td>
                        )}
                        {show('qa') && (
                          <td className="px-3 py-2.5 text-right">
                            <span className={TONE_CLASS[qaTone(r.qaAvg)]}>
                              {r.qaAvg === null ? '—' : r.qaAvg.toFixed(1)}
                            </span>
                            {r.qaCount > 0 && (
                              <span className="text-muted-foreground ml-1 text-xs">n={number(r.qaCount)}</span>
                            )}
                          </td>
                        )}
                        {show('coaching') && (
                          <td className="px-3 py-2.5 text-right">{number(r.coachingSessions)}</td>
                        )}
                        <td className={cn('px-4 py-2.5 text-right font-medium', TONE_CLASS[leakTone(r.leaking)])}>
                          {number(r.leaking)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <CollapsibleSection
          variant="card"
          defaultOpen={false}
          storageKey="perf-points-legend"
          title={
            <span className="flex items-center gap-1.5">
              <Sparkles className="text-primary size-3.5" /> How points are scored
            </span>
          }
          summary={`${POINT_RULES.length} rules`}
        >
          <div className="px-4 py-3">
            <ul className="text-muted-foreground grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
              {POINT_RULES.map((rule) => (
                <li key={rule.key} className="flex items-baseline gap-1.5">
                  <span
                    className={cn(
                      'w-7 shrink-0 text-right font-semibold tabular-nums',
                      rule.each < 0 ? 'text-danger' : 'text-success',
                    )}
                  >
                    {rule.each > 0 ? `+${rule.each}` : rule.each}
                  </span>
                  <span>
                    <span className="text-foreground font-medium">{rule.label}</span> — {rule.unit}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-2 text-[0.6875rem]">
              Points rank effort and AI-aligned execution only — the AI never decides qualification,
              eligibility, or a close. Every score here traces to a human-recorded outcome.
            </p>
          </div>
        </CollapsibleSection>
      </div>
    </>
  )
}

function CloserDetail({
  row,
  isSelf,
  closeHref,
  hotThreshold,
}: {
  row: ScoreboardRow
  isSelf: boolean
  closeHref: string
  hotThreshold: number
}) {
  return (
    <CollapsibleSection
      variant="card"
      defaultOpen
      title={
        <span className="flex items-center gap-2.5">
          <RankBadge rank={row.rank} />
          <span>
            <span className="block">
              {row.name}
              {isSelf && (
                <span className="bg-primary/10 text-primary ml-1.5 rounded px-1 py-px text-[0.625rem] font-semibold uppercase">
                  You
                </span>
              )}
            </span>
            <span className="text-muted-foreground block text-xs font-normal">
              {row.teamName ?? 'No team'} · rank {row.rank} ·{' '}
              <span className="tabular-nums">{number(row.points)} points</span>
            </span>
          </span>
        </span>
      }
      summary={`${number(row.points)} pts`}
      actions={
        <Link
          href={closeHref}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium transition-colors"
        >
          <X className="size-3.5" /> Close
        </Link>
      }
    >
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(20rem,2fr)_3fr]">
        <div className="bg-surface-sunk/50 rounded-lg border">
          <p className="text-muted-foreground border-b px-3 py-2 text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
            Points breakdown
          </p>
          <table className="w-full text-sm tabular-nums">
            <tbody>
              {row.pointsLines.map((line) => (
                <tr key={line.key} className="border-b last:border-0">
                  <td className="px-3 py-1.5">{line.label}</td>
                  <td className="text-muted-foreground px-2 py-1.5 text-right text-xs whitespace-nowrap">
                    {number(line.count)} × {line.each > 0 ? `+${line.each}` : line.each}
                  </td>
                  <td
                    className={cn(
                      'w-16 px-3 py-1.5 text-right font-medium',
                      line.points > 0 && 'text-success',
                      line.points < 0 && 'text-danger',
                      line.points === 0 && 'text-muted-foreground',
                    )}
                  >
                    {line.points > 0 ? `+${number(line.points)}` : number(line.points)}
                  </td>
                </tr>
              ))}
              <tr className="bg-surface-sunk">
                <td className="px-3 py-1.5 font-semibold">Total</td>
                <td />
                <td
                  className={cn(
                    'px-3 py-1.5 text-right font-semibold',
                    row.points < 0 && 'text-danger',
                  )}
                >
                  {number(row.points)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <dl className="grid grid-cols-2 content-start gap-3 sm:grid-cols-3">
          <DetailStat label="Live pipeline" value={`${number(row.pipeline)} / ${number(row.capacity)}`} />
          <DetailStat
            label="Close rate (qualified)"
            value={row.closeRatePct === null ? '—' : percent(row.closeRatePct, 1)}
            sub={`${number(row.qualifiedWon)} won · ${number(row.qualifiedLost)} lost`}
          />
          <DetailStat label="Revenue won" value={currency(row.revenueWon)} sub={`${number(row.wins)} deals`} />
          <DetailStat
            label="Avg AI on wins"
            value={row.avgAiProbOnWonPct === null ? '—' : percent(row.avgAiProbOnWonPct, 1)}
            sub={`${number(row.hotWins)} at ≥${hotThreshold}%`}
          />
          <DetailStat
            label="Calls made"
            value={number(row.calls)}
            sub={
              row.briefAdoptionPct === null
                ? 'none in range'
                : `${percent(row.briefAdoptionPct, 0)} with AI Brief`
            }
          />
          <DetailStat
            label="Funnel adherence"
            value={row.adherencePct === null ? '—' : percent(row.adherencePct, 0)}
            sub={
              row.adherenceCalls > 0
                ? `${number(row.adherenceCalls)} scored calls · ${number(row.fullFunnelCalls)} at 100%`
                : 'no calls with a checklist yet'
            }
          />
          <DetailStat
            label="Call QA average"
            value={row.qaAvg === null ? '—' : row.qaAvg.toFixed(1)}
            sub={row.qaCount > 0 ? `${number(row.qaCount)} scored calls` : 'not yet scored'}
          />
          <DetailStat label="Coaching sessions" value={number(row.coachingSessions)} sub="1-on-1s in range" />
          <DetailStat
            label="Leaking leads"
            value={number(row.leaking)}
            sub={row.leaking > 0 ? 'needs a touch today' : 'pipeline is clean'}
          />
        </dl>
      </div>
    </CollapsibleSection>
  )
}

function DetailStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tracking-tight tabular-nums">{value}</dd>
      {sub && <dd className="text-muted-foreground text-xs tabular-nums">{sub}</dd>}
    </div>
  )
}
