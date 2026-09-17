import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { can, canAny, clientScope, requireUser } from '@/lib/rbac'
import { deskVisibleClientWhere } from '@/lib/intake/scs-desk'
import type { PermissionKey } from '@/lib/permissions'
import { CATEGORY_LABELS, CATEGORY_STYLES } from '@/lib/pipeline'
import { fullName } from '@/lib/format'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Board, BoardFilters, type BoardCard, type BoardLane } from './board-client'

/** Enough for a working board; beyond this the list view is the better tool. */
const MAX_CARDS = 600

const CLIENT_READ: PermissionKey[] = [
  'clients:read_assigned',
  'clients:read_team',
  'clients:read_region',
  'clients:read_all',
]

/**
 * Pipeline kanban. /pipeline is the money-card board; /board is the Daily Desk calendar.
 * Same moveCardAction store.
 */
export async function PipelineBoard({
  searchParams,
  title,
  notice,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
  title: string
  notice?: ReactNode
}) {
  const user = await requireUser()
  if (!canAny(user, CLIENT_READ)) {
    redirect('/forbidden')
  }

  const params = await searchParams
  const str = (v: string | string[] | undefined) => (typeof v === 'string' && v ? v : undefined)
  const ownerId = str(params.owner)
  const teamId = str(params.team)

  const filters: Prisma.ClientWhereInput[] = [
    clientScope(user),
    deskVisibleClientWhere(),
    { status: 'ACTIVE' },
    { currentStage: { isTerminal: false } },
  ]
  if (ownerId) filters.push({ ownerId })
  if (teamId) filters.push({ teamId })

  const canFilter = canAny(user, ['clients:read_team', 'clients:read_region', 'clients:read_all'])

  const [stages, clients, total, owners, teams] = await Promise.all([
    db.pipelineStage.findMany({
      where: { pipeline: { organizationId: user.organizationId, isDefault: true }, isTerminal: false },
      orderBy: { position: 'asc' },
      select: { key: true, name: true, category: true, slaHours: true, allowedNextKeys: true },
    }),
    db.client.findMany({
      where: { AND: filters },
      orderBy: { lastActivityAt: 'desc' },
      take: MAX_CARDS,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        estimatedValue: true,
        stageEnteredAt: true,
        owner: { select: { name: true } },
        currentStage: { select: { key: true, slaHours: true } },
      },
    }),
    db.client.count({ where: { AND: filters } }),
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
  ])

  const lanes: BoardLane[] = stages.map((s) => ({
    key: s.key,
    name: s.name,
    categoryLabel: CATEGORY_LABELS[s.category],
    dotClass: CATEGORY_STYLES[s.category].dot,
    slaHours: s.slaHours,
    allowedNext: s.allowedNextKeys,
  }))

  const cards: BoardCard[] = clients.map((c) => ({
    id: c.id,
    name: fullName(c),
    value: c.estimatedValue ? Number(c.estimatedValue.toString()) : null,
    ownerName: c.owner?.name ?? null,
    stageKey: c.currentStage.key,
    stageEnteredAt: c.stageEnteredAt.toISOString(),
    slaHours: c.currentStage.slaHours,
  }))

  const canMove = can(user, 'clients:advance_stage')

  return (
    <>
      <PageHeader
        title={title}
        description={
          total > MAX_CARDS
            ? `Showing the ${MAX_CARDS.toLocaleString()} most recently active of ${total.toLocaleString()} clients — narrow with the filters to see the rest`
            : `${total.toLocaleString()} active client${total === 1 ? '' : 's'} · ${
                canMove
                  ? 'drag a card to move it — every move is checked against the pipeline rules'
                  : 'read-only: you can browse, but moving clients needs the advance-stage permission'
              }`
        }
      >
        <BoardFilters
          owners={owners.map((o) => ({ value: o.id, label: o.name }))}
          teams={teams.map((t) => ({ value: t.id, label: t.name }))}
          canFilter={canFilter}
        />
      </PageHeader>

      {notice}

      {lanes.length === 0 ? (
        <EmptyState
          icon="Columns3"
          title="No pipeline configured yet"
          description="Once your pipeline stages exist, active clients appear here as draggable cards."
        />
      ) : (
        <Board lanes={lanes} cards={cards} canMove={canMove} />
      )}
    </>
  )
}
