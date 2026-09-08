import { Gauge, Info, Target } from 'lucide-react'
import { can } from '@/lib/rbac'
import { getCloseOpsConfig, phaseDef } from '@/lib/closeops'
import {
  getCalibration,
  verdictNarrative,
  VERDICT_LABEL,
  type CalBucket,
  type CalibrationResult,
  type CalibrationVerdict,
} from '@/lib/calibration'
import { SALES_LEVEL_LABEL, requireSalesAccess } from '@/lib/coaching'
import { PageHeader } from '@/components/page-header'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { number, percent } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SalesNav } from '../ui'

export const metadata = { title: 'AI accuracy' }

/** Below this many decided, scored deals the sample is too thin to judge a model. */
const SAMPLE_FLOOR = 20

const VERDICT_TONE: Record<CalibrationVerdict, string> = {
  'well-calibrated': 'text-success',
  'over-confident': 'text-danger',
  'under-confident': 'text-warning',
  insufficient: 'text-muted-foreground',
}

const VERDICT_BADGE: Record<CalibrationVerdict, string> = {
  'well-calibrated': 'bg-success/10 text-success',
  'over-confident': 'bg-danger/10 text-danger',
  'under-confident': 'bg-warning/10 text-warning',
  insufficient: 'bg-muted text-muted-foreground',
}

/** actual − predicted: within the band is trustworthy, over-sold is the risky miss. */
function gapTone(gap: number | null): string {
  if (gap === null) return 'text-muted-foreground'
  if (Math.abs(gap) <= 5) return 'text-success'
  return gap < 0 ? 'text-danger' : 'text-warning'
}

/** Bar-fill counterpart of gapTone, as literal classes so Tailwind emits them. */
function barTone(gap: number | null): string {
  if (gap === null) return 'bg-muted-foreground/50'
  if (Math.abs(gap) <= 5) return 'bg-success'
  return gap < 0 ? 'bg-danger' : 'bg-warning'
}

export default async function AiAccuracyPage() {
  const { user, level } = await requireSalesAccess()
  const canQualify = can(user, 'qualification:review')

  const config = await getCloseOpsConfig(user.organizationId)
  const def = phaseDef(config.phase)
  const cal = await getCalibration(user, config)

  return (
    <>
      <PageHeader
        title="AI accuracy"
        description={`Is the probability-to-close score trustworthy? Measured over the ${SALES_LEVEL_LABEL[level]}`}
        actions={
          <Badge variant="outline" className="tabular-nums">
            Phase {def.phase} · hot cut {cal.hotLeadThreshold}%+
          </Badge>
        }
      >
        {/* current is widened to include 'accuracy' when the orchestrator wires the tab. */}
        <SalesNav current="accuracy" canQualify={canQualify} />
      </PageHeader>

      <div className="space-y-4 p-4 sm:p-6">
        <HonestyNote />

        {cal.n < SAMPLE_FLOOR ? (
          <div className="bg-card shadow-e1 rounded-xl border">
            <EmptyState
              icon="Gauge"
              title="Not enough closed deals yet to judge the model"
              description={`Calibration needs a body of decided, AI-scored deals to compare predictions against outcomes. So far there are ${number(
                cal.n,
              )} (${number(cal.won)} won, ${number(cal.lost)} lost) — the reliability read unlocks at ${SAMPLE_FLOOR}.`}
            />
          </div>
        ) : (
          <>
            <Headline cal={cal} />
            <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
              <ReliabilityCard buckets={cal.buckets} />
              <ThresholdCard cal={cal} />
            </div>
            <PerCloserCard cal={cal} />
          </>
        )}
      </div>
    </>
  )
}

function HonestyNote() {
  return (
    <div className="bg-surface-sunk text-muted-foreground flex items-start gap-2 rounded-lg border px-4 py-3 text-xs">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <p>
        There is no historical score archive. Each deal is judged on the{' '}
        <span className="text-foreground font-medium">last score it carried</span> before it closed —
        scoring stops at terminal stages, so this is the model&rsquo;s belief near close, a reasonable
        proxy rather than a frozen first-touch prediction. Read every number here as a lower bound on
        trust.
      </p>
    </div>
  )
}

function Headline({ cal }: { cal: CalibrationResult }) {
  const { summary, brier } = cal
  return (
    <div className="bg-card shadow-e1 rounded-xl border p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Gauge className={cn('size-4', VERDICT_TONE[summary.verdict])} />
            <span
              className={cn(
                'inline-flex h-6 items-center rounded-full px-2.5 text-sm font-semibold',
                VERDICT_BADGE[summary.verdict],
              )}
            >
              {VERDICT_LABEL[summary.verdict]}
            </span>
          </div>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            {verdictNarrative(summary.verdict, summary.averageGap)}
          </p>
        </div>
      </div>

      <StatGrid className="mt-4">
        <StatTile
          label="Brier score"
          value={brier === null ? '—' : brier.toFixed(3)}
          hint="0 perfect · 0.25 coin-flip · lower is better"
        />
        <StatTile
          label="Model says (avg)"
          value={summary.meanPredicted === null ? '—' : percent(summary.meanPredicted, 1)}
          hint="mean predicted close probability"
        />
        <StatTile
          label="Reality (win rate)"
          value={summary.meanActual === null ? '—' : percent(summary.meanActual, 1)}
          hint="actual share that closed won"
        />
        <StatTile
          label="Sample"
          value={number(cal.n)}
          hint="decided, scored deals"
          sample={`${number(cal.won)} won · ${number(cal.lost)} lost`}
        />
      </StatGrid>
    </div>
  )
}

/**
 * Reliability read: an inline-SVG diagram plotting predicted (x) against actual
 * (y) per bin with the diagonal "perfect calibration" reference, then the same
 * bins as paired predicted-vs-actual bars for the exact numbers.
 */
function ReliabilityCard({ buckets }: { buckets: CalBucket[] }) {
  const filled = buckets.filter((b) => b.n > 0)
  const maxN = Math.max(1, ...filled.map((b) => b.n))

  // SVG geometry in a 0-100 data space with padding.
  const S = 240
  const pad = 28
  const x = (p: number) => pad + (p / 100) * (S - 2 * pad)
  const y = (a: number) => S - pad - (a / 100) * (S - 2 * pad)

  return (
    <div className="bg-card shadow-e1 self-start rounded-xl border">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Reliability by score band</h2>
        <p className="text-muted-foreground text-xs">
          On the diagonal, a score of X% closes X% of the time. Dots above the line beat their score;
          below, they fall short. Dot size scales with the number of deals.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 p-4">
        <svg
          viewBox={`0 0 ${S} ${S}`}
          className="h-[240px] w-[240px] shrink-0"
          role="img"
          aria-label="Reliability diagram: predicted probability versus actual close rate"
        >
          {/* frame */}
          <rect
            x={pad}
            y={pad}
            width={S - 2 * pad}
            height={S - 2 * pad}
            className="fill-transparent stroke-current text-muted-foreground/30"
            strokeWidth={1}
          />
          {/* gridlines at 25/50/75 */}
          {[25, 50, 75].map((g) => (
            <g key={g} className="text-muted-foreground/20">
              <line x1={x(g)} y1={pad} x2={x(g)} y2={S - pad} stroke="currentColor" strokeWidth={0.5} />
              <line x1={pad} y1={y(g)} x2={S - pad} y2={y(g)} stroke="currentColor" strokeWidth={0.5} />
            </g>
          ))}
          {/* perfect-calibration diagonal */}
          <line
            x1={x(0)}
            y1={y(0)}
            x2={x(100)}
            y2={y(100)}
            className="text-muted-foreground"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeDasharray="4 3"
          />
          {/* connecting path through filled bins */}
          {filled.length > 1 && (
            <polyline
              points={filled.map((b) => `${x(b.predicted!)},${y(b.actual!)}`).join(' ')}
              className="text-primary"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.25}
              strokeOpacity={0.4}
            />
          )}
          {/* per-bin dots */}
          {filled.map((b) => (
            <circle
              key={b.label}
              cx={x(b.predicted!)}
              cy={y(b.actual!)}
              r={4 + (b.n / maxN) * 6}
              className={cn(gapTone(b.gap), 'fill-current')}
              fillOpacity={0.65}
              stroke="currentColor"
              strokeWidth={1}
            >
              <title>{`${b.label}: predicted ${b.predicted}%, actual ${b.actual}% (n=${b.n})`}</title>
            </circle>
          ))}
          {/* axis labels */}
          <text x={S / 2} y={S - 6} textAnchor="middle" className="fill-current text-muted-foreground" fontSize={9}>
            Predicted %
          </text>
          <text
            x={10}
            y={S / 2}
            textAnchor="middle"
            transform={`rotate(-90 10 ${S / 2})`}
            className="fill-current text-muted-foreground"
            fontSize={9}
          >
            Actual %
          </text>
        </svg>

        {/* paired bars for exact numbers */}
        <ol className="min-w-[15rem] flex-1 space-y-2">
          {buckets.map((b) => (
            <li key={b.label} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium tabular-nums">{b.label}%</span>
                <span className="text-muted-foreground tabular-nums">
                  {b.n === 0 ? 'no deals' : `n=${b.n}`}
                  {b.gap !== null && (
                    <span className={cn('ml-2 font-medium', gapTone(b.gap))}>
                      {b.gap > 0 ? '+' : ''}
                      {b.gap} pt
                    </span>
                  )}
                </span>
              </div>
              {b.n > 0 && (
                <div className="mt-1 space-y-1">
                  <Bar label="predicted" value={b.predicted!} tone="bg-muted-foreground/50" />
                  <Bar label="actual" value={b.actual!} tone={barTone(b.gap)} />
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function Bar({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-16 shrink-0 text-[0.625rem] uppercase">{label}</span>
      <div className="bg-muted h-2 flex-1 overflow-hidden rounded-[3px]">
        <div className={cn('h-full rounded-[3px]', tone)} style={{ width: `${Math.max(value, 1)}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right tabular-nums">{Math.round(value)}%</span>
    </div>
  )
}

function ThresholdCard({ cal }: { cal: CalibrationResult }) {
  const t = cal.threshold
  return (
    <div className="bg-card shadow-e1 self-start rounded-xl border">
      <div className="border-b px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Target className="text-primary size-3.5" /> Hot-lead cut check
        </h2>
        <p className="text-muted-foreground text-xs">
          Does the {t.currentThreshold}% threshold pick leads that actually close?
        </p>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-stretch gap-3">
          <div className="bg-surface-sunk flex-1 rounded-lg border p-3">
            <p className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
              Current cut
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{t.currentThreshold}%</p>
            <p className="text-muted-foreground mt-1 text-xs">
              closes{' '}
              <span
                className={cn(
                  'font-medium',
                  t.currentIsHonest === null
                    ? 'text-muted-foreground'
                    : t.currentIsHonest
                      ? 'text-success'
                      : 'text-danger',
                )}
              >
                {t.currentActualPct === null ? 'no data' : percent(t.currentActualPct, 0)}
              </span>{' '}
              {t.currentCohortN > 0 && <span className="tabular-nums">· n={t.currentCohortN}</span>}
            </p>
          </div>
          <div className="bg-surface-sunk flex-1 rounded-lg border p-3">
            <p className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
              Data-backed cut
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {t.suggestedThreshold === null ? '—' : `${t.suggestedThreshold}%`}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              {t.suggestedThreshold === null ? (
                'no trustworthy cut'
              ) : (
                <>
                  closes{' '}
                  <span className="text-success font-medium">{percent(t.suggestedActualPct ?? 0, 0)}</span>{' '}
                  <span className="tabular-nums">· n={t.suggestedCohortN}</span>
                </>
              )}
            </p>
          </div>
        </div>
        <p className="text-sm leading-relaxed">{t.rationale}</p>
        <p className="text-muted-foreground text-xs">
          &ldquo;Honest&rdquo; means leads at or above the cut close at least as often as the number
          claims — a threshold you can quote to a closer without overselling it.
        </p>
      </div>
    </div>
  )
}

function PerCloserCard({ cal }: { cal: CalibrationResult }) {
  return (
    <div className="bg-card shadow-e1 rounded-xl border">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Who the AI reads well</h2>
        <p className="text-muted-foreground text-xs">
          Per-closer calibration on their own decided deals. A low Brier and a small gap mean the score
          can be trusted on that book; needs {' '}
          <span className="tabular-nums">8+</span> decided deals to judge.
        </p>
      </div>
      <div className="scroll-x">
        <table className="w-full min-w-[34rem] text-sm tabular-nums">
          <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Closer</th>
              <th className="px-4 py-2 text-right">Decided</th>
              <th className="px-4 py-2 text-right">Brier</th>
              <th className="px-4 py-2 text-right">Gap</th>
              <th className="px-4 py-2 text-right">Read</th>
            </tr>
          </thead>
          <tbody>
            {cal.perCloser.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground px-4 py-8 text-center">
                  No closers with decided, scored deals in scope yet.
                </td>
              </tr>
            ) : (
              cal.perCloser.map((c) => (
                <tr key={c.ownerId} className="hover:bg-muted/40 border-b transition-colors last:border-0">
                  <td className="px-4 py-2.5 font-medium">{c.name}</td>
                  <td className="px-4 py-2.5 text-right">{number(c.n)}</td>
                  <td className="px-4 py-2.5 text-right">
                    {c.enoughData && c.brier !== null ? (
                      c.brier.toFixed(3)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className={cn('px-4 py-2.5 text-right', gapTone(c.gap))}>
                    {c.enoughData && c.gap !== null ? (
                      <>
                        {c.gap > 0 ? '+' : ''}
                        {c.gap} pt
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {c.enoughData ? (
                      <span
                        className={cn(
                          'inline-flex h-5 items-center rounded-full px-2 text-xs font-medium',
                          VERDICT_BADGE[c.verdict],
                        )}
                      >
                        {VERDICT_LABEL[c.verdict]}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">not enough data</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
