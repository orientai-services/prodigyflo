import Link from 'next/link'
import { ArrowRight, PlugZap, Check } from 'lucide-react'
import { requireUser } from '@/lib/rbac'
import { listConnectorStatus, type ConnectorInstance, type ConnectorState } from '@/lib/connectors/provision'
import { relativeTime, number } from '@/lib/format'
import { cn } from '@/lib/utils'
import { RecCard } from '../../_components/ui'

export const metadata = { title: 'Sources' }

const STATE_META: Record<ConnectorState, { label: string; className: string }> = {
  connected: { label: 'Connected', className: 'bg-[var(--rec-primary-soft)] text-[var(--rec-primary-ink)]' },
  available: { label: 'Ready to connect', className: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  disabled: { label: 'Paused', className: 'bg-slate-500/10 text-slate-600 dark:text-slate-300' },
  error: { label: 'Needs attention', className: 'bg-rose-500/10 text-rose-700 dark:text-rose-300' },
  'coming-soon': { label: 'Coming soon', className: 'bg-slate-500/10 text-slate-500 dark:text-slate-400' },
}

// Connected first, then ready-to-connect, then the rest — GoHighLevel always
// floats to the top of its group since it is the source this audience cares about.
const STATE_RANK: Record<ConnectorState, number> = {
  connected: 0,
  error: 1,
  available: 2,
  disabled: 3,
  'coming-soon': 4,
}

function sortConnectors(list: ConnectorInstance[]): ConnectorInstance[] {
  return [...list].sort((a, b) => {
    if (STATE_RANK[a.state] !== STATE_RANK[b.state]) return STATE_RANK[a.state] - STATE_RANK[b.state]
    if (a.def.id === 'gohighlevel') return -1
    if (b.def.id === 'gohighlevel') return 1
    return a.def.name.localeCompare(b.def.name)
  })
}

export default async function RecoverySourcesPage() {
  const user = await requireUser()
  const connectors = sortConnectors(await listConnectorStatus(user))
  const connectedCount = connectors.filter((c) => c.state === 'connected').length

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--rec-text)]">Sources</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--rec-muted)]">
          Connect where your leads come from. Every source you link flows into your inbound feed and
          feeds the recovery pool automatically.
        </p>
      </section>

      <RecCard className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-center gap-3">
          <span className="inline-flex size-10 items-center justify-center rounded-xl bg-[var(--rec-primary-soft)] text-[var(--rec-primary-ink)]">
            <PlugZap className="size-5" />
          </span>
          <div>
            <div className="text-sm font-semibold text-[var(--rec-text)]">
              {connectedCount > 0
                ? `${number(connectedCount)} source${connectedCount === 1 ? '' : 's'} connected`
                : 'No sources connected yet'}
            </div>
            <p className="text-xs text-[var(--rec-muted)]">Add or manage a connection to start receiving leads.</p>
          </div>
        </div>
        <Link
          href="/settings/connectors"
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--rec-primary)] px-4 py-2 text-sm font-semibold text-[var(--rec-on-primary)] shadow-sm transition-colors hover:bg-[var(--rec-primary-strong)]"
        >
          Connect a source <ArrowRight className="size-4" />
        </Link>
      </RecCard>

      <div className="grid gap-3 sm:grid-cols-2">
        {connectors.map((c) => {
          const meta = STATE_META[c.state]
          const connectable = c.state !== 'coming-soon'
          return (
            <RecCard key={c.def.id} className="flex flex-col gap-3 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="inline-flex size-10 items-center justify-center rounded-xl text-lg"
                    style={{ backgroundColor: `${c.def.accent}1a` }}
                  >
                    {c.def.glyph}
                  </span>
                  <div>
                    <div className="flex items-center gap-1.5 font-medium text-[var(--rec-text)]">
                      {c.def.name}
                      {c.def.id === 'gohighlevel' && (
                        <span className="rounded-full bg-[var(--rec-primary-soft)] px-2 py-0.5 text-[0.625rem] font-semibold text-[var(--rec-primary-ink)] uppercase">
                          Recommended
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--rec-muted)]">{c.def.tagline}</p>
                  </div>
                </div>
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold',
                    meta.className,
                  )}
                >
                  {c.state === 'connected' && <Check className="size-3" />}
                  {meta.label}
                </span>
              </div>

              <div className="mt-auto flex items-center justify-between border-t border-[var(--rec-border)] pt-3 text-xs text-[var(--rec-muted)]">
                <span>
                  {c.state === 'connected' && c.health.lastAt
                    ? `Last activity ${relativeTime(c.health.lastAt)}`
                    : c.state === 'error'
                      ? (c.health.detail ?? 'Reconnect needed')
                      : c.state === 'coming-soon'
                        ? 'Available soon'
                        : 'Not connected'}
                  {typeof c.submissionCount === 'number' && c.submissionCount > 0
                    ? ` · ${number(c.submissionCount)} received`
                    : ''}
                </span>
                {connectable ? (
                  <Link
                    href="/settings/connectors"
                    className="inline-flex items-center gap-1 font-medium text-[var(--rec-primary-ink)] hover:underline"
                  >
                    {c.state === 'connected' ? 'Manage' : 'Connect'}
                    <ArrowRight className="size-3" />
                  </Link>
                ) : (
                  <span className="text-[var(--rec-muted)]">—</span>
                )}
              </div>
            </RecCard>
          )
        })}
      </div>
    </div>
  )
}
