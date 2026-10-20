import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { syncAssignedSunoffLeads } from './assigned'
import { assignmentSnapshot, sunoffLeadId } from './assigned-model'
import { loadCallCenterLeadsFor, revealCallCenterContactFor, takeCallCenterLeadFor } from '@/lib/call-center/desk'
import { listSlotsBetween, listToSchedule, confirmSlot, rescheduleSlot } from '@/lib/call-center/calendar/service'
import { assignedCalendarChips } from './assigned-calendar'
import { signBridgeRequest } from './sign'
import { POST } from '@/app/api/bridge/sunoff/leads/route'
import type { SessionUser } from '@/lib/rbac'
import { resolveDialTarget } from '@/lib/telephony/targets'
import { recordCallCenterNoteFor } from '@/lib/call-center/desk'
import { readSecret } from '@/lib/call-center/contact'

const run = `sunoff-assigned-${Date.now().toString(36)}`, NOW = Date.now(), APPT = NOW + 86_400_000
const KEY = 'test-only-sunoff-assignment-signature-key'
const lead = { id: 'meta_9123456789012345', brand: 'sunoff', userId: '63', name: 'Sample Homeowner', phone: '+17025550123',
  email: 'sample@example.test', address: '123 Example St, Las Vegas, NV 89117', language: 'EN', createdAt: NOW - 10000,
  updatedAt: NOW - 1000, appointmentAt: APPT, followupAt: null, stage: 'Scheduled', closed: false, doNotCall: false,
  consent: { source: 'meta', at: NOW - 10000, formId: 'example-form', version: 'test-consent-v1', revokedAt: null, expiresAt: null } }

describe('SunOff assigned leads in the separate ProdigyFlo CRM', () => {
  let org = '', stranger = '', gatsby = '', dakota = '', id = ''
  let people: { id: string; name: string; email: string; organizationId: string }[] = []
  const viewer = (userId: string, organizationId = org, role = 'SUPER_ADMIN') => ({ id: userId, organizationId, role } as SessionUser)
  async function sync(leads: unknown[], revision: number) {
    // Only identity discovery is substituted. Records, transactions, encryption and calendar reads use the local test DB.
    vi.spyOn(db.user, 'findMany').mockResolvedValueOnce(people as never)
    return syncAssignedSunoffLeads({ version: 1, complete: true, revision, leads })
  }
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error('Local test DB required')
    const a = await db.organization.create({ data: { name: run, slug: run } }); org = a.id
    stranger = (await db.organization.create({ data: { name: `${run}-other`, slug: `${run}-other` } })).id
    const role = await db.role.create({ data: { organizationId: org, key: 'SUPER_ADMIN', name: 'Admin' } })
    const create = (name: string) => db.user.create({ data: { name, email: `${name.toLowerCase()}-${run}@example.test`, organizationId: org, roleId: role.id, passwordHash: 'synthetic-only' } })
    gatsby = (await create('Gatsby')).id; dakota = (await create('Dakota')).id
    people = [{ id: gatsby, name: 'Gatsby', email: 'itsgatsby@protonmail.com', organizationId: org },
      { id: dakota, name: 'Dakota', email: 'dakota.hanshew@gmail.com', organizationId: org }]
    id = sunoffLeadId(org, lead.id)
  })
  afterAll(async () => { vi.restoreAllMocks(); for (const id of [org, stranger]) if (id) await db.organization.delete({ where: { id } }) })

  it('rejects partial feeds, foreign brands, foreign reps and duplicate source ids', () => {
    for (const bad of [{ complete: false }, { leads: [{ ...lead, brand: 'arista' }] }, { leads: [{ ...lead, userId: '1' }] }, { leads: [lead, lead] }])
      expect(assignmentSnapshot.safeParse({ version: 1, complete: true, revision: NOW, leads: [lead], ...bad }).success).toBe(false)
  })
  it('imports an encrypted callable lead, assigns Gatsby and labels both calendars', async () => {
    expect(await sync([lead], NOW)).toMatchObject({ ok: true, created: 1 })
    const row = await db.callCenterLead.findUniqueOrThrow({ where: { id } })
    expect(row.lockedBy).toBe(gatsby); expect(JSON.stringify(row.phoneSecret)).not.toContain('7025550123')
    expect(readSecret(row.phoneSecret)).toBe('+17025550123')
    expect((await revealCallCenterContactFor(org, gatsby, id)).phone).toBe('+17025550123')
    expect((await revealCallCenterContactFor(org, dakota, id)).phone).toBeNull()
    expect((await loadCallCenterLeadsFor(org, gatsby)).find(l => l.id === id)).toMatchObject({ name: 'Sample Homeowner', sourceBrand: 'SunOff', lockedBy: gatsby })
    const visits = await listSlotsBetween(org, new Date(NOW), new Date(APPT + 1))
    expect(visits).toHaveLength(1); expect(visits[0]).toMatchObject({ sourceBrand: 'SunOff', repKey: 'gatsby' })
    const chips = await assignedCalendarChips(viewer(gatsby), new Date(NOW), new Date(APPT + 1), 'America/Los_Angeles')
    expect(chips[0].chip).toMatchObject({ sourceBrand: 'SunOff', sourceLeadId: id, ownerName: 'Gatsby' })
    expect(await assignedCalendarChips(viewer(gatsby, stranger), new Date(NOW), new Date(APPT + 1), 'America/Los_Angeles')).toEqual([])
    expect(await assignedCalendarChips(viewer(dakota, org, 'CLOSER'), new Date(NOW), new Date(APPT + 1), 'America/Los_Angeles')).toEqual([])
    expect(await db.client.count({ where: { organizationId: org } })).toBe(0)
  })
  it('lets the workspace owner call and note without stealing the assignment, while other reps stay locked out', async () => {
    const owner = viewer('owner-test')
    expect((await resolveDialTarget(owner, { kind: 'lead', id })).ok).toBe(true)
    expect((await resolveDialTarget(viewer(dakota, org, 'CLOSER'), { kind: 'lead', id })).ok).toBe(false)
    expect((await resolveDialTarget(viewer('foreign-owner', stranger), { kind: 'lead', id })).ok).toBe(false)
    expect((await revealCallCenterContactFor(org, owner.id, id, owner.role)).phone).toBe('+17025550123')
    expect((await recordCallCenterNoteFor(org, { id: owner.id, name: 'Owner', role: 'SUPER_ADMIN' }, id, 'Owner checked the assigned lead')).ok).toBe(true)
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id } })).lockedBy).toBe(gatsby)
  })
  it('dedupes repeated and out-of-order snapshots and retains local notes', async () => {
    await db.callCenterEvent.create({ data: { leadId: id, type: 'NOTE', body: 'Keep this native note' } })
    expect(await sync([lead], NOW)).toMatchObject({ ok: true, ignored: true })
    expect(await sync([], NOW - 1)).toMatchObject({ ok: true, ignored: true })
    await sync([lead], NOW + 1)
    expect(await db.callCenterLead.count({ where: { organizationId: org } })).toBe(1)
    expect(await db.callCenterSlot.count({ where: { organizationId: org } })).toBe(1)
    expect(await db.callCenterEvent.count({ where: { leadId: id, body: 'Keep this native note' } })).toBe(1)
  })
  it('moves assignment to Dakota and moves the same visit without duplicates', async () => {
    await sync([{ ...lead, userId: '169', appointmentAt: APPT + 3_600_000, updatedAt: NOW + 2 }], NOW + 3)
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id } })).lockedBy).toBe(dakota)
    expect((await revealCallCenterContactFor(org, gatsby, id)).phone).toBeNull()
    expect((await revealCallCenterContactFor(org, dakota, id)).phone).toBe('+17025550123')
    const slot = await db.callCenterSlot.findFirstOrThrow({ where: { leadId: id } })
    expect(slot.repKey).toBe('dakota'); expect(slot.startsAt.getTime()).toBe(APPT + 3_600_000)
    expect((await confirmSlot({ organizationId: org, slotId: slot.id, userId: dakota })).ok).toBe(false)
    expect((await rescheduleSlot({ organizationId: org, slotId: slot.id, userId: dakota, repKey: 'dakota', startsAt: new Date(APPT) })).ok).toBe(false)
  })
  it('removes an assignment without deleting history or inventing do-not-call', async () => {
    expect(await sync([], NOW + 4)).toMatchObject({ ok: true, removed: 1 })
    const row = await db.callCenterLead.findUniqueOrThrow({ where: { id } })
    expect(row.doNotCallAt).toBeNull(); expect(readSecret(row.phoneSecret)).toBe('+17025550123'); expect(row.lockedBy).toBeNull()
    expect(await loadCallCenterLeadsFor(org, gatsby)).toEqual([])
    expect(await listToSchedule(org)).toEqual([])
    expect((await takeCallCenterLeadFor(org, { id: gatsby, name: 'Gatsby' }, id)).ok).toBe(false)
    expect(await db.callCenterEvent.count({ where: { leadId: id, body: 'Keep this native note' } })).toBe(1)
  })
  it('brings reassigned leads back and preserves an existing opt-out', async () => {
    await sync([{ ...lead, appointmentAt: null }], NOW + 5)
    expect((await listToSchedule(org)).map(l => l.id)).toContain(id)
    await db.callCenterLead.update({ where: { id }, data: { doNotCallAt: new Date(NOW) } })
    await sync([{ ...lead, consent: null }], NOW + 6)
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id } })).doNotCallAt?.getTime()).toBe(NOW)
    expect((await revealCallCenterContactFor(org, gatsby, id)).phone).toBeNull()
  })
  it('refuses cross-workspace partner identities before writing', async () => {
    vi.spyOn(db.user, 'findMany').mockResolvedValueOnce([{ ...people[0] }, { ...people[1], organizationId: stranger }] as never)
    expect(await syncAssignedSunoffLeads({ version: 1, complete: true, revision: NOW + 7, leads: [lead] })).toMatchObject({ ok: false, error: 'partner_workspace_mismatch' })
  })
  it('requires a fresh valid signature at the actual route boundary', async () => {
    vi.stubEnv('PF_SUNOFF_BRIDGE_KEY', KEY)
    const path = '/api/bridge/sunoff/leads', body = JSON.stringify({ version: 1, complete: false, revision: NOW, leads: [] })
    expect((await POST(new Request(`https://pf.test${path}`, { method: 'POST', body }))).status).toBe(401)
    const signed = signBridgeRequest({ key: KEY, method: 'POST', path, body })
    expect((await POST(new Request(`https://pf.test${path}`, { method: 'POST', body, headers: signed }))).status).toBe(400)
    expect((await POST(new Request(`https://pf.test${path}`, { method: 'POST', body: body + ' ', headers: signed }))).status).toBe(401)
    vi.unstubAllEnvs()
  })
})
