/**
 * The Queue badge on Board, Clients and the profile is counted without loading
 * the full client list. It must equal the count the Queue view derives from
 * that list: an unverified agreement, or a booked client with no agreement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { loadFinalDesk } from '@/lib/final-desk/data'
import { ALL_PERMISSIONS } from '@/lib/permissions'
import type { SessionUser } from '@/lib/rbac'

const stamp = `fdq-${Date.now().toString(36)}`
let org = ''
let user: SessionUser

beforeAll(async () => {
  org = (await db.organization.create({ data: { name: 'Queue count tests', slug: stamp } })).id
  const role = await db.role.create({ data: { organizationId: org, key: 'SUPER_ADMIN', name: 'Super Admin' } })
  const row = await db.user.create({ data: { organizationId: org, roleId: role.id, name: 'Admin', email: `${stamp}@example.test`, passwordHash: 'test-only' } })
  user = {
    id: row.id, name: 'Admin', email: row.email, organizationId: org, organizationName: 'Queue count tests', roleId: role.id,
    role: 'SUPER_ADMIN', roleName: 'Super Admin', isOwner: true, regionId: null, teamId: null, managerId: null, avatarUrl: null,
    title: null, permissions: new Set(ALL_PERMISSIONS), portalClientId: null,
  }
  const pipe = await db.pipeline.create({ data: { organizationId: org, name: 'Test' } })
  const stage = await db.pipelineStage.create({ data: { pipelineId: pipe.id, key: 'NEW_LEAD', name: 'New', position: 0, category: 'INTAKE' } })
  const client = async (lastName: string) =>
    (await db.client.create({ data: { organizationId: org, pipelineId: pipe.id, currentStageId: stage.id, ownerId: row.id, firstName: 'Synthetic', lastName, email: `${stamp}-${lastName.replace(/\W+/g, '-')}@example.test`, phone: '2025550100' } })).id
  const doc = (clientId: string, fileName: string, status: 'RECEIVED' | 'REJECTED', fields: ('VERIFIED' | 'UNVERIFIED')[]) =>
    db.clientDocument.create({
      data: {
        clientId, label: fileName, fileName, storageKey: 'synthetic-only', status, receivedAt: new Date(),
        extractions: { create: { status: 'COMPLETED', provider: 'test', fields: { create: fields.map((verification, i) => ({ key: `k${i}`, label: `K${i}`, verification })) } } },
      },
    })
  const soon = (clientId: string, status: 'SCHEDULED' | 'CANCELLED' = 'SCHEDULED') =>
    db.appointment.create({ data: { clientId, ownerId: row.id, status, startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 5_400_000) } })

  // Booked with no agreement: in the queue.
  await soon(await client('Booked empty'))
  // Unverified agreement: in the queue.
  await doc(await client('Unverified'), 'solar_contract.pdf', 'RECEIVED', ['UNVERIFIED', 'VERIFIED'])
  // Verified agreement, booked: not in the queue.
  const verified = await client('Verified')
  await doc(verified, 'loan_agreement.pdf', 'RECEIVED', ['VERIFIED', 'VERIFIED'])
  await soon(verified)
  // A rejected agreement does not count; the cancelled visit does not book.
  const rejected = await client('Rejected')
  await doc(rejected, 'solar_contract.pdf', 'REJECTED', ['UNVERIFIED'])
  await soon(rejected, 'CANCELLED')
  // Nothing at all.
  await client('Empty')
})

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: org } })
})

describe('the Queue badge', () => {
  it('counts the same on every view as the Queue list does', async () => {
    const queue = await loadFinalDesk(user, 'queue')
    const fromList = (queue.clients ?? []).filter((c) => c.extraction === 'unverified' || (c.extraction === 'none' && c.appointment)).length
    expect(queue.queueCount).toBe(fromList)
    expect(queue.queueCount).toBe(2)
    for (const view of ['board', 'clients', 'documents'] as const) {
      expect((await loadFinalDesk(user, view)).queueCount, view).toBe(queue.queueCount)
    }
  })

  it('leaves the client list off the views that do not show it', async () => {
    expect((await loadFinalDesk(user, 'board')).clients).toBeUndefined()
    expect((await loadFinalDesk(user, 'documents')).clients?.length).toBe(5)
  })
})
