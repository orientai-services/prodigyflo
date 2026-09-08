import Link from 'next/link'
import { Download, Plus, Upload } from 'lucide-react'
import type { Prisma, StageKey } from '@prisma/client'
import { db } from '@/lib/db'
import { can, clientScope, requireUser } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { StageBadge } from '@/components/stage-badge'
import { SlaIndicator } from '@/components/sla-indicator'
import { EmptyState } from '@/components/empty-state'
import { ClientFilters } from './client-filters'
import { BulkBar, BulkCheckbox, BulkProvider, BulkSelectAll, OwnerReassign } from './bulk-actions'
import { SavedFilters, type SavedFilterChip } from './saved-filters'
import { canDeleteSavedFilter, savedFilterVisibleWhere } from '@/lib/reporting'
import { currency, fullName, relativeTime } from '@/lib/format'
import { DEFAULT_STAGES } from '@/lib/pipeline'

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

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const exportHref = `/api/clients/export?${new URLSearchParams(
    Object.entries({ q, stage, owner: ownerId, team: teamId, status, sort }).filter(
      (e): e is [string, string] => Boolean(e[1]),
    ),
  )}`

  return (
    <>
      <PageHeader
        title="Clients"
        description={`${total.toLocaleString()} record${total === 1 ? '' : 's'} you can see`}
        actions={
          <>
            <Button variant="outline" size="sm" render={<a href={exportHref} />}>
              <Download className="size-3.5" />
              Export CSV
            </Button>
            {can(user, 'clients:create') && (
              <>
                <Button variant="outline" size="sm" render={<Link href="/clients/import" />}>
                  <Upload className="size-3.5" />
                  Import CSV
                </Button>
                <Button size="sm" render={<Link href="/clients/new" />}>
                  <Plus className="size-3.5" />
                  New client
                </Button>
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
      </PageHeader>

      {clients.length === 0 ? (
        <EmptyState
          icon="Users"
          title="No clients match these filters"
          description="Try clearing the search or widening the stage and owner filters."
        />
      ) : (
        <BulkProvider>
          <div className="scroll-x">
            <table className="w-full min-w-[52rem] text-sm tabular-nums">
              <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                <tr className="border-b">
                  {showBulk && (
                    <th className="w-8 px-4 py-2 text-left">
                      <BulkSelectAll pageIds={pageIds} />
                    </th>
                  )}
                  <th className="px-4 py-2 text-left">Client</th>
                  <th className="px-4 py-2 text-left">Stage</th>
                  <th className="px-4 py-2 text-left">In stage</th>
                  <th className="px-4 py-2 text-left">Owner</th>
                  <th className="px-4 py-2 text-left">Source</th>
                  <th className="px-4 py-2 text-right">Value</th>
                  <th className="px-4 py-2 text-right">Activity</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/40 border-b transition-colors">
                    {showBulk && (
                      <td className="px-4 py-2.5">
                        <BulkCheckbox id={c.id} name={fullName(c)} />
                      </td>
                    )}
                    <td className="px-4 py-2.5">
                      <Link href={`/clients/${c.id}`} className="block">
                        <span className="font-medium">{fullName(c)}</span>
                        <span className="text-muted-foreground block truncate text-xs">{c.email}</span>
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <StageBadge
                        stageKey={c.currentStage.key}
                        name={c.currentStage.name}
                        category={c.currentStage.category}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <SlaIndicator since={c.stageEnteredAt} slaHours={c.currentStage.slaHours} />
                    </td>
                    <td className="text-muted-foreground px-4 py-2.5">
                      {canReassign ? (
                        <OwnerReassign clientId={c.id} ownerId={c.owner?.id ?? null} owners={ownerOptions} />
                      ) : (
                        (c.owner?.name ?? <span className="italic">Unassigned</span>)
                      )}
                      {c.team && <span className="block text-xs">{c.team.name}</span>}
                    </td>
                    <td className="text-muted-foreground px-4 py-2.5 text-xs">{c.leadSource?.name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{currency(c.estimatedValue)}</td>
                    <td className="text-muted-foreground px-4 py-2.5 text-right text-xs whitespace-nowrap">
                      {relativeTime(c.lastActivityAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pageCount > 1 && (
            <nav className="flex items-center justify-between px-4 py-3 sm:px-6" aria-label="Pagination">
              <p className="text-muted-foreground text-xs">
                Page {page} of {pageCount}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  render={
                    <Link
                      href={`/clients?${new URLSearchParams({ ...(params as Record<string, string>), page: String(page - 1) })}`}
                    />
                  }
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pageCount}
                  render={
                    <Link
                      href={`/clients?${new URLSearchParams({ ...(params as Record<string, string>), page: String(page + 1) })}`}
                    />
                  }
                >
                  Next
                </Button>
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
    </>
  )
}
