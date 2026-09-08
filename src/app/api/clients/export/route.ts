import type { Prisma, StageKey } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, getSessionUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'

const HEADERS = [
  'id', 'first_name', 'last_name', 'email', 'phone', 'status', 'stage',
  'owner', 'team', 'region', 'lead_source', 'campaign', 'estimated_value',
  'probability', 'created_at', 'stage_entered_at', 'last_activity_at', 'lost_reason',
]

/** RFC 4180 quoting — a stray comma or quote must not shift a column. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = value instanceof Date ? value.toISOString() : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(request: Request) {
  const user = await getSessionUser()
  if (!user) return new Response('Unauthorized', { status: 401 })
  if (user.role === 'CLIENT') return new Response('Forbidden', { status: 403 })

  const sp = new URL(request.url).searchParams
  const filters: Prisma.ClientWhereInput[] = [clientScope(user)]

  const q = sp.get('q')
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
  const stage = sp.get('stage')
  if (stage) filters.push({ currentStage: { key: stage as StageKey } })
  const owner = sp.get('owner')
  if (owner) filters.push({ ownerId: owner })
  const team = sp.get('team')
  if (team) filters.push({ teamId: team })
  const status = sp.get('status')
  if (status) filters.push({ status: status as never })

  // Hard cap: an export is a report, not a bulk data extraction channel.
  const MAX_ROWS = 5000
  const rows = await db.client.findMany({
    where: { AND: filters },
    orderBy: { lastActivityAt: 'desc' },
    take: MAX_ROWS,
    select: {
      id: true, firstName: true, lastName: true, email: true, phone: true,
      status: true, estimatedValue: true, probability: true, createdAt: true,
      stageEnteredAt: true, lastActivityAt: true, lostReason: true,
      currentStage: { select: { name: true } },
      owner: { select: { name: true } },
      team: { select: { name: true } },
      region: { select: { name: true } },
      leadSource: { select: { name: true } },
      campaign: { select: { name: true } },
    },
  })

  await recordAudit(user, {
    action: 'clients.exported',
    entityType: 'Client',
    summary: `Exported ${rows.length} client rows to CSV`,
    after: { filters: Object.fromEntries(sp.entries()), rowCount: rows.length },
  })

  const body = [
    HEADERS.join(','),
    ...rows.map((r) =>
      [
        r.id, r.firstName, r.lastName, r.email, r.phone, r.status,
        r.currentStage.name, r.owner?.name, r.team?.name, r.region?.name,
        r.leadSource?.name, r.campaign?.name, r.estimatedValue, r.probability,
        r.createdAt, r.stageEnteredAt, r.lastActivityAt, r.lostReason,
      ].map(csvCell).join(','),
    ),
  ].join('\r\n')

  const stamp = new Date().toISOString().slice(0, 10)
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="prodigyflo-clients-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
