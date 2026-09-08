import { ArrowRight, TrendingUp, Wallet, RotateCcw, Sparkles, Radio } from 'lucide-react'
import { requireUser } from '@/lib/rbac'
import { getRecoverableLeads, getRecoveryMetrics, type RecoveryBucket } from '@/lib/recovery'
import { getInboundStats } from '@/lib/inbound/queries'
import { currency, number, relativeTime, fullName } from '@/lib/format'
import { RecCard, RecStat, BucketPill, SectionHead, RecPillLink } from '../_components/ui'

export const metadata = { title: 'Overview' }

const BUCKET_ORDER: RecoveryBucket[] = ['lost', 'on_hold', 'dormant']

export default async function RecoveryOverviewPage() {
  const user = await requireUser()
  const [metrics, preview, inbound] = await Promise.all([
    getRecoveryMetrics(user),
    getRecoverableLeads(user, { page: 1 }),
    getInboundStats(user),
  ])

  // A funnel from the numbers we can stand behind: leads that missed the finish
  // line, the slice still recoverable, and the slice already won back.
  const stalled = metrics.recoverable + metrics.recovered
  const funnel = [
    { key: 'stalled', label: "Didn't finish", value: stalled, tone: 'muted' as const },
    { key: 'recoverable', label: 'Recoverable now', value: metrics.recoverable, tone: 'primary' as const },
    { key: 'recovered', label: 'Recovered', value: metrics.recovered, tone: 'solid' as const },
  ]
  const funnelMax = Math.max(stalled, 1)
  const topLeads = preview.rows.slice(0, 5)

  return (
    <div className="space-y-8">
      <section>
        <p className="text-sm font-medium text-[var(--rec-primary-ink)]">Welcome back</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--rec-text)] sm:text-3xl">
          Recover the revenue you already paid to acquire
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--rec-muted)]">
          Every lead that stalled — lost, on hold, or gone quiet — is money already spent. Here is what
          is sitting on the table, and how much of it you have brought back.
        </p>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <RecStat
          label="Recoverable"
          value={number(metrics.recoverable)}
          hint="Leads ready to re-engage"
          accent
          icon={<RotateCcw className="size-4" />}
        />
        <RecStat
          label="On the table"
          value={currency(metrics.potentialValue, { compact: true })}
          hint="Potential value in the pool"
          icon={<Wallet className="size-4" />}
        />
        <RecStat
          label="Recovered"
          value={number(metrics.recovered)}
          hint={`${currency(metrics.recoveredValue, { compact: true })} brought back`}
          icon={<Sparkles className="size-4" />}
        />
        <RecStat
          label="Recovery rate"
          value={metrics.recoveryRatePct === null ? '—' : `${metrics.recoveryRatePct}%`}
          hint="Won back vs. still lost"
          icon={<TrendingUp className="size-4" />}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Funnel */}
        <RecCard className="lg:col-span-3">
          <SectionHead
            title="The recovery funnel"
            description="From the leads that missed the finish line to the ones you closed again"
          />
          <div className="space-y-4 p-5">
            {funnel.map((step) => {
              const pct = Math.round((step.value / funnelMax) * 100)
              return (
                <div key={step.key}>
                  <div className="mb-1.5 flex items-baseline justify-between text-sm">
                    <span className="font-medium text-[var(--rec-text)]">{step.label}</span>
                    <span className="font-semibold tabular-nums text-[var(--rec-text)]">
                      {number(step.value)}
                    </span>
                  </div>
                  <div className="h-3 w-full overflow-hidden rounded-full bg-[var(--rec-surface-2)] ring-1 ring-inset ring-[var(--rec-border)]">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(pct, step.value > 0 ? 6 : 0)}%`,
                        background:
                          step.tone === 'solid'
                            ? 'var(--rec-primary-strong)'
                            : step.tone === 'primary'
                              ? 'var(--rec-primary)'
                              : 'color-mix(in srgb, var(--rec-primary) 32%, transparent)',
                      }}
                    />
                  </div>
                </div>
              )
            })}
            <div className="flex flex-wrap gap-2 pt-1">
              {BUCKET_ORDER.map((b) => (
                <span
                  key={b}
                  className="inline-flex items-center gap-1.5 text-xs text-[var(--rec-muted)]"
                >
                  <BucketPill bucket={b} />
                  <span className="tabular-nums font-medium text-[var(--rec-text)]">
                    {number(metrics.byBucket[b])}
                  </span>
                </span>
              ))}
            </div>
          </div>
        </RecCard>

        {/* Top loss reasons */}
        <RecCard className="lg:col-span-2">
          <SectionHead title="Why leads stall" description="Top reasons across lost deals" />
          <div className="p-5">
            {metrics.topReasons.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--rec-muted)]">
                No loss reasons recorded yet — nothing to learn from, which is a good problem to have.
              </p>
            ) : (
              <ul className="space-y-3">
                {metrics.topReasons.map((r) => {
                  const max = metrics.topReasons[0].count || 1
                  return (
                    <li key={r.reason}>
                      <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                        <span className="truncate text-[var(--rec-text)]">{r.reason}</span>
                        <span className="shrink-0 font-semibold tabular-nums text-[var(--rec-muted)]">
                          {number(r.count)}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--rec-surface-2)]">
                        <div
                          className="h-full rounded-full bg-[var(--rec-primary)]"
                          style={{ width: `${Math.max(Math.round((r.count / max) * 100), 8)}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </RecCard>
      </div>

      {/* Top recoverable leads preview */}
      <RecCard>
        <SectionHead
          title="Top leads to recover"
          description="Highest potential value first — start with these"
          action={
            <RecPillLink href="/recovery/leads">
              Open the recycler <ArrowRight className="size-3.5" />
            </RecPillLink>
          }
        />
        {topLeads.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-[var(--rec-muted)]">
            No leads to recover yet — nice problem to have.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--rec-border)]">
            {topLeads.map((lead) => (
              <li
                key={lead.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-[var(--rec-text)]">{fullName(lead)}</span>
                    <BucketPill bucket={lead.bucket} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[var(--rec-muted)]">
                    {lead.reason ?? 'No reason on file'}
                    {lead.source ? ` · ${lead.source}` : ''} · {relativeTime(lead.lastActivityAt)}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--rec-primary-ink)]">
                  {lead.estimatedValue === null ? '—' : currency(lead.estimatedValue)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </RecCard>

      {/* Inbound peek */}
      <RecCard>
        <SectionHead
          title="Coming in from your sources"
          description="A quick pulse on new activity"
          action={
            <RecPillLink href="/recovery/inbound">
              View inbound <ArrowRight className="size-3.5" />
            </RecPillLink>
          }
        />
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-b-2xl bg-[var(--rec-border)] sm:grid-cols-4">
          {[
            { label: 'Today', value: number(inbound.today) },
            { label: 'All time', value: number(inbound.total) },
            { label: 'Unmatched', value: number(inbound.unmatched) },
            { label: 'Active sources', value: number(inbound.connectors.length) },
          ].map((s) => (
            <div key={s.label} className="bg-[var(--rec-surface)] px-5 py-4">
              <div className="flex items-center gap-1.5 text-xs text-[var(--rec-muted)]">
                <Radio className="size-3.5" />
                {s.label}
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-[var(--rec-text)]">
                {s.value}
              </div>
            </div>
          ))}
        </div>
      </RecCard>
    </div>
  )
}
