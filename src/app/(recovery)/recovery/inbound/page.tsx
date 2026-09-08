import Link from 'next/link'
import { ArrowRight, ArrowLeft, Radio } from 'lucide-react'
import type { InboundCategory } from '@prisma/client'
import { requireUser } from '@/lib/rbac'
import { getInboundStream, getInboundStats } from '@/lib/inbound/queries'
import { relativeTime } from '@/lib/format'
import { RecCard, SectionHead, RecPillLink } from '../../_components/ui'

export const metadata = { title: 'Inbound' }

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

const CATEGORY_META: Record<InboundCategory, { label: string; glyph: string }> = {
  CONTACT: { label: 'New contact', glyph: '👤' },
  DOCUMENT: { label: 'Document', glyph: '📄' },
  OPPORTUNITY: { label: 'Opportunity', glyph: '🎯' },
  NOTE: { label: 'Note', glyph: '📝' },
  APPOINTMENT: { label: 'Appointment', glyph: '📅' },
  OTHER: { label: 'Activity', glyph: '•' },
}

export default async function RecoveryInboundPage({ searchParams }: PageProps<'/recovery/inbound'>) {
  const user = await requireUser()
  const params = await searchParams
  const page = Number(first(params.page)) || 1

  const [stats, stream] = await Promise.all([
    getInboundStats(user),
    getInboundStream(user, { page }),
  ])

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--rec-text)]">Inbound</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--rec-muted)]">
          Here is what is coming in from your connected sources, in plain language. Contacts, documents,
          appointments and pipeline moves — all in one calm feed.
        </p>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Today', value: stats.today },
          { label: 'All time', value: stats.total },
          { label: 'Not yet matched', value: stats.unmatched },
          { label: 'Active sources', value: stats.connectors.length },
        ].map((s) => (
          <RecCard key={s.label} className="p-4">
            <div className="text-xs font-medium tracking-wide text-[var(--rec-muted)] uppercase">
              {s.label}
            </div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums text-[var(--rec-text)]">
              {s.value.toLocaleString()}
            </div>
          </RecCard>
        ))}
      </section>

      <RecCard>
        <SectionHead
          title="Latest activity"
          description="The most recent events from every source"
          action={
            <RecPillLink href="/recovery/sources">
              Manage sources <ArrowRight className="size-3.5" />
            </RecPillLink>
          }
        />
        {stream.rows.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <p className="text-sm font-medium text-[var(--rec-text)]">Nothing has arrived yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-[var(--rec-muted)]">
              Connect a source to start receiving leads and their activity will show up here.
            </p>
            <div className="mt-4 flex justify-center">
              <RecPillLink href="/recovery/sources">
                <Radio className="size-3.5" /> Connect a source
              </RecPillLink>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--rec-border)]">
            {stream.rows.map((row) => {
              const meta = CATEGORY_META[row.category]
              return (
                <li key={row.id} className="flex items-start gap-3 px-5 py-3.5">
                  <span
                    aria-hidden
                    className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--rec-primary-soft)] text-sm"
                  >
                    {meta.glyph}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-xs font-semibold text-[var(--rec-primary-ink)]">
                        {meta.label}
                      </span>
                      <span className="text-xs text-[var(--rec-muted)]">via {row.connector.name}</span>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-[var(--rec-text)]">{row.summary}</p>
                    {row.clientName && (
                      <p className="mt-0.5 truncate text-xs text-[var(--rec-muted)]">
                        Linked to {row.clientName}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs whitespace-nowrap text-[var(--rec-muted)] tabular-nums">
                    {relativeTime(row.occurredAt)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </RecCard>

      {stream.rows.length > 0 && (
        <div className="flex items-center justify-between text-xs text-[var(--rec-muted)]">
          <span className="tabular-nums">
            {stream.total.toLocaleString()} event{stream.total === 1 ? '' : 's'} · page {stream.page} of{' '}
            {stream.totalPages}
          </span>
          <div className="flex gap-2">
            {stream.page > 1 && (
              <Link
                href={`/recovery/inbound?page=${stream.page - 1}`}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--rec-border)] px-3 py-1.5 hover:bg-[var(--rec-surface-2)]"
              >
                <ArrowLeft className="size-3.5" /> Previous
              </Link>
            )}
            {stream.page < stream.totalPages && (
              <Link
                href={`/recovery/inbound?page=${stream.page + 1}`}
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
