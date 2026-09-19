import Link from 'next/link'
import { Download, Plus, Upload } from 'lucide-react'
import type { Prisma, StageKey } from '@prisma/client'
import { db } from '@/lib/db'
import { can, clientScope, requireUser } from '@/lib/rbac'
import { DeskChrome } from '@/components/desk/desk-chrome'
import { StageBadge } from '@/components/stage-badge'
import { SlaIndicator } from '@/components/sla-indicator'
import { ClientFilters } from './client-filters'
import { BulkBar, BulkCheckbox, BulkProvider, BulkSelectAll, OwnerReassign } from './bulk-actions'
import { SavedFilters, type SavedFilterChip } from './saved-filters'
import { canDeleteSavedFilter, savedFilterVisibleWhere } from '@/lib/reporting'
import { fullName, relativeTime } from '@/lib/format'
import { listedMoney } from '@/lib/daily-desk-finance'
import { DEFAULT_STAGES } from '@/lib/pipeline'
import { scsReadiness, scsReadinessLabel } from '@/lib/intake/scs-readiness'

export const metadata = { title: 'Clients' }

const PAGE_SIZE = 40

const SORTS = {
  recent: { lastActivityAt: 'desc' },
  oldest: { lastActivityAt: 'asc' },
  value: { estimatedValue: 'desc' },
  name: { lastName: 'asc' },
  created: { createdAt: 'desc' },
} satisfies Record<string, Prisma.ClientOrderByWithRelationInput>

export type SortKey = keyof typeof SORTS

export default async function ClientsPage({ searchParams }: PageProps<'/clients'>) {
  const user = await requireUser()
  const params = await searchParams

  const str = (v: string | string[] | undefined) => (typeof v === 'string' && v ? v : undefined)
  const q = str(params.q)
  const stage = str(params.stage) as StageKey | undefined
  const ownerId = str(params.owner)
  const teamId = str(params.team)
  const status = str(params.status)
  const sort = (str(params.sort) as SortKey) ?? 'recent'
  const page = Math.max(1, Number(str(params.page) ?? 1) || 1)

  const filters: Prisma.ClientWhereInput[] = [clientScope(user)]
  if (q) {
    filters.push({
      OR: [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
      ],
    })
  }
  if (stage) filters.push({ currentStage: { key: stage } })
  if (ownerId) filters.push({ ownerId })
  if (teamId) filters.push({ teamId })
  if (status) filters.push({ status: status as never })

  const where: Prisma.ClientWhereInput = { AND: filters }

  const [clients, total, owners, teams, savedFilters] = await Promise.all([
    db.client.findMany({
      where,
      orderBy: SORTS[sort] ?? SORTS.recent,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        estimatedValue: true,
        stageEnteredAt: true,
        lastActivityAt: true,
        owner: { select: { id: true, name: true } },
        team: { select: { name: true } },
        currentStage: { select: { key: true, name: true, category: true, slaHours: true } },
        leadSource: { select: { name: true } },
        intakeSubmissions: {
          where: { source: { slug: 'scs-website' } },
          select: { id: true },
          take: 1,
        },
      },
    }),
    db.client.count({ where }),
    db.user.findMany({
      where: { organizationId: user.organizationId, role: { key: 'CLOSER' }, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.team.findMany({
      where: { organizationId: user.organizationId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.savedFilter.findMany({
      where: savedFilterVisibleWhere(user),
      include: { user: { select: { name: true } } },
      orderBy: [{ isShared: 'asc' }, { name: 'asc' }],
    }),
  ])

  const filterChips: SavedFilterChip[] = savedFilters.map((f) => ({
    id: f.id,
    name: f.name,
    params: (f.params ?? {}) as Record<string, string>,
    isShared: f.isShared,
    mine: f.userId === user.id,
    ownerName: f.user.name,
    canDelete: canDeleteSavedFilter(user, f),
  }))

  const canReassign = can(user, 'clients:reassign')
  const canBulkStage = can(user, 'clients:advance_stage')
  const canBulkNote = can(user, 'clients:update')
  const showBulk = canReassign || canBulkStage || canBulkNote
  const ownerOptions = owners.map((o) => ({ value: o.id, label: o.name }))
  const pageIds = clients.map((c) => c.id)
  const scsIds = clients.filter((c) => c.intakeSubmissions.length > 0).map((c) => c.id)
  const scsImports = scsIds.length
    ? await db.externalDocumentImport.findMany({
        where: { clientId: { in: scsIds } },
        select: { clientId: true, sourceDocumentType: true, status: true },
      })
    : []
  const importsByClient = new Map<string, typeof scsImports>()
  for (const row of scsImports) {
    const list = importsByClient.get(row.clientId) ?? []
    list.push(row)
    importsByClient.set(row.clientId, list)
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const exportHref = `/api/clients/export?${new URLSearchParams(
    Object.entries({ q, stage, owner: ownerId, team: teamId, status, sort }).filter(
      (e): e is [string, string] => Boolean(e[1]),
    ),
  )}`

  return (
    <DeskChrome
      title="Clients"
      description={`${total.toLocaleString()} record${total === 1 ? '' : 's'} you can see. Value never invents $0.`}
      actions={
        <>
          <a href={exportHref} className="desk-btn-secondary">
            <Download className="size-3.5" />
            Export CSV
          </a>
          {can(user, 'clients:create') && (
            <>
              <Link href="/clients/import" className="desk-btn-secondary">
                <Upload className="size-3.5" />
                Import CSV
              </Link>
              <Link href="/clients/new" className="btn-desk">
                <Plus className="size-3.5" />
                New client
              </Link>
            </>
          )}
        </>
      }
    >
      <ClientFilters
        stages={DEFAULT_STAGES.map((s) => ({ key: s.key, name: s.name }))}
        owners={owners}
        teams={teams}
        canFilterOwner={can(user, 'clients:read_team') || can(user, 'clients:read_all')}
      />
      <SavedFilters filters={filterChips} />

      {clients.length === 0 ? (
        <section className="desk-card desk-block">
          <p className="desk-empty">No clients match these filters. Clear search or widen stage and owner.</p>
        </section>
      ) : (
        <BulkProvider>
          <section className="desk-card desk-block">
            <div className="scroll-x">
              <table className="desk-table">
                <thead>
                  <tr>
                    {showBulk && (
                      <th>
                        <BulkSelectAll pageIds={pageIds} />
                      </th>
                    )}
                    <th>Client</th>
                    <th>Stage</th>
                    <th>In stage</th>
                    <th>Owner</th>
                    <th>Source</th>
                    <th>Value</th>
                    <th>Activity</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => {
                    const readiness = scsReadiness({
                      hasScsIntake: c.intakeSubmissions.length > 0,
                      imports: importsByClient.get(c.id) ?? [],
                    })
                    return (
                      <tr key={c.id}>
                        {showBulk && (
                          <td>
                            <BulkCheckbox id={c.id} name={fullName(c)} />
                          </td>
                        )}
                        <td>
                          <Link href={`/clients/${c.id}`}>{fullName(c)}</Link>
                          <div className="desk-muted" style={{ marginBottom: 0 }}>
                            {c.email}
                          </div>
                          {readiness && (
                            <div className="desk-muted" style={{ marginBottom: 0, letterSpacing: '0.06em', textTransform: 'uppercase', fontSize: 11 }}>
                              {scsReadinessLabel(readiness)}
                            </div>
                          )}
                        </td>
                        <td>
                          <StageBadge
                            stageKey={c.currentStage.key}
                            name={c.currentStage.name}
                            category={c.currentStage.category}
                          />
                        </td>
                        <td>
                          <SlaIndicator since={c.stageEnteredAt} slaHours={c.currentStage.slaHours} />
                        </td>
                        <td>
                          {canReassign ? (
                            <OwnerReassign clientId={c.id} ownerId={c.owner?.id ?? null} owners={ownerOptions} />
                          ) : (
                            (c.owner?.name ?? <span className="desk-muted">Unassigned</span>)
                          )}
                          {c.team && <div className="desk-muted" style={{ marginBottom: 0 }}>{c.team.name}</div>}
                        </td>
                        <td>{c.leadSource?.name ?? '—'}</td>
                        <td>{listedMoney(c.estimatedValue)}</td>
                        <td>{relativeTime(c.lastActivityAt)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {pageCount > 1 && (
            <nav className="desk-actions-row" style={{ justifyContent: 'space-between', marginTop: 12 }} aria-label="Pagination">
              <p className="desk-muted" style={{ marginBottom: 0 }}>
                Page {page} of {pageCount}
              </p>
              <div className="desk-actions-row">
                {page > 1 ? (
                  <Link
                    href={`/clients?${new URLSearchParams({ ...(params as Record<string, string>), page: String(page - 1) })}`}
                    className="desk-btn-secondary"
                  >
                    Previous
                  </Link>
                ) : (
                  <span className="desk-btn-secondary" style={{ opacity: 0.5 }}>Previous</span>
                )}
                {page < pageCount ? (
                  <Link
                    href={`/clients?${new URLSearchParams({ ...(params as Record<string, string>), page: String(page + 1) })}`}
                    className="desk-btn-secondary"
                  >
                    Next
                  </Link>
                ) : (
                  <span className="desk-btn-secondary" style={{ opacity: 0.5 }}>Next</span>
                )}
              </div>
            </nav>
          )}

          {showBulk && (
            <BulkBar
              stages={DEFAULT_STAGES.map((s) => ({ value: s.key, label: s.name }))}
              owners={ownerOptions}
              canChangeStage={canBulkStage}
              canReassign={canReassign}
              canNote={canBulkNote}
            />
          )}
        </BulkProvider>
      )}
    </DeskChrome>
  )
}
