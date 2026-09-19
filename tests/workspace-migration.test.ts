import { beforeAll, afterAll, expect, it } from 'vitest'
import { Pool } from 'pg'
import { db } from '@/lib/db'
import { SCHEMA_42_FIELDS } from '../prisma/seeds/cys'
import { mergeWorkspace } from '../scripts/workspace-merge'

const stamp = `merge-${Date.now()}`
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
let sourceId: string, targetId: string, legacyUser: string, targetUser: string, sourceClient: string, targetClient: string, docId: string, oldAppointment: string
let originalDoc: unknown
beforeAll(async () => {
  for (const legacy of [false, true]) {
    const org = await db.organization.create({ data: { name: legacy ? 'Meridian' : 'Team Prodigy', slug: `${stamp}-${legacy}` } })
    if (legacy) sourceId = org.id; else targetId = org.id
    const role = await db.role.create({ data: { organizationId: org.id, key: legacy ? 'CLOSER' : 'ADMIN', name: 'Historical role' } })
    const team = await db.team.create({ data: { organizationId: org.id, name: legacy ? 'Old team' : 'SCS Inbound' } })
    const staff = await db.user.create({ data: { organizationId: org.id, roleId: role.id, teamId: team.id, name: 'Original Author', email: `${stamp}-${legacy}@example.test`, passwordHash: 'synthetic-hash', isOwner: !legacy } })
    if (legacy) legacyUser = staff.id; else targetUser = staff.id
    const pipeline = await db.pipeline.create({ data: { organizationId: org.id, name: 'Original pipeline', isDefault: true } })
    const stage = await db.pipelineStage.create({ data: { pipelineId: pipeline.id, key: 'NEW_LEAD', name: 'New lead', category: 'INTAKE', position: 0 } })
    const client = await db.client.create({ data: { organizationId: org.id, pipelineId: pipeline.id, currentStageId: stage.id, teamId: team.id, ownerId: legacy ? staff.id : null, firstName: 'Same', lastName: 'Person', email: `${stamp}-client@example.test`, phone: '7025550199', notes: { create: { authorId: staff.id, body: 'Original case history' } } } })
    if (legacy) sourceClient = client.id; else targetClient = client.id
    await db.cysFieldDefinition.createMany({ data: SCHEMA_42_FIELDS.map(def => ({ ...def, organizationId: org.id })) })
    await db.telephonyWallet.create({ data: { organizationId: org.id } })
    await db.intakeSource.create({ data: { organizationId: org.id, name: 'Intake', slug: 'scs', kind: 'WEB_FORM', defaultTeamId: team.id, defaultOwnerId: staff.id } })
    const connector = await db.connector.create({ data: { organizationId: org.id, kind: 'CYS', name: legacy ? 'Old CYS' : 'Live CYS', config: { live: !legacy } } })
    if (legacy) {
      await db.connectorLog.create({ data: { connectorId: connector.id, event: 'sync', level: 'info' } })
      await db.connectorCredential.create({ data: { connectorId: connector.id, organizationId: org.id, fieldKey: 'key', ciphertext: 'synthetic', iv: 'synthetic', authTag: 'synthetic' } })
      await db.assignment.create({ data: { clientId: client.id, assigneeId: staff.id, role: 'CLOSER' } })
      oldAppointment = (await db.appointment.create({ data: { clientId: client.id, ownerId: staff.id, status: 'COMPLETED', type: 'PRESENTATION', startsAt: new Date('2020-01-01'), endsAt: new Date('2020-01-02') } })).id
      const doc = await db.clientDocument.create({ data: { clientId: client.id, version: 2, storageKey: 'synthetic-file-key', checksum: 'synthetic-checksum', fileName: 'agreement.pdf', mimeType: 'application/pdf', status: 'RECEIVED' } }); docId = doc.id; originalDoc = doc
      await db.cysFieldValue.create({ data: { clientId: client.id, fieldKey: 'first_name', value: 'Staff correction', status: 'VERIFIED', verifiedById: staff.id } })
    }
  }
})
afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: [sourceId, targetId].filter(Boolean) } } })
  await pool.end()
})
async function run(commit = false) { const pg = await pool.connect(); try { return await mergeWorkspace(pg, { sourceId, targetId, commit }) } finally { pg.release() } }
it('refuses identity collisions and leaves both organizations intact', async () => {
  await db.user.update({ where: { id: targetUser }, data: { emailAlias: 'collision' } })
  await db.user.update({ where: { id: legacyUser }, data: { emailAlias: 'collision' } })
  await expect(run()).rejects.toThrow(/collision/)
  expect(await db.organization.count({ where: { id: { in: [sourceId, targetId].filter(Boolean) } } })).toBe(2)
  await db.user.update({ where: { id: legacyUser }, data: { emailAlias: null } })
})
it('rehearses every migration write and rolls back by default', async () => {
  const report = await run()
  expect(report.committed).toBe(false); expect(report.clients).toBe(2)
  expect(await db.organization.findUnique({ where: { id: sourceId } })).not.toBeNull()
  expect((await db.user.findUniqueOrThrow({ where: { id: legacyUser } })).isActive).toBe(true)
  expect(await db.workspaceMigrationArchive.count({ where: { runId: report.runId } })).toBe(0)
  expect(await db.clientDocument.findUnique({ where: { id: docId } })).toEqual(originalDoc)
})
it('consolidates without merging matching contacts or losing authorship, documents, or corrections', async () => {
  const report = await run(true)
  expect(report.clients).toBe(2); expect(report.archivedRows).toBeGreaterThan(90)
  expect(await db.organization.findUnique({ where: { id: sourceId } })).toBeNull()
  expect(await db.client.count({ where: { id: { in: [sourceClient, targetClient] }, organizationId: targetId } })).toBe(2)
  expect(await db.clientDocument.findUnique({ where: { id: docId } })).toEqual(originalDoc)
  expect((await db.appointment.findUniqueOrThrow({ where: { id: oldAppointment } })).ownerId).toBe(legacyUser)
  expect((await db.cysFieldValue.findUniqueOrThrow({ where: { clientId_fieldKey: { clientId: sourceClient, fieldKey: 'first_name' } } })).verifiedById).toBe(legacyUser)
  const legacy = await db.user.findUniqueOrThrow({ where: { id: legacyUser }, include: { role: true } })
  expect(legacy.isActive).toBe(false); expect(legacy.organizationId).toBe(targetId); expect(legacy.role.key).toBe('CLOSER')
  const admin = await db.user.findUniqueOrThrow({ where: { id: targetUser }, include: { role: true } })
  expect(admin.isActive).toBe(true); expect(admin.isOwner).toBe(false); expect(admin.role.key).toBe('SUPER_ADMIN')
  expect(await db.role.count({ where: { organizationId: targetId } })).toBe(2)
  expect(await db.team.count({ where: { organizationId: targetId } })).toBe(1)
  expect(await db.cysFieldDefinition.count({ where: { organizationId: targetId, isActive: true } })).toBe(42)
  const live = await db.connector.findFirstOrThrow({ where: { organizationId: targetId, kind: 'CYS' } })
  expect(live.name).toBe('Live CYS'); expect(live.isEnabled).toBe(true); expect(live.config).toEqual({ live: true })
  expect(await db.connectorCredential.count({ where: { connectorId: live.id } })).toBe(0)
  expect(await db.workspaceMigrationArchive.count({ where: { runId: report.runId, tableName: 'ConnectorCredential' } })).toBe(1)
  await expect(db.workspaceMigrationArchive.deleteMany({ where: { runId: report.runId } })).rejects.toThrow(/immutable/)
})
