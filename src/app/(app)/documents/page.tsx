import type { DocumentStatus, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requirePermissionPage } from '@/lib/rbac'
import { documentScope } from '@/lib/storage/access'
import { signedDocumentFileUrl } from '@/lib/storage'
import { fullName, relativeTime } from '@/lib/format'
import { DocumentLabView, type DocumentLabRow } from './desk-documents'

export const metadata = { title: 'Document lab' }

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

  const rows: DocumentLabRow[] = await Promise.all(
    docs.map(async (doc) => {
      const extraction = doc.extractions[0]
      const fields = extraction?.fields ?? []
      const reviewed = fields.filter((f) => f.verification !== 'UNVERIFIED').length
      const conflicts = fields.filter((f) => f.conflictNote).length
      const fileUrl = await signedDocumentFileUrl(doc)
      return {
        id: doc.id,
        label: doc.label ?? doc.requirement?.name ?? doc.fileName ?? 'Document',
        sub: [
          `v${doc.version}`,
          doc.fileName,
          doc.collector ? `collector: ${doc.collector.name}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        clientId: doc.client.id,
        clientName: fullName(doc.client),
        status: doc.status,
        reviewed,
        fieldCount: fields.length,
        conflicts,
        provider: extraction?.provider ?? null,
        model: extraction?.model ?? null,
        extractionStatus: extraction && extraction.status !== 'COMPLETED' ? extraction.status : null,
        slaSince: doc.slaDueAt && doc.requestedAt ? doc.requestedAt.toISOString() : null,
        slaHours:
          doc.slaDueAt && doc.requestedAt
            ? (doc.slaDueAt.getTime() - doc.requestedAt.getTime()) / 3_600_000
            : null,
        activity: relativeTime(doc.receivedAt ?? doc.requestedAt),
        fileUrl,
        mimeType: doc.mimeType,
      }
    }),
  )

  return (
    <DocumentLabView
      filters={FILTERS.map((f) => ({
        key: f.key,
        href: f.key === 'queue' ? '/documents' : `/documents?filter=${f.key}`,
        label: f.label,
        count: countFor(f.statuses),
      }))}
      activeFilter={filter.key}
      stats={[
        { label: 'Awaiting review', value: String(countFor(['UNDER_REVIEW'])), hint: 'Extraction done, human pending' },
        { label: 'Missing information', value: String(countFor(['MISSING_INFORMATION'])), hint: 'Required fields unreadable or absent' },
        { label: 'Requested', value: String(countFor(['REQUESTED'])), hint: 'Waiting on an upload' },
        { label: 'Approved', value: String(countFor(['APPROVED'])), hint: 'Fully verified documents' },
      ]}
      rows={rows}
    />
  )
}
