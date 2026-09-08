import Link from 'next/link'
import { ArrowRight, Info, Radio } from 'lucide-react'
import type { InboundCategory } from '@prisma/client'
import { requirePermissionPage } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { StatTile, StatGrid } from '@/components/stat-tile'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  getInboundDocuments,
  getInboundStats,
  getInboundStream,
  type StreamFilters,
} from '@/lib/inbound/queries'
import {
  CategoryPill,
  ConnectorChip,
  DocStatusPill,
  INBOUND_CATEGORIES,
  categoryLabel,
} from './pills'
import { InboundFilters } from './inbound-filters'
import { DocumentSearch } from './document-search'

export const metadata = { title: 'Inbound' }

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function isCategory(value: string | undefined): value is InboundCategory {
  return !!value && (INBOUND_CATEGORIES as string[]).includes(value)
}

export default async function InboundPage({ searchParams }: PageProps<'/inbound'>) {
  const user = await requirePermissionPage('connectors:read')
  const params = await searchParams

  const view = first(params.view) === 'documents' ? 'documents' : 'stream'
  const stats = await getInboundStats(user)

  const connectorOptions = stats.connectors.map((c) => ({
    value: c.sourceId,
    label: `${c.name} (${c.count.toLocaleString()})`,
  }))

  return (
    <>
      <PageHeader
        title="Inbound"
        description="Everything the GoHighLevel / CYS connector sends — new contacts, documents, doc-status changes and pipeline moves — classified into one organized feed."
      >
        <div className="mt-4">
          <StatGrid>
            <StatTile label="Events today" value={stats.today.toLocaleString()} hint="since midnight" />
            <StatTile
              label="Unmatched"
              value={stats.unmatched.toLocaleString()}
              hint="no client link yet"
            />
            <StatTile label="Total received" value={stats.total.toLocaleString()} hint="all time" />
            <StatTile
              label="Active connectors"
              value={stats.connectors.length.toLocaleString()}
              hint="sending data"
            />
          </StatGrid>

          {stats.todayByCategory.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground text-xs">Today:</span>
              {stats.todayByCategory.map((g) => (
                <Link
                  key={g.category}
                  href={`/inbound?category=${g.category}`}
                  className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors hover:bg-muted"
                >
                  <CategoryPill category={g.category} className="border-0 bg-transparent px-0 dark:bg-transparent" />
                  <span className="tabular-nums font-medium">{g.count.toLocaleString()}</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Segmented view switch */}
        <div className="border-border/60 mt-5 flex gap-4 border-b text-sm">
          <ViewTab href="/inbound" label="Stream" active={view === 'stream'} />
          <ViewTab href="/inbound?view=documents" label="Documents" active={view === 'documents'} />
        </div>
      </PageHeader>

      {stats.total === 0 ? (
        <EmptyState
          icon="Radio"
          title="Nothing has arrived yet"
          description="Connect GoHighLevel (or any inbound source) under Setup → Connectors. As events flow in, they'll be classified and organized here."
          action={
            <Link
              href="/settings/connectors"
              className="bg-foreground text-background inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium"
            >
              <Radio className="size-4" />
              Set up a connector
            </Link>
          }
        />
      ) : view === 'documents' ? (
        <DocumentsView user={user} params={params} />
      ) : (
        <StreamView user={user} params={params} connectorOptions={connectorOptions} />
      )}
    </>
  )
}

function ViewTab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        '-mb-px border-b-2 px-0.5 pb-2 font-medium transition-colors',
        active
          ? 'border-foreground text-foreground'
          : 'text-muted-foreground border-transparent hover:text-foreground',
      )}
    >
      {label}
    </Link>
  )
}

type Params = Awaited<PageProps<'/inbound'>['searchParams']>

async function StreamView({
  user,
  params,
  connectorOptions,
}: {
  user: Awaited<ReturnType<typeof requirePermissionPage>>
  params: Params
  connectorOptions: { value: string; label: string }[]
}) {
  const categoryParam = first(params.category)
  const filters: StreamFilters = {
    category: isCategory(categoryParam) ? categoryParam : undefined,
    sourceId: first(params.source),
    search: first(params.search),
    since: first(params.since),
    until: first(params.until),
    page: Number(first(params.page)) || 1,
  }

  const { rows, page, total, totalPages } = await getInboundStream(user, filters)

  // Preserve current filters across pagination links.
  const base = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    const val = first(v)
    if (val && k !== 'page') base.set(k, val)
  }
  const pageHref = (n: number) => {
    const qs = new URLSearchParams(base)
    qs.set('page', String(n))
    return `/inbound?${qs}`
  }

  return (
    <div className="p-4 sm:p-6">
      <InboundFilters
        categories={INBOUND_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
        connectors={connectorOptions}
      />

      {rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon="SearchX"
            title="No events match these filters"
            description="Try widening the date range, clearing the search, or switching category."
          />
        </div>
      ) : (
        <>
          <div className="scroll-x mt-4 rounded-lg border">
            <table className="w-full min-w-[64rem] text-sm">
              <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Category</th>
                  <th className="px-4 py-2 text-left">Summary</th>
                  <th className="px-4 py-2 text-left">Connector</th>
                  <th className="px-4 py-2 text-left">Client</th>
                  <th className="px-4 py-2 text-right">When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/40 border-b transition-colors last:border-0">
                    <td className="px-4 py-2.5 align-top">
                      <CategoryPill category={row.category} />
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <Link href={`/inbound/${row.id}`} className="font-medium hover:underline">
                        {row.summary}
                      </Link>
                      <div className="text-muted-foreground mt-0.5 font-mono text-[0.6875rem]">
                        {row.eventType}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <ConnectorChip glyph={row.connector.glyph} name={row.connector.name} accent={row.connector.accent} />
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      {row.clientName ? (
                        <Link href={`/clients/${row.clientId}`} className="font-medium hover:underline">
                          {row.clientName}
                        </Link>
                      ) : row.clientHidden ? (
                        <span className="text-muted-foreground text-xs">Matched · out of scope</span>
                      ) : (
                        <span className="bg-amber-500/10 text-amber-700 dark:text-amber-400 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium">
                          Unmatched
                        </span>
                      )}
                    </td>
                    <td className="text-muted-foreground px-4 py-2.5 text-right align-top text-xs whitespace-nowrap tabular-nums">
                      {relativeTime(row.occurredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="text-muted-foreground mt-3 flex items-center justify-between text-xs">
            <span className="tabular-nums">
              {total.toLocaleString()} event{total === 1 ? '' : 's'} · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              {page > 1 && (
                <Link href={pageHref(page - 1)} className="hover:bg-muted rounded-md border px-2.5 py-1">
                  Previous
                </Link>
              )}
              {page < totalPages && (
                <Link
                  href={pageHref(page + 1)}
                  className="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-2.5 py-1"
                >
                  Next <ArrowRight className="size-3" />
                </Link>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

async function DocumentsView({
  user,
  params,
}: {
  user: Awaited<ReturnType<typeof requirePermissionPage>>
  params: Params
}) {
  const status = first(params.status)
  const search = first(params.search)
  const docs = await getInboundDocuments(user, { status, search })

  // Status filter chips are derived from what's actually present, plus the
  // selected one (so a filtered-to-empty status still shows as active).
  const presentStatuses = [...new Set(docs.map((d) => d.status.trim().toLowerCase()))]
  const chipStatuses = [...new Set([...(status ? [status.toLowerCase()] : []), ...presentStatuses])].sort()

  return (
    <div className="p-4 sm:p-6">
      <Alert>
        <Info />
        <AlertTitle>CYS document status feed</AlertTitle>
        <AlertDescription>
          Documents and their latest status as reported by the connector. Statuses are free-form —
          coloring is best-effort.
        </AlertDescription>
      </Alert>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <DocumentSearch />
        <div className="flex flex-wrap gap-1.5">
          <Link
            href="/inbound?view=documents"
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs',
              !status ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            All
          </Link>
          {chipStatuses.map((s) => (
            <Link
              key={s}
              href={`/inbound?view=documents&status=${encodeURIComponent(s)}`}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs capitalize',
                status?.toLowerCase() === s
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {s.replace(/[_-]+/g, ' ')}
            </Link>
          ))}
        </div>
      </div>

      {docs.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon="FileText"
            title={status ? 'No documents with this status' : 'No documents received yet'}
            description="Document-status events from the connector will appear here as they arrive."
          />
        </div>
      ) : (
        <div className="scroll-x mt-4 rounded-lg border">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Client</th>
                <th className="px-4 py-2 text-left">Document</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Source</th>
                <th className="px-4 py-2 text-right">Received</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id} className="hover:bg-muted/40 border-b transition-colors last:border-0">
                  <td className="px-4 py-2.5 align-top">
                    {doc.clientName ? (
                      <Link href={`/clients/${doc.clientId}`} className="font-medium hover:underline">
                        {doc.clientName}
                      </Link>
                    ) : doc.clientHidden ? (
                      <span className="text-muted-foreground text-xs">Matched · out of scope</span>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    <span className="font-medium">{doc.name}</span>
                    {doc.note && (
                      <div className="text-muted-foreground mt-0.5 max-w-md truncate text-xs">{doc.note}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    <DocStatusPill status={doc.status} />
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    {doc.connector ? (
                      <ConnectorChip glyph={doc.connector.glyph} name={doc.connector.name} accent={doc.connector.accent} />
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                  <td className="text-muted-foreground px-4 py-2.5 text-right align-top text-xs whitespace-nowrap tabular-nums">
                    {relativeTime(doc.receivedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
