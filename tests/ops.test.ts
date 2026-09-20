import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { ForbiddenError, type SessionUser } from '@/lib/rbac'
import type { PermissionKey } from '@/lib/permissions'
import {
  addNoteToClients,
  bulkMoveClients,
  canDeleteSavedFilter,
  getDocumentCompletion,
  getOverdueTasks,
  getSlaExpiredClients,
  reassignClients,
  savedFilterVisibleWhere,
} from '@/lib/reporting'

const stamp = `opstest-${Date.now()}`

let orgA: string
let orgB: string
let adminId: string
let closerAId: string
let closerBId: string
let outsiderId: string
let cMove: string
let cBlocked: string
let cSla: string
let cForeign: string

function session(
  userId: string,
  organizationId: string,
  permissions: PermissionKey[],
): SessionUser {
  return {
    id: userId,
    name: 'Ops Tester',
    email: `${userId}@example.com`,
    organizationId,
    organizationName: 'Ops Test',
    roleId: 'role',
    role: userId === adminId || userId === outsiderId ? 'SUPER_ADMIN' : 'CLOSER',
    roleName: 'Admin',
    isOwner: false,
    regionId: null,
    teamId: null,
    managerId: null,
    avatarUrl: null,
    title: null,
    permissions: new Set(permissions),
    portalClientId: null,
  }
}

const READ_ALL: PermissionKey[] = ['clients:read_all']

async function mkClient(orgId: string, pipelineId: string, stageId: string, n: number, ownerId?: string) {
  const c = await db.client.create({
    data: {
      organizationId: orgId,
      pipelineId,
      currentStageId: stageId,
      ownerId: ownerId ?? null,
      firstName: 'Test',
      lastName: `Client${n}`,
      email: `client${n}.${stamp}@example.com`,
      phone: `+1702555${String(1000 + n)}`,
    },
  })
  return c.id
}

beforeAll(async () => {
  // Org A — the org under test.
  const a = await db.organization.create({ data: { name: 'Ops Org A', slug: `${stamp}-a` } })
  orgA = a.id
  const roleA = await db.role.create({ data: { organizationId: orgA, key: 'SUPER_ADMIN', name: 'Admin' } })
  const admin = await db.user.create({
    data: { organizationId: orgA, roleId: roleA.id, email: `admin.${stamp}@example.com`, passwordHash: 'x', name: 'Ada Admin' },
  })
  adminId = admin.id
  const closerRole = await db.role.create({ data: { organizationId: orgA, key: 'CLOSER', name: 'Closer' } })
  const closerA = await db.user.create({
    data: { organizationId: orgA, roleId: closerRole.id, email: `ca.${stamp}@example.com`, passwordHash: 'x', name: 'Cleo Closer' },
  })
  closerAId = closerA.id
  const closerB = await db.user.create({
    data: { organizationId: orgA, roleId: closerRole.id, email: `cb.${stamp}@example.com`, passwordHash: 'x', name: 'Bert Closer' },
  })
  closerBId = closerB.id

  const pipelineA = await db.pipeline.create({
    data: { organizationId: orgA, name: 'Ops pipeline', isDefault: true },
  })
  const newLead = await db.pipelineStage.create({
    data: {
      pipelineId: pipelineA.id,
      key: 'NEW_LEAD',
      name: 'New lead',
      category: 'INTAKE',
      position: 0,
      slaHours: 1,
      allowedNextKeys: ['SURVEY_STARTED'],
    },
  })
  await db.pipelineStage.create({
    data: {
      pipelineId: pipelineA.id,
      key: 'SURVEY_STARTED',
      name: 'Survey started',
      category: 'INTAKE',
      position: 1,
      allowedNextKeys: ['NEW_LEAD'],
    },
  })
  await db.pipelineStage.create({
    data: {
      pipelineId: pipelineA.id,
      key: 'QUALIFIED',
      name: 'Qualified',
      category: 'SALES',
      position: 8,
    },
  })

  cMove = await mkClient(orgA, pipelineA.id, newLead.id, 1, closerAId)
  cBlocked = await mkClient(orgA, pipelineA.id, newLead.id, 2, closerAId)
  cSla = await mkClient(orgA, pipelineA.id, newLead.id, 3, closerAId)
  // Three hours in NEW_LEAD (1h SLA) with no activity since entering.
  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000)
  await db.client.update({
    where: { id: cSla },
    data: { stageEnteredAt: threeHoursAgo, lastActivityAt: threeHoursAgo },
  })

  // Org B — a foreign org that must never leak into org A's results.
  const b = await db.organization.create({ data: { name: 'Ops Org B', slug: `${stamp}-b` } })
  orgB = b.id
  const roleB = await db.role.create({ data: { organizationId: orgB, key: 'SUPER_ADMIN', name: 'Admin' } })
  const outsider = await db.user.create({
    data: { organizationId: orgB, roleId: roleB.id, email: `out.${stamp}@example.com`, passwordHash: 'x', name: 'Olga Outsider' },
  })
  outsiderId = outsider.id
  const pipelineB = await db.pipeline.create({ data: { organizationId: orgB, name: 'B pipeline', isDefault: true } })
  const stageB = await db.pipelineStage.create({
    data: { pipelineId: pipelineB.id, key: 'NEW_LEAD', name: 'New lead', category: 'INTAKE', position: 0 },
  })
  cForeign = await mkClient(orgB, pipelineB.id, stageB.id, 9)
})

afterAll(async () => {
  await db.organization.delete({ where: { id: orgA } }).catch(() => {})
  await db.organization.delete({ where: { id: orgB } }).catch(() => {})
})

// ── Bulk stage changes ───────────────────────────────────────────────────────

describe('bulkMoveClients', () => {
  it('requires the advance-stage permission', async () => {
    const user = session(adminId, orgA, READ_ALL)
    await expect(bulkMoveClients(user, [cMove], 'SURVEY_STARTED')).rejects.toThrow(ForbiddenError)
  })

  it('blocks transitions the pipeline does not allow, per row, without throwing', async () => {
    const user = session(adminId, orgA, [...READ_ALL, 'clients:advance_stage'])
    const results = await bulkMoveClients(user, [cBlocked], 'QUALIFIED')
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toMatch(/cannot move directly/i)

    const unchanged = await db.client.findUnique({ where: { id: cBlocked }, include: { currentStage: true } })
    expect(unchanged?.currentStage.key).toBe('NEW_LEAD')
  })

  it('moves allowed clients and reports out-of-scope ids in the same batch', async () => {
    const user = session(adminId, orgA, [...READ_ALL, 'clients:advance_stage'])
    const results = await bulkMoveClients(user, [cMove, cForeign], 'SURVEY_STARTED')

    const okRow = results.find((r) => r.id === cMove)
    const badRow = results.find((r) => r.id === cForeign)
    expect(okRow?.ok).toBe(true)
    expect(badRow?.ok).toBe(false)
    expect(badRow?.error).toMatch(/outside your scope/i)

    const moved = await db.client.findUnique({ where: { id: cMove }, include: { currentStage: true } })
    expect(moved?.currentStage.key).toBe('SURVEY_STARTED')

    // The foreign client never moved.
    const foreign = await db.client.findUnique({ where: { id: cForeign }, include: { currentStage: true } })
    expect(foreign?.currentStage.key).toBe('NEW_LEAD')
  })
})

// ── Reassignment ─────────────────────────────────────────────────────────────

describe('reassignClients', () => {
  it('is denied without clients:reassign', async () => {
    const user = session(adminId, orgA, READ_ALL)
    await expect(reassignClients(user, [cMove], closerBId)).rejects.toThrow(ForbiddenError)
  })

  it('rejects owners outside the caller’s user scope', async () => {
    const user = session(adminId, orgA, [...READ_ALL, 'clients:reassign'])
    await expect(reassignClients(user, [cMove], outsiderId)).rejects.toThrow(ForbiddenError)
  })

  it('reassigns in-scope clients and audits each change', async () => {
    const user = session(adminId, orgA, [...READ_ALL, 'clients:reassign'])
    const results = await reassignClients(user, [cMove, cForeign], closerBId)

    expect(results.find((r) => r.id === cMove)?.ok).toBe(true)
    expect(results.find((r) => r.id === cForeign)?.ok).toBe(false)

    const updated = await db.client.findUnique({ where: { id: cMove } })
    expect(updated?.ownerId).toBe(closerBId)

    const audit = await db.auditEvent.findFirst({
      where: { organizationId: orgA, action: 'client.reassigned', entityId: cMove },
    })
    expect(audit).not.toBeNull()
  })
})

// ── Bulk notes ───────────────────────────────────────────────────────────────

describe('addNoteToClients', () => {
  it('requires clients:update', async () => {
    const user = session(adminId, orgA, READ_ALL)
    await expect(addNoteToClients(user, [cMove], 'hello')).rejects.toThrow(ForbiddenError)
  })

  it('creates an internal note per client', async () => {
    const user = session(adminId, orgA, [...READ_ALL, 'clients:update'])
    const results = await addNoteToClients(user, [cMove], `bulk note ${stamp}`)
    expect(results[0].ok).toBe(true)

    const note = await db.note.findFirst({ where: { clientId: cMove, body: `bulk note ${stamp}` } })
    expect(note?.isInternal).toBe(true)
    expect(note?.authorId).toBe(adminId)
  })
})

// ── Saved filters ────────────────────────────────────────────────────────────

describe('saved filters', () => {
  let personalId = ''
  let sharedId = ''

  beforeAll(async () => {
    const personal = await db.savedFilter.create({
      data: {
        organizationId: orgA,
        userId: closerAId,
        route: '/clients',
        name: `personal ${stamp}`,
        params: { stage: 'NEW_LEAD' },
        isShared: false,
      },
    })
    personalId = personal.id
    const shared = await db.savedFilter.create({
      data: {
        organizationId: orgA,
        userId: adminId,
        route: '/clients',
        name: `shared ${stamp}`,
        params: { status: 'ACTIVE' },
        isShared: true,
      },
    })
    sharedId = shared.id
  })

  it('shows a user their own filters plus shared ones, and nothing else', async () => {
    const closerB = session(closerBId, orgA, READ_ALL)
    const visibleToB = await db.savedFilter.findMany({ where: savedFilterVisibleWhere(closerB) })
    const idsForB = visibleToB.map((f) => f.id)
    expect(idsForB).toContain(sharedId)
    expect(idsForB).not.toContain(personalId)

    const closerA = session(closerAId, orgA, READ_ALL)
    const visibleToA = await db.savedFilter.findMany({ where: savedFilterVisibleWhere(closerA) })
    const idsForA = visibleToA.map((f) => f.id)
    expect(idsForA).toContain(sharedId)
    expect(idsForA).toContain(personalId)
  })

  it('never crosses organizations', async () => {
    const outsider = session(outsiderId, orgB, READ_ALL)
    const visible = await db.savedFilter.findMany({ where: savedFilterVisibleWhere(outsider) })
    expect(visible.map((f) => f.id)).not.toContain(sharedId)
  })

  it('lets the creator or a user manager delete, and nobody else', async () => {
    const shared = await db.savedFilter.findUniqueOrThrow({ where: { id: sharedId } })

    expect(canDeleteSavedFilter(session(adminId, orgA, READ_ALL), shared)).toBe(true)
    expect(canDeleteSavedFilter(session(closerAId, orgA, READ_ALL), shared)).toBe(false)
    expect(canDeleteSavedFilter(session(closerAId, orgA, [...READ_ALL, 'users:manage']), shared)).toBe(true)
    // Same permission in a different org still cannot touch it.
    expect(canDeleteSavedFilter(session(outsiderId, orgB, ['users:manage']), shared)).toBe(false)
  })
})

// ── Overdue reporting ────────────────────────────────────────────────────────

describe('overdue reporting', () => {
  beforeAll(async () => {
    await db.task.create({
      data: {
        clientId: cSla,
        title: `overdue task ${stamp}`,
        status: 'OPEN',
        priority: 'HIGH',
        dueAt: new Date(Date.now() - 2 * 86_400_000),
        assigneeId: closerAId,
      },
    })
    // A completed task past due must NOT count.
    await db.task.create({
      data: {
        clientId: cSla,
        title: `done task ${stamp}`,
        status: 'COMPLETED',
        dueAt: new Date(Date.now() - 2 * 86_400_000),
      },
    })
  })

  it('finds open tasks past due within scope only', async () => {
    const user = session(adminId, orgA, READ_ALL)
    const rows = await getOverdueTasks(user)
    const titles = rows.map((r) => r.title)
    expect(titles).toContain(`overdue task ${stamp}`)
    expect(titles).not.toContain(`done task ${stamp}`)

    const outsider = session(outsiderId, orgB, READ_ALL)
    const foreignRows = await getOverdueTasks(outsider)
    expect(foreignRows.map((r) => r.title)).not.toContain(`overdue task ${stamp}`)
  })

  it('flags clients past SLA with no activity, and clears once touched', async () => {
    const user = session(adminId, orgA, READ_ALL)
    const before = await getSlaExpiredClients(user)
    expect(before.map((r) => r.id)).toContain(cSla)

    await db.client.update({ where: { id: cSla }, data: { lastActivityAt: new Date() } })
    const after = await getSlaExpiredClients(user)
    expect(after.map((r) => r.id)).not.toContain(cSla)
  })
})

// ── Document completion ──────────────────────────────────────────────────────

describe('getDocumentCompletion', () => {
  it('computes requested / received / approved per requirement, scoped', async () => {
    const pkg = await db.documentPackage.create({
      data: { organizationId: orgA, name: `Ops pack ${stamp}` },
    })
    const req = await db.documentRequirement.create({
      data: { packageId: pkg.id, key: `utility_bill_${stamp}`, name: 'Utility bill', position: 0 },
    })
    await db.clientDocument.create({ data: { clientId: cMove, requirementId: req.id, status: 'APPROVED' } })
    await db.clientDocument.create({ data: { clientId: cBlocked, requirementId: req.id, status: 'REQUESTED' } })

    const rows = await getDocumentCompletion(session(adminId, orgA, READ_ALL))
    const row = rows.find((r) => r.requirementId === req.id)
    expect(row).toBeDefined()
    expect(row?.requested).toBe(2)
    expect(row?.received).toBe(1)
    expect(row?.approved).toBe(1)
    expect(row?.approvedRate).toBe(50)

    // The foreign org sees the requirement catalog only for its own org.
    const foreignRows = await getDocumentCompletion(session(outsiderId, orgB, READ_ALL))
    expect(foreignRows.find((r) => r.requirementId === req.id)).toBeUndefined()
  })
})
