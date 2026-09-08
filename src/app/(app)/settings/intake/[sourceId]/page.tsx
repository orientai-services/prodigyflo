import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { can, requirePermissionPage } from '@/lib/rbac'
import { sheetsProviderKind } from '@/lib/intake/sheets'
import { PageHeader } from '@/components/page-header'
import { SubmissionsTable, type SubmissionRow } from '../submissions-table'
import { SourceSettings } from './source-settings'

export const metadata = { title: 'Intake source' }

export default async function IntakeSourcePage({ params }: PageProps<'/settings/intake/[sourceId]'>) {
  const user = await requirePermissionPage('connectors:read')
  const { sourceId } = await params

  const source = await db.intakeSource.findFirst({
    where: { id: sourceId, organizationId: user.organizationId },
  })
  if (!source) notFound()

  const [submissions, owners, leadSources] = await Promise.all([
    db.intakeSubmission.findMany({
      where: { sourceId: source.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { client: { select: { id: true, firstName: true, lastName: true } } },
    }),
    db.user.findMany({
      where: { organizationId: user.organizationId, deletedAt: null, isActive: true, role: { key: { notIn: ['CLIENT'] } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.leadSource.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const rows: SubmissionRow[] = submissions.map((s) => ({
    id: s.id,
    sourceName: source.name,
    externalId: s.externalId,
    status: s.status,
    attemptCount: s.attemptCount,
    createdAt: s.createdAt.toISOString(),
    error: s.error,
    matchedOn: s.matchedOn,
    unmappedKeys: s.unmappedKeys,
    rawPayload: s.rawPayload as Record<string, unknown>,
    client: s.client ? { id: s.client.id, name: `${s.client.firstName} ${s.client.lastName}`.trim() } : null,
  }))

  return (
    <>
      <PageHeader title={source.name} description={`Intake source · /api/intake/${source.slug}`} />
      <div className="space-y-8 px-4 py-5 sm:px-6">
        <SourceSettings
          source={{
            id: source.id,
            kind: source.kind,
            name: source.name,
            slug: source.slug,
            isEnabled: source.isEnabled,
            fieldMapping: (source.fieldMapping ?? {}) as Record<string, string>,
            dedupeKeys: source.dedupeKeys,
            defaultOwnerId: source.defaultOwnerId,
            defaultLeadSourceId: source.defaultLeadSourceId,
            sheetId: source.sheetId,
            sheetTab: source.sheetTab,
            lastRowCursor: source.lastRowCursor,
            lastSyncAt: source.lastSyncAt?.toISOString() ?? null,
            lastSyncStatus: source.lastSyncStatus,
            lastError: source.lastError,
          }}
          owners={owners}
          leadSources={leadSources}
          canManage={can(user, 'connectors:manage')}
          sheetsMock={sheetsProviderKind() === 'mock'}
        />
        <section>
          <h2 className="mb-3 text-sm font-semibold">Recent submissions from this source</h2>
          <SubmissionsTable rows={rows} canManage={can(user, 'connectors:manage')} />
        </section>
      </div>
    </>
  )
}
