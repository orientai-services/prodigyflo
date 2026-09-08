import type { PrismaClient } from '@prisma/client'

type Ctx = {
  organizationId: string
  users: { id: string; email: string; role: string }[]
  clientIds: string[]
}

/**
 * Ops-slice demo rows: a couple of saved views on /clients and a handful of
 * overdue tasks so /reports/overdue and the bulk tools have something real to
 * show. Idempotent — reruns update rather than duplicate. Synthetic only.
 */
export async function seedOps(db: PrismaClient, ctx: Ctx): Promise<void> {
  const admin =
    ctx.users.find((u) => u.role === 'ADMIN') ??
    ctx.users.find((u) => u.role === 'SUPER_ADMIN') ??
    ctx.users[0]
  const manager = ctx.users.find((u) => u.role === 'SALES_MANAGER') ?? admin
  const closer = ctx.users.find((u) => u.role === 'CLOSER') ?? admin
  if (!admin) return

  // ── Saved views ────────────────────────────────────────────────────────────
  const filters: { userId: string; name: string; params: Record<string, string>; isShared: boolean }[] = [
    {
      userId: admin.id,
      name: 'Fresh leads',
      params: { stage: 'NEW_LEAD', sort: 'created' },
      isShared: true,
    },
    {
      userId: manager.id,
      name: 'Stuck on documents',
      params: { stage: 'DOCUMENT_COLLECTION', status: 'ACTIVE', sort: 'oldest' },
      isShared: true,
    },
    {
      userId: closer.id,
      name: 'My high-value actives',
      params: { status: 'ACTIVE', sort: 'value' },
      isShared: false,
    },
  ]

  for (const f of filters) {
    const existing = await db.savedFilter.findFirst({
      where: { organizationId: ctx.organizationId, userId: f.userId, route: '/clients', name: f.name },
    })
    if (existing) {
      await db.savedFilter.update({
        where: { id: existing.id },
        data: { params: f.params, isShared: f.isShared },
      })
    } else {
      await db.savedFilter.create({
        data: {
          organizationId: ctx.organizationId,
          userId: f.userId,
          route: '/clients',
          name: f.name,
          params: f.params,
          isShared: f.isShared,
        },
      })
    }
  }

  // ── Overdue tasks ──────────────────────────────────────────────────────────
  const now = Date.now()
  const tasks: { clientIdx: number; title: string; priority: 'URGENT' | 'HIGH' | 'NORMAL'; overdueDays: number }[] = [
    { clientIdx: 0, title: 'Call back about missing utility bill', priority: 'URGENT', overdueDays: 3 },
    { clientIdx: 1, title: 'Confirm appointment reschedule', priority: 'HIGH', overdueDays: 1 },
    { clientIdx: 2, title: 'Send Spanish contract summary', priority: 'NORMAL', overdueDays: 5 },
  ]

  for (const t of tasks) {
    const clientId = ctx.clientIds[t.clientIdx]
    if (!clientId) continue
    const existing = await db.task.findFirst({ where: { clientId, title: t.title } })
    const dueAt = new Date(now - t.overdueDays * 86_400_000)
    if (existing) {
      await db.task.update({
        where: { id: existing.id },
        data: { dueAt, status: 'OPEN', priority: t.priority },
      })
    } else {
      await db.task.create({
        data: {
          clientId,
          title: t.title,
          priority: t.priority,
          status: 'OPEN',
          dueAt,
          assigneeId: closer.id,
          createdById: manager.id,
        },
      })
    }
  }
}
