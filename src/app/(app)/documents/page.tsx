import Link from 'next/link'
import type { DocumentStatus, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requirePermissionPage } from '@/lib/rbac'
import { documentScope } from '@/lib/storage/access'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { StatTile } from '@/components/stat-tile'
import { SlaIndicator } from '@/components/sla-indicator'
import { fullName, humanize, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DocumentStatusBadge, ProviderBadge } from './status-badge'

export const metadata = { title: 'Document review' }

const QUEUE_STATUSES: DocumentStatus[] = ['RECEIVED', 'PROCESSING', 'UNDER_REVIEW', 'MISSING_INFORMATION']

const FILTERS: { key: string; label: string; statuses: DocumentStatus[] }[] = [
  { key: 'queue', label: 'Needs attention', statuses: QUEUE_STATUSES },
  { key: 'review', label: 'Under review', statuses: ['UNDER_REVIEW'] },
  { key: 'missing', label: 'Missing info', statuses: ['MISSING_INFORMATION'] },
  { key: 'requested', label: 'Requested', statuses: ['REQUESTED'] },
  { key: 'approved', label: 'Approved', statuses: ['APPROVED'] },
  { key: 'rejected', label: 'Rejected', statuses: ['REJECTED'] },
]

export default async function DocumentsPage({ searchParams }: PageProps<'/documents'>) {
  const user = await requirePermissionPage('documents:review')
  const params = await searchParams
  const filterKey = typeof params.filter === 'string' ? params.filter : 'queue'
  const filter = FILTERS.find((f) => f.key === filterKey) ?? FILTERS[0]

  const scope = documentScope(user)
  const where: Prisma.ClientDocumentWhereInput = { AND: [scope, { status: { in: filter.statuses } }] }

  const [docs, counts] = await Promise.all([
    db.clientDocument.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { requestedAt: 'desc' }],
      take: 100,
      include: {
        client: { select: { id: true, firstName: true, lastName: true } },
        requirement: { select: { name: true, isRequired: true } },
        collector: { select: { name: true } },
        extractions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { fields: { select: { verification: true, confidence: true, value: true, conflictNote: true } } },
        },
      },
    }),
    db.clientDocument.groupBy({ by: ['status'], where: scope as Prisma.ClientDocumentWhereInput, _count: { _all: true } }),
  ])

  const countFor = (statuses: DocumentStatus[]) =>
    counts.filter((c) => statuses.includes(c.status)).reduce((sum, c) => sum + c._count._all, 0)

  return (
    <>
      <PageHeader
        title="Document review"
        description="Uploaded documents, their AI-extracted fields, and the human verification queue"
      >
        <div className="mt-4 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key === 'queue' ? '/documents' : `/documents?filter=${f.key}`}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                f.key === filter.key
                  ? 'bg-primary text-primary-foreground border-transparent'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {f.label}
              <span className="ml-1 tabular-nums opacity-70">{countFor(f.statuses)}</span>
            </Link>
          ))}
        </div>
      </PageHeader>

      <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-6 lg:grid-cols-4">
        <StatTile label="Awaiting review" value={String(countFor(['UNDER_REVIEW']))} hint="Extraction done, human pending" />
        <StatTile label="Missing information" value={String(countFor(['MISSING_INFORMATION']))} hint="Required fields unreadable or absent" />
        <StatTile label="Requested" value={String(countFor(['REQUESTED']))} hint="Waiting on an upload" />
        <StatTile label="Approved" value={String(countFor(['APPROVED']))} hint="Fully verified documents" />
      </div>

      {docs.length === 0 ? (
        <EmptyState
          icon="FileSearch"
          title={`No documents in “${filter.label}”`}
          description="Documents appear here as soon as they are uploaded against a client."
        />
      ) : (
        <div className="scroll-x">
          <table className="w-full min-w-[56rem] text-sm tabular-nums">
            <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
              <tr className="border-b">
                <th className="px-4 py-2 text-left">Document</th>
                <th className="px-4 py-2 text-left">Client</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Fields verified</th>
                <th className="px-4 py-2 text-left">Extraction</th>
                <th className="px-4 py-2 text-left">SLA</th>
                <th className="px-4 py-2 text-right">Activity</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => {
                const extraction = doc.extractions[0]
                const fields = extraction?.fields ?? []
                const reviewed = fields.filter((f) => f.verification !== 'UNVERIFIED').length
                const conflicts = fields.filter((f) => f.conflictNote).length
                return (
                  <tr key={doc.id} className="hover:bg-muted/40 border-b transition-colors">
                    <td className="px-4 py-2.5">
                      <Link href={`/documents/${doc.id}`} className="block">
                        <span className="font-medium">{doc.label ?? doc.requirement?.name ?? doc.fileName ?? 'Document'}</span>
                        <span className="text-muted-foreground block text-xs">
                          v{doc.version}
                          {doc.fileName ? ` · ${doc.fileName}` : ''}
                          {doc.collector ? ` · collector: ${doc.collector.name}` : ''}
                        </span>
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <Link href={`/clients/${doc.client.id}`} className="hover:underline">
                        {fullName(doc.client)}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <DocumentStatusBadge status={doc.status} />
                    </td>
                    <td className="px-4 py-2.5 text-xs tabular-nums">
                      {fields.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <>
                          {reviewed}/{fields.length}
                          {conflicts > 0 && (
                            <span className="text-orange-600 dark:text-orange-400"> · {conflicts} conflict{conflicts === 1 ? '' : 's'}</span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {extraction ? (
                        <div className="flex items-center gap-1.5">
                          <ProviderBadge provider={extraction.provider} model={extraction.model} />
                          {extraction.status !== 'COMPLETED' && (
                            <span className="text-muted-foreground text-xs">{humanize(extraction.status)}</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">Not run</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {doc.slaDueAt ? <SlaIndicator since={doc.requestedAt} slaHours={(doc.slaDueAt.getTime() - doc.requestedAt.getTime()) / 3_600_000} /> : <span className="text-muted-foreground text-xs">—</span>}
                    </td>
                    <td className="text-muted-foreground px-4 py-2.5 text-right text-xs whitespace-nowrap">
                      {relativeTime(doc.receivedAt ?? doc.requestedAt)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
