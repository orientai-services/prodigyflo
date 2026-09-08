import Link from 'next/link'
import { ArrowRight, ArrowLeft, Search } from 'lucide-react'
import { requireUser } from '@/lib/rbac'
import {
  getRecoverableLeads,
  BUCKET_LABEL,
  type RecoveryBucket,
  type RecoveryFilters,
} from '@/lib/recovery'
import { currency, relativeTime, fullName } from '@/lib/format'
import { cn } from '@/lib/utils'
import { RecCard, BucketPill } from '../../_components/ui'
import { RecoverButton } from './recover-button'

export const metadata = { title: 'Recover' }

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

const BUCKETS: RecoveryBucket[] = ['lost', 'on_hold', 'dormant']
function isBucket(value: string | undefined): value is RecoveryBucket {
  return !!value && (BUCKETS as string[]).includes(value)
}

const TABS: { key: string; label: string; bucket?: RecoveryBucket }[] = [
  { key: 'all', label: 'All' },
  { key: 'lost', label: BUCKET_LABEL.lost, bucket: 'lost' },
  { key: 'on_hold', label: BUCKET_LABEL.on_hold, bucket: 'on_hold' },
  { key: 'dormant', label: BUCKET_LABEL.dormant, bucket: 'dormant' },
]

export default async function RecyclerPage({ searchParams }: PageProps<'/recovery/leads'>) {
  const user = await requireUser()
  const params = await searchParams

  const bucketParam = first(params.bucket)
  const bucket = isBucket(bucketParam) ? bucketParam : undefined
  const search = first(params.search)?.trim() || undefined
  const page = Number(first(params.page)) || 1

  const filters: RecoveryFilters = { bucket, search, page }
  const { rows, total, page: current, pageCount } = await getRecoverableLeads(user, filters)

  // Preserve bucket + search across pagination.
  const hrefFor = (over: Record<string, string | undefined>) => {
    const qs = new URLSearchParams()
    if (bucket) qs.set('bucket', bucket)
    if (search) qs.set('search', search)
    for (const [k, v] of Object.entries(over)) {
      if (v) qs.set(k, v)
      else qs.delete(k)
    }
    const s = qs.toString()
    return s ? `/recovery/leads?${s}` : '/recovery/leads'
  }

  const activeTab = bucket ?? 'all'

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--rec-text)]">The recycler</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--rec-muted)]">
          A worklist you clear. Each of these leads already came in and stalled — restart the ones worth
          another shot and they move straight back into your live follow-up queue.
        </p>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Bucket tabs */}
        <div className="scroll-x flex gap-1.5">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={t.bucket ? `/recovery/leads?bucket=${t.bucket}` : '/recovery/leads'}
              aria-current={activeTab === t.key ? 'page' : undefined}
              className={cn(
                'rounded-full px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
                activeTab === t.key
                  ? 'bg-[var(--rec-primary)] text-[var(--rec-on-primary)] shadow-sm'
                  : 'border border-[var(--rec-border)] text-[var(--rec-muted)] hover:bg-[var(--rec-primary-soft)] hover:text-[var(--rec-primary-ink)]',
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>

        {/* Search — native GET form, works without JS */}
        <form action="/recovery/leads" method="get" className="relative">
          {bucket && <input type="hidden" name="bucket" value={bucket} />}
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--rec-muted)]" />
          <input
            type="search"
            name="search"
            defaultValue={search ?? ''}
            placeholder="Search name, email, phone…"
            aria-label="Search recoverable leads"
            className="h-9 w-64 max-w-full rounded-full border border-[var(--rec-border)] bg-[var(--rec-surface)] pr-3 pl-9 text-sm text-[var(--rec-text)] outline-none placeholder:text-[var(--rec-muted)] focus:border-[var(--rec-primary-border)] focus:ring-2 focus:ring-[var(--rec-primary-soft)]"
          />
        </form>
      </div>

      <RecCard>
        {rows.length === 0 ? (
          <p className="px-5 py-16 text-center text-sm text-[var(--rec-muted)]">
            {search
              ? 'No recoverable leads match that search.'
              : 'No leads to recover yet — nice problem to have.'}
          </p>
        ) : (
          <div className="scroll-x">
            <table className="w-full min-w-[60rem] text-sm">
              <thead>
                <tr className="border-b border-[var(--rec-border)] text-left text-[0.6875rem] font-semibold tracking-[0.06em] text-[var(--rec-muted)] uppercase">
                  <th className="px-5 py-3">Lead</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Why it stalled</th>
                  <th className="px-5 py-3">Source</th>
                  <th className="px-5 py-3">Last activity</th>
                  <th className="px-5 py-3 text-right">Potential</th>
                  <th className="px-5 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((lead) => (
                  <tr
                    key={lead.id}
                    className="border-b border-[var(--rec-border)] transition-colors last:border-0 hover:bg-[var(--rec-surface-2)]"
                  >
                    <td className="px-5 py-3.5">
                      <div className="font-medium text-[var(--rec-text)]">{fullName(lead)}</div>
                      <div className="mt-0.5 text-xs text-[var(--rec-muted)]">
                        {lead.email || lead.phone || '—'}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <BucketPill bucket={lead.bucket} />
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="text-[var(--rec-text)]">{lead.reason ?? '—'}</span>
                      <div className="mt-0.5 text-xs text-[var(--rec-muted)]">{lead.stageName}</div>
                    </td>
                    <td className="px-5 py-3.5 text-[var(--rec-muted)]">{lead.source ?? '—'}</td>
                    <td className="px-5 py-3.5 whitespace-nowrap text-[var(--rec-muted)] tabular-nums">
                      {relativeTime(lead.lastActivityAt)}
                    </td>
                    <td className="px-5 py-3.5 text-right font-semibold tabular-nums text-[var(--rec-primary-ink)]">
                      {lead.estimatedValue === null ? (
                        <span className="font-normal text-[var(--rec-muted)]">—</span>
                      ) : (
                        currency(lead.estimatedValue)
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <RecoverButton clientId={lead.id} name={fullName(lead)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </RecCard>

      {rows.length > 0 && (
        <div className="flex items-center justify-between text-xs text-[var(--rec-muted)]">
          <span className="tabular-nums">
            {total.toLocaleString()} lead{total === 1 ? '' : 's'} to recover · page {current} of {pageCount}
          </span>
          <div className="flex gap-2">
            {current > 1 && (
              <Link
                href={hrefFor({ page: String(current - 1) })}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--rec-border)] px-3 py-1.5 hover:bg-[var(--rec-surface-2)]"
              >
                <ArrowLeft className="size-3.5" /> Previous
              </Link>
            )}
            {current < pageCount && (
              <Link
                href={hrefFor({ page: String(current + 1) })}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--rec-border)] px-3 py-1.5 hover:bg-[var(--rec-surface-2)]"
              >
                Next <ArrowRight className="size-3.5" />
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
