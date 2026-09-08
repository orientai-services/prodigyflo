import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'

/**
 * Lead Recovery Flow — the recycler. A "recoverable" lead is one that came in
 * but did not make it to the finish line: it was lost, put on hold, or has gone
 * dormant. This library is the read + metrics layer behind the recovery app;
 * it reuses clientScope, so the recovery product inherits the same tenancy and
 * role scoping as everything else.
 */

export const DORMANT_DAYS = 21

export type RecoveryBucket = 'lost' | 'on_hold' | 'dormant'

export const BUCKET_LABEL: Record<RecoveryBucket, string> = {
  lost: 'Lost',
  on_hold: 'On hold',
  dormant: 'Dormant',
}

/** The scope of recoverable leads for a caller — reused by list + metrics. */
function recoverableWhere(user: SessionUser, dormantCutoff: Date): Prisma.ClientWhereInput {
  return {
    ...clientScope(user),
    OR: [
      { status: 'CLOSED_LOST' },
      { status: 'ON_HOLD' },
      {
        status: 'ACTIVE',
        currentStage: { isTerminal: false },
        lastActivityAt: { lt: dormantCutoff },
      },
    ],
  }
}

function bucketOf(status: string): RecoveryBucket {
  if (status === 'CLOSED_LOST') return 'lost'
  if (status === 'ON_HOLD') return 'on_hold'
  return 'dormant'
}

export type RecoverableLead = {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string
  bucket: RecoveryBucket
  stageName: string
  reason: string | null
  estimatedValue: number | null
  ownerName: string | null
  source: string | null
  lastActivityAt: Date
}

export type RecoveryFilters = {
  bucket?: RecoveryBucket
  search?: string
  page?: number
}

export const RECOVERY_PAGE_SIZE = 25

export async function getRecoverableLeads(
  user: SessionUser,
  filters: RecoveryFilters = {},
): Promise<{ rows: RecoverableLead[]; total: number; page: number; pageCount: number }> {
  const dormantCutoff = new Date(Date.now() - DORMANT_DAYS * 86_400_000)
  const where: Prisma.ClientWhereInput = { ...recoverableWhere(user, dormantCutoff) }

  if (filters.bucket === 'lost') where.status = 'CLOSED_LOST'
  else if (filters.bucket === 'on_hold') where.status = 'ON_HOLD'
  else if (filters.bucket === 'dormant') {
    where.status = 'ACTIVE'
    where.currentStage = { isTerminal: false }
    where.lastActivityAt = { lt: dormantCutoff }
    delete where.OR
  }

  const term = filters.search?.trim()
  if (term) {
    where.AND = [
      {
        OR: [
          { firstName: { contains: term, mode: 'insensitive' } },
          { lastName: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term } },
        ],
      },
    ]
  }

  const page = Math.max(1, filters.page ?? 1)
  const [total, rows] = await Promise.all([
    db.client.count({ where }),
    db.client.findMany({
      where,
      orderBy: [{ estimatedValue: 'desc' }, { lastActivityAt: 'asc' }],
      skip: (page - 1) * RECOVERY_PAGE_SIZE,
      take: RECOVERY_PAGE_SIZE,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true,
        estimatedValue: true,
        lastActivityAt: true,
        lostReason: true,
        holdReason: true,
        currentStage: { select: { name: true } },
        owner: { select: { name: true } },
        leadSource: { select: { name: true } },
      },
    }),
  ])

  return {
    rows: rows.map((c) => ({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      bucket: bucketOf(c.status),
      stageName: c.currentStage.name,
      reason: c.lostReason ?? c.holdReason ?? null,
      estimatedValue: c.estimatedValue === null ? null : Number(c.estimatedValue),
      ownerName: c.owner?.name ?? null,
      source: c.leadSource?.name ?? null,
      lastActivityAt: c.lastActivityAt,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / RECOVERY_PAGE_SIZE)),
  }
}

export type RecoveryMetrics = {
  recoverable: number
  byBucket: Record<RecoveryBucket, number>
  potentialValue: number
  recovered: number
  recoveredValue: number
  recoveryRatePct: number | null
  topReasons: { reason: string; count: number }[]
}

/**
 * The headline recovery numbers. "Recovered" = clients that are now CLOSED_WON
 * but previously passed through a lost/hold stage — a deal brought back from
 * the finish line it had missed.
 */
export async function getRecoveryMetrics(user: SessionUser): Promise<RecoveryMetrics> {
  const scope = clientScope(user)
  const dormantCutoff = new Date(Date.now() - DORMANT_DAYS * 86_400_000)
  const where = recoverableWhere(user, dormantCutoff)

  const [recoverable, lost, onHold, dormant, valueAgg, reasons, wonBack, wonBackValue] = await Promise.all([
    db.client.count({ where }),
    db.client.count({ where: { ...scope, status: 'CLOSED_LOST' } }),
    db.client.count({ where: { ...scope, status: 'ON_HOLD' } }),
    db.client.count({
      where: { ...scope, status: 'ACTIVE', currentStage: { isTerminal: false }, lastActivityAt: { lt: dormantCutoff } },
    }),
    db.client.aggregate({ where, _sum: { estimatedValue: true } }),
    db.client.groupBy({
      by: ['lostReason'],
      where: { ...scope, status: 'CLOSED_LOST', lostReason: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { lostReason: 'desc' } },
      take: 5,
    }),
    db.client.count({
      where: { ...scope, status: 'CLOSED_WON', stageHistory: { some: { toKey: { in: ['CLOSED_LOST', 'ON_HOLD'] } } } },
    }),
    db.client.aggregate({
      where: { ...scope, status: 'CLOSED_WON', stageHistory: { some: { toKey: { in: ['CLOSED_LOST', 'ON_HOLD'] } } } },
      _sum: { estimatedValue: true },
    }),
  ])

  const decided = wonBack + lost // recovered vs still-lost as a recovery-rate denominator
  return {
    recoverable,
    byBucket: { lost, on_hold: onHold, dormant },
    potentialValue: Number(valueAgg._sum.estimatedValue ?? 0),
    recovered: wonBack,
    recoveredValue: Number(wonBackValue._sum.estimatedValue ?? 0),
    recoveryRatePct: decided > 0 ? Math.round((wonBack / decided) * 1000) / 10 : null,
    topReasons: reasons
      .filter((r) => r.lostReason)
      .map((r) => ({ reason: r.lostReason as string, count: r._count._all })),
  }
}

/** A single recoverable lead for the detail/recovery action, scope-checked. */
export async function getRecoverableLead(user: SessionUser, clientId: string) {
  return db.client.findFirst({
    where: { ...clientScope(user), id: clientId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      status: true,
      estimatedValue: true,
      lostReason: true,
      holdReason: true,
      lastActivityAt: true,
      currentStage: { select: { name: true, key: true } },
      owner: { select: { name: true } },
      leadSource: { select: { name: true } },
    },
  })
}
