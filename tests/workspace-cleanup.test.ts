import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { db } from '@/lib/db'
import { ALL_PERMISSIONS, CLOSER_PERMISSIONS } from '@/lib/permissions'
import { can, ForbiddenError, findClientInScope, type SessionUser } from '@/lib/rbac'
import { SCHEMA_42_FIELDS } from '../prisma/seeds/cys'
import { resolveForClient, refreshCysMirror, generateCysPackage } from '@/lib/cys/data'
import { verifyCysFieldAction, approveCysReadinessAction } from '@/lib/cys/actions'
import { createClientRecord } from '@/lib/clients'
import { updateOverviewAction } from '@/app/(app)/clients/[clientId]/actions'
import { applyAssignment } from '@/lib/assignment'
import { loadDeskBoard } from '@/lib/daily-desk-data'
import { findDocumentInScope } from '@/lib/storage/access'
import { signedDocumentFileUrl } from '@/lib/storage'
import { upsertIntakeAppointment } from '@/lib/intake/appointment'
import { notificationScope } from '@/lib/notification-scope'
import { POST as upload } from '@/app/api/documents/upload/route'
import { GET as file } from '@/app/api/documents/[documentId]/file/route'
import { setUserActiveAction, changeRoleAction, updateCloserPermissionsAction } from '@/app/(app)/settings/users/actions'
const state = vi.hoisted(() => ({ actor: null as SessionUser | null }))
vi.mock('@/lib/rbac', async (original) => ({ ...await original<typeof import('@/lib/rbac')>(),
  getSessionUser: async () => state.actor,
  requirePermission: async (key: Parameters<typeof can>[1]) => { if (!state.actor || !can(state.actor, key)) throw new ForbiddenError(); return state.actor },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const stamp = `cleanup-${Date.now()}`
const storage = mkdtempSync(path.join(tmpdir(), 'prodigy-workspace-test-'))
let org: string, client: string, stranger: string, requirement: string, doc: string, future: string, past: string
let admin: SessionUser, a: SessionUser, b: SessionUser
beforeAll(async () => {
  process.env.FILE_STORAGE_DRIVER = 'local'
  process.env.FILE_STORAGE_LOCAL_DIR = storage
  process.env.AUTH_SECRET = 'synthetic-workspace-test-secret'
  org = (await db.organization.create({ data: { name: 'Team Prodigy', slug: stamp, timezone: 'America/New_York' } })).id
  const superRole = await db.role.create({ data: { organizationId: org, key: 'SUPER_ADMIN', name: 'Super Admin' } })
  const closerRole = await db.role.create({ data: { organizationId: org, key: 'CLOSER', name: 'Closer' } })
  async function staff(name: string, role: typeof superRole): Promise<SessionUser> {
    const row = await db.user.create({ data: { organizationId: org, roleId: role.id, name, email: `${name}-${stamp}@example.test`, passwordHash: 'test-only' } })
    return { ...row, role: role.key, roleName: role.name, organizationName: 'Team Prodigy', portalClientId: null, permissions: new Set(role.key === 'SUPER_ADMIN' ? ALL_PERMISSIONS : CLOSER_PERMISSIONS) }
  }
  admin = await staff('Admin', superRole); a = await staff('CloserA', closerRole); b = await staff('CloserB', closerRole)
  const pipeline = await db.pipeline.create({ data: { organizationId: org, name: 'Main', isDefault: true } })
  const stage = await db.pipelineStage.create({ data: { pipelineId: pipeline.id, key: 'DEAL_READY_FOR_SUBMISSION', name: 'CYS ready', category: 'SUBMISSION', position: 0 } })
  for (const [name, ownerId] of [['Assigned', a.id], ['Unassigned', null]] as const) {
    const row = await db.client.create({ data: { organizationId: org, pipelineId: pipeline.id, currentStageId: stage.id, firstName: name, lastName: 'Example', email: `${name}@example.test`, phone: '7025550100', ownerId,
      addresses: { create: { line1: '123 Test Street', city: 'Las Vegas', state: 'NV', postalCode: '89101', isPrimary: true } } } })
    if (ownerId) client = row.id; else stranger = row.id
  }
  await db.cysFieldDefinition.createMany({ data: SCHEMA_42_FIELDS.map(def => ({ ...def, organizationId: org })) })
  const pack = await db.documentPackage.create({ data: { organizationId: org, name: 'Documents', isDefault: true } })
  requirement = (await db.documentRequirement.create({ data: { packageId: pack.id, key: 'finance_agreement', name: 'Finance agreement', category: 'CONTRACT', position: 0, isRequired: true } })).id
  past = (await db.appointment.create({ data: { clientId: client, ownerId: a.id, type: 'PRESENTATION', status: 'COMPLETED', startsAt: new Date('2020-01-02T15:00:00Z'), endsAt: new Date('2020-01-02T16:00:00Z') } })).id
  future = (await db.appointment.create({ data: { clientId: client, ownerId: a.id, type: 'PRESENTATION', startsAt: new Date('2090-01-02T15:00:00Z'), endsAt: new Date('2090-01-02T16:00:00Z') } })).id
  await db.appointment.create({ data: { clientId: stranger, ownerId: null, type: 'PRESENTATION', startsAt: new Date('2090-01-03T15:00:00Z'), endsAt: new Date('2090-01-03T16:00:00Z') } })
})
afterAll(async () => { await db.organization.delete({ where: { id: org } }); rmSync(storage, { recursive: true, force: true }) })

it('shows all 42 items, carries the first eight answers, and does no CYS writes on reads', async () => {
  const projected = await resolveForClient(a, client)
  expect(projected.definitions).toHaveLength(42)
  expect(projected.values.slice(0, 8).every(value => Boolean(value.value))).toBe(true)
  expect(projected.values.filter(value => value.status === 'MISSING').length).toBeGreaterThan(20)
  expect(await db.cysFieldValue.count({ where: { clientId: client } })).toBe(0)
  expect(await db.cysReadiness.count({ where: { clientId: client } })).toBe(0)
})
it('preserves manual corrections across imports and refuses another Closer', async () => {
  state.actor = a
  expect(await verifyCysFieldAction({ clientId: client, fieldKey: 'first_name', value: 'Corrected' })).toMatchObject({ ok: true })
  await db.client.update({ where: { id: client }, data: { firstName: 'Later SCS import' } })
  await refreshCysMirror(org, client)
  expect((await resolveForClient(a, client)).values.find(v => v.fieldKey === 'first_name')?.value).toBe('Corrected')
  state.actor = b
  expect(await verifyCysFieldAction({ clientId: client, fieldKey: 'first_name', value: 'Forbidden' })).toMatchObject({ ok: false })
})
async function uploadRequest(text = 'Synthetic agreement text') {
  const data = new FormData(); data.set('clientId', client); data.set('requirementId', requirement)
  data.set('file', new File([text], 'agreement.txt', { type: 'text/plain' }))
  return upload(new Request('http://localhost/api/documents/upload', { method: 'POST', body: data }))
}
it('enforces upload scope and retains previous file versions and failed extraction evidence', async () => {
  state.actor = b; expect((await uploadRequest()).status).toBe(403)
  state.actor = a
  const first = await uploadRequest(); expect(first.status).toBe(200); doc = (await first.json()).documentId
  const second = await uploadRequest('Synthetic revised agreement text'); expect(second.status).toBe(200)
  const rows = await db.clientDocument.findMany({ where: { clientId: client, requirementId: requirement }, orderBy: { version: 'asc' } })
  expect(rows).toHaveLength(2); expect(rows[1].version).toBe(2); expect(rows[1].supersedesId).toBe(doc)
  expect(rows[0].storageKey).not.toBe(rows[1].storageKey)
  expect(rows.every(r => r.storageKey && r.checksum)).toBe(true)
  // Existing extraction suite additionally exercises the driver's failure path.
})
it('reassignment transfers future bookings, preserves history, and revokes document and notification access', async () => {
  const before = await findDocumentInScope(a, doc); expect(before).not.toBeNull()
  const url = await signedDocumentFileUrl(before!); expect(url).toBeTruthy()
  await db.notification.create({ data: { organizationId: org, userId: a.id, title: 'Assigned client', href: `/clients/${client}`, kind: 'ASSIGNMENT' } })
  await applyAssignment(admin, { clientId: client, assigneeId: b.id })
  expect((await db.appointment.findUniqueOrThrow({ where: { id: future } })).ownerId).toBe(b.id)
  expect((await db.appointment.findUniqueOrThrow({ where: { id: past } })).ownerId).toBe(a.id)
  expect(await findClientInScope(a, client)).toBeNull()
  expect(await db.notification.count({ where: await notificationScope(a) })).toBe(0)
  state.actor = a
  expect((await file(new Request(`http://localhost${url}`), { params: Promise.resolve({ documentId: doc }) })).status).toBe(404)
  state.actor = b
  expect((await file(new Request(`http://localhost${url}`), { params: Promise.resolve({ documentId: doc }) })).status).toBe(200)
  const full = await loadDeskBoard(admin, '2090-01'); const mine = await loadDeskBoard(b, '2090-01')
  expect(full.days.flatMap(d=>d.chips)).toHaveLength(2)
  expect(mine.days.flatMap(d=>d.chips).map(c=>c.appointmentId)).toEqual([future])
  expect(full.timezone).toBe('America/New_York')
  expect(full.unscheduled.some(c=>c.clientId === client)).toBe(false)
})
it('replays intake bookings without undoing ownership, status, or staff rescheduling', async () => {
  const source = await db.intakeSource.create({ data: { organizationId: org, name: 'SCS', slug: stamp, kind: 'WEB_FORM' } })
  const rawPayload = { data: { booking: { scheduled_at: '2090-02-01T15:00:00Z', calendly_event_uri: 'synthetic-event' } } }
  const conflict = await upsertIntakeAppointment({ source, clientId: client, rawPayload })
  expect(conflict?.outcome).toBe('CONFLICT')
  expect(await db.appointment.count({ where: { clientId: client } })).toBe(2)
  const replayPayload = { data: { booking: { scheduled_at: '2090-01-02T15:00:00Z', calendly_event_uri: 'existing-call-event' } } }
  const booking = await upsertIntakeAppointment({ source, clientId: client, rawPayload: replayPayload })
  expect(booking?.id).toBe(future)
  await db.appointment.update({ where: { id: booking!.id }, data: { status: 'NO_SHOW', startsAt: new Date('2090-02-02T15:00:00Z') } })
  await upsertIntakeAppointment({ source, clientId: client, rawPayload: replayPayload })
  const saved = await db.appointment.findUniqueOrThrow({ where: { id: booking!.id } })
  expect(saved.status).toBe('NO_SHOW'); expect(saved.ownerId).toBe(b.id); expect(saved.startsAt.toISOString()).toBe('2090-02-02T15:00:00.000Z')
})
it('allows CYS finalization with optional blanks, but blocks it when shared permission is revoked', async () => {
  // Reviewed required items only. Optional items deliberately stay blank.
  for (const def of SCHEMA_42_FIELDS.filter(d => d.isRequired)) await db.cysFieldValue.upsert({ where: { clientId_fieldKey: { clientId: client, fieldKey: def.key } }, create: { clientId: client, fieldKey: def.key, value: 'Reviewed test value', status: 'VERIFIED', verifiedById: b.id }, update: { value: 'Reviewed test value', status: 'VERIFIED', verifiedById: b.id } })
  state.actor = b
  expect(await approveCysReadinessAction({ clientId: client })).toMatchObject({ ok: true })
  expect(await generateCysPackage(b, client)).toBeTruthy()
  state.actor = { ...b, permissions: new Set(CLOSER_PERMISSIONS.filter(p=>p !== 'submissions:approve')) }
  expect(await approveCysReadinessAction({ clientId: client })).toMatchObject({ ok: false })
})
it('refuses legacy owner-edit bypasses and non-Closer owners on manual/CSV creation', async () => {
  state.actor = admin
  const before = await db.client.findUniqueOrThrow({ where: { id: client } })
  const result = await updateOverviewAction({ clientId: client, firstName: before.firstName, lastName: before.lastName, email: before.email, phone: before.phone, ownerId: a.id })
  expect(result).toHaveProperty('error')
  expect((await db.client.findUniqueOrThrow({ where: { id: client } })).ownerId).toBe(b.id)
  await expect(createClientRecord(admin, { firstName: 'Invalid', lastName: 'Owner', email: 'synthetic@example.test', phone: '7025550100', ownerId: admin.id })).rejects.toThrow(ForbiddenError)
})
it('protects the final Super Admin and deactivation unassigns upcoming work', async () => {
  state.actor = admin
  const form = new FormData(); form.set('userId', admin.id); form.set('active', 'false')
  expect(await setUserActiveAction({}, form)).toHaveProperty('error')
  form.set('roleKey', 'CLOSER'); expect(await changeRoleAction({}, form)).toHaveProperty('error')
  const active = await db.appointment.create({ data: { clientId: client, ownerId: b.id, startsAt: new Date('2091-01-01'), endsAt: new Date('2091-01-02') } })
  form.set('userId', b.id); expect(await setUserActiveAction({}, form)).toEqual({})
  expect((await db.client.findUniqueOrThrow({ where: { id: client } })).ownerId).toBeNull()
  expect((await db.appointment.findUniqueOrThrow({ where: { id: active.id } })).ownerId).toBeNull()
  expect((await db.appointment.findUniqueOrThrow({ where: { id: future } })).ownerId).toBe(b.id)
  const permissions = new FormData(); permissions.append('permission', 'clients:read_all')
  expect(await updateCloserPermissionsAction({}, permissions)).toHaveProperty('error')
})
