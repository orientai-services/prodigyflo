import Link from 'next/link'
import { IntakeStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { can, requirePermissionPage } from '@/lib/rbac'
import { relativeTime } from '@/lib/format'
import { sheetsProviderKind } from '@/lib/intake/sheets'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NewSourceDialog } from './new-source-dialog'
import { SubmissionsTable, type SubmissionRow } from './submissions-table'

export const metadata = { title: 'Lead intake' }

const KIND_LABELS = { WEB_FORM: 'Web form', GOOGLE_SHEET: 'Google Sheet', CSV_IMPORT: 'CSV import', META_LEAD_ADS: 'Meta Lead Ads', GO_HIGH_LEVEL: 'GoHighLevel', GENERIC_WEBHOOK: 'Generic webhook', ZAPIER: 'Zapier' } as const

export default async function IntakeSettingsPage({ searchParams }: PageProps<'/settings/intake'>) {
  const user = await requirePermissionPage('connectors:read')
  const params = await searchParams
  const failedOnly = params.view === 'failures'
  const canManage = can(user, 'connectors:manage')

  const [sources, statusCounts, submissions, owners, leadSources] = await Promise.all([
    db.intakeSource.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'asc' },
      include: { defaultOwner: { select: { name: true } } },
    }),
    db.intakeSubmission.groupBy({
      by: ['sourceId', 'status'],
      where: { organizationId: user.organizationId },
      _count: { _all: true },
    }),
    db.intakeSubmission.findMany({
      where: {
        organizationId: user.organizationId,
        ...(failedOnly ? { status: { in: [IntakeStatus.FAILED, IntakeStatus.NEEDS_MAPPING] } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        source: { select: { name: true } },
        client: { select: { id: true, firstName: true, lastName: true } },
      },
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

  const countsBySource = new Map<string, { total: number; stuck: number }>()
  for (const row of statusCounts) {
    const entry = countsBySource.get(row.sourceId) ?? { total: 0, stuck: 0 }
    entry.total += row._count._all
    if (row.status === 'FAILED' || row.status === 'NEEDS_MAPPING') entry.stuck += row._count._all
    countsBySource.set(row.sourceId, entry)
  }

  const rows: SubmissionRow[] = submissions.map((s) => ({
    id: s.id,
    sourceName: s.source.name,
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
      <PageHeader
        title="Lead intake"
        description="Inbound forms, sheets and webhooks that create leads automatically."
        actions={canManage ? <NewSourceDialog owners={owners} leadSources={leadSources} /> : undefined}
      />

      <div className="space-y-8 px-4 py-5 sm:px-6">
        <section>
          <h2 className="mb-3 text-sm font-semibold">Sources</h2>
          {sources.length === 0 ? (
            <EmptyState
              icon="Webhook"
              title="No intake sources yet"
              description={
                canManage
                  ? 'Create a source to get a webhook URL and signing secret for your forms or sheets.'
                  : 'An administrator can create webhook and sheet sources here.'
              }
            />
          ) : (
            <div className="scroll-x">
              <table className="w-full min-w-[44rem] text-sm tabular-nums">
                <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <tr className="border-b">
                    <th className="px-4 py-2 text-left">Source</th>
                    <th className="px-4 py-2 text-left">Kind</th>
                    <th className="px-4 py-2 text-left">Endpoint</th>
                    <th className="px-4 py-2 text-left">Default owner</th>
                    <th className="px-4 py-2 text-left">Health</th>
                    <th className="px-4 py-2 text-right">Submissions</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => {
                    const counts = countsBySource.get(s.id) ?? { total: 0, stuck: 0 }
                    return (
                      <tr key={s.id} className="hover:bg-muted/40 border-b transition-colors">
                        <td className="px-4 py-2.5">
                          <Link href={`/settings/intake/${s.id}`} className="font-medium hover:underline">
                            {s.name}
                          </Link>
                          {!s.isEnabled && (
                            <Badge variant="outline" className="ml-2">
                              Disabled
                            </Badge>
                          )}
                        </td>
                        <td className="text-muted-foreground px-4 py-2.5">
                          {KIND_LABELS[s.kind]}
                          {s.kind === 'GOOGLE_SHEET' && sheetsProviderKind() === 'mock' && (
                            <Badge variant="secondary" className="ml-2">
                              Mock
                            </Badge>
                          )}
                        </td>
                        <td className="text-muted-foreground px-4 py-2.5 font-mono text-xs">/api/intake/{s.slug}</td>
                        <td className="text-muted-foreground px-4 py-2.5">
                          {s.defaultOwner?.name ?? <span className="italic">Unassigned</span>}
                        </td>
                        <td className="px-4 py-2.5">
                          {s.lastError ? (
                            <span className="text-destructive text-xs" title={s.lastError}>
                              Error {s.lastErrorAt ? relativeTime(s.lastErrorAt) : ''}
                            </span>
                          ) : counts.stuck > 0 ? (
                            <span className="text-xs text-amber-600 dark:text-amber-500">
                              {counts.stuck} stuck
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">
                              {s.lastSyncAt ? `Synced ${relativeTime(s.lastSyncAt)}` : 'Healthy'}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{counts.total}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent submissions</h2>
            <div className="flex gap-1">
              <Button variant={failedOnly ? 'ghost' : 'secondary'} size="xs" render={<Link href="/settings/intake" />}>
                All
              </Button>
              <Button
                variant={failedOnly ? 'secondary' : 'ghost'}
                size="xs"
                render={<Link href="/settings/intake?view=failures" />}
              >
                Failures
              </Button>
            </div>
          </div>
          <SubmissionsTable rows={rows} canManage={canManage} />
        </section>
      </div>
    </>
  )
}
