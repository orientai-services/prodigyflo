import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { ROLE_PERMISSIONS } from '@/lib/permissions'
import type { RoleKey } from '@prisma/client'
import type { SessionUser } from '@/lib/rbac'
import type { HistoryFilter } from './history-format'
import { ingestCallCenterMetaLead } from './meta-ingest'
import { SCS_ENGLISH_PAGE_ID } from './meta-route'
import { loadActivity, loadHistory } from './history'

// Monday 2026-10-12 12:00 PT.
const NOW = new Date('2026-10-12T19:00:00Z')
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000)
const run = `cchist-${Date.now().toString(36)}`
const REC = 're0123456789abcdef0123456789abcdef'.replace(/^re/, 'RE')

function sessionUser(id: string, orgId: string, roleId: string, role: RoleKey, name: string): SessionUser {
  return {
    id, name, email: `${id}@example.test`, organizationId: orgId, organizationName: 'History test', roleId, role,
    roleName: role, isOwner: role === 'SUPER_ADMIN', regionId: null, teamId: null, managerId: null, avatarUrl: null,
    title: null, permissions: new Set(ROLE_PERMISSIONS[role]), portalClientId: null,
  }
}

describe('call center history loaders', () => {
  let orgId = ''
  let admin: SessionUser
  let avery: SessionUser
  let blake: SessionUser
  const lead = { nate: '', mara: '' }
  const client = { cara: '', bo: '' }

  async function call(data: Record<string, unknown>) {
    return db.voiceCall.create({
      data: {
        organizationId: orgId,
        callSid: `CA${run}${Math.random().toString(36).slice(2, 10)}`,
        accountSid: 'AC_test_history',
        direction: 'OUTBOUND',
        status: 'completed',
        ...data,
      },
    })
  }

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: `History ${run}`, slug: run } })
    orgId = org.id
    const superRole = await db.role.create({ data: { organizationId: orgId, key: 'SUPER_ADMIN', name: 'Super Admin' } })
    const closerRole = await db.role.create({ data: { organizationId: orgId, key: 'CLOSER', name: 'Closer' } })
    const mk = (name: string, roleId: string, tag: string) =>
      db.user.create({ data: { organizationId: orgId, roleId, name, email: `${tag}-${run}@example.test`, passwordHash: 'x' } })
    const [a, b, c] = await Promise.all([mk('Hector Owner', superRole.id, 'h'), mk('Avery Rep', closerRole.id, 'a'), mk('Blake Rep', closerRole.id, 'b')])
    admin = sessionUser(a.id, orgId, superRole.id, 'SUPER_ADMIN', a.name)
    avery = sessionUser(b.id, orgId, closerRole.id, 'CLOSER', b.name)
    blake = sessionUser(c.id, orgId, closerRole.id, 'CLOSER', c.name)

    for (const [key, name, phone] of [['nate', 'Nate Fuller', '+1 702 555 0101'], ['mara', 'Mara Ellison', '+1 702 555 0102']] as const) {
      const saved = await ingestCallCenterMetaLead({
        organizationId: orgId,
        pageId: SCS_ENGLISH_PAGE_ID,
        lead: { leadgenId: `${run}-${key}`, createdTime: ago(600).toISOString(), fields: { full_name: name, phone_number: phone, zip_code: '89117' } },
      })
      lead[key] = saved.leadId
    }
    await db.callCenterLead.update({ where: { id: lead.nate }, data: { lockedBy: avery.id } })

    const pipeline = await db.pipeline.create({ data: { organizationId: orgId, name: 'History pipeline' } })
    const stage = await db.pipelineStage.create({ data: { pipelineId: pipeline.id, key: 'NEW_LEAD', name: 'New lead', category: 'INTAKE', position: 0 } })
    const base = { organizationId: orgId, pipelineId: pipeline.id, currentStageId: stage.id }
    client.cara = (await db.client.create({ data: { ...base, ownerId: avery.id, firstName: 'Cara', lastName: 'Client', email: `cara-${run}@example.test`, phone: '+17025550199' } })).id
    client.bo = (await db.client.create({ data: { ...base, ownerId: blake.id, firstName: 'Bo', lastName: 'Other', email: `bo-${run}@example.test`, phone: '+17025550188' } })).id

    // Calls
    await call({ callCenterLeadId: lead.nate, userId: avery.id, outcome: 'CONNECTED', startedAt: ago(10), answeredAt: ago(10), endedAt: ago(8), talkSeconds: 125, recordingSid: REC, recordingDurationSeconds: 125, recordingKind: 'call', remoteLast4: '0101' })
    await call({ direction: 'INBOUND', status: 'no-answer', outcome: 'NO_ANSWER', startedAt: ago(20), endedAt: ago(19), remoteLast4: '4321', needsAction: true })
    await call({ direction: 'INBOUND', callCenterLeadId: lead.mara, outcome: 'VOICEMAIL', startedAt: ago(30), endedAt: ago(29), recordingSid: REC.replace('RE0', 'RE1'), recordingKind: 'voicemail', recordingDurationSeconds: 22, transcript: 'Call me back at 702 555 0102', remoteLast4: '0102' })
    await call({ clientId: client.bo, userId: blake.id, outcome: 'BUSY', startedAt: ago(40), endedAt: ago(40), remoteLast4: '0188' })

    // Texts
    const comm = await db.communication.create({
      data: { clientId: client.cara, channel: 'SMS', direction: 'INBOUND', status: 'RECEIVED', body: 'Call me at 702-555-0199 please', occurredAt: ago(5) },
    })
    expect(comm.id).toBeTruthy()
    await db.callCenterEvent.create({
      data: { leadId: lead.nate, type: 'SMS', body: JSON.stringify({ label: 'Text', detail: 'On my way at 3', userId: avery.id }), createdAt: ago(15) },
    })

    // Activity: Avery takes Nate, records a result, holds and confirms a visit; Do-not-call audit.
    await db.callCenterEvent.create({ data: { leadId: lead.nate, type: 'LOCK', body: JSON.stringify({ action: 'take', userId: avery.id, name: avery.name, label: 'Lock' }), createdAt: ago(12) } })
    await db.callCenterEvent.create({ data: { leadId: lead.nate, type: 'LOCK', body: JSON.stringify({ action: 'skip', userId: blake.id, name: blake.name, label: 'Lock', detail: 'Skipped' }), createdAt: ago(11) } })
    await db.callCenterEvent.create({ data: { leadId: lead.nate, type: 'OUTCOME', body: JSON.stringify({ label: 'Booked', detail: 'Visit booked' }), createdAt: ago(7) } })
    await db.callCenterSlot.create({
      data: { organizationId: orgId, leadId: lead.nate, repKey: 'gatsby', startsAt: new Date('2026-10-15T16:00:00Z'), endsAt: new Date('2026-10-15T17:30:00Z'), status: 'CONFIRMED', createdAt: ago(6), confirmedAt: ago(4), confirmedById: avery.id },
    })
    await db.auditEvent.create({
      data: { organizationId: orgId, actorId: admin.id, action: 'telephony.suppression_added', entityType: 'CallCenterLead', entityId: lead.mara, summary: 'Number ending 0102 added to the do-not-call list', createdAt: ago(3) },
    })
    await db.auditEvent.create({ data: { organizationId: orgId, actorId: admin.id, action: 'org.renamed', entityType: 'Organization', createdAt: ago(2) } })
  })

  afterAll(async () => {
    if (orgId) await db.organization.delete({ where: { id: orgId } })
  })

  it('shows a super admin every call and text, named, newest first, with no full numbers', async () => {
    const page = await loadHistory(admin, {}, NOW)
    expect(page.nextCursor).toBeNull()
    expect(page.rows.map((r) => [r.kind, r.name])).toEqual([
      ['sms-in', 'Cara Client'],
      ['out', 'Nate Fuller'],
      ['sms-out', 'Nate Fuller'],
      ['missed', '•••-•••-4321'],
      ['voicemail', 'Mara Ellison'],
      ['out', 'Bo Other'],
    ])
    const [text, connected, leadText, missed, voicemail, busy] = page.rows
    expect(text.text).toBe('Call me at •••-•••-0199 please')
    expect(text.href).toBe(`/clients/${client.cara}`)
    expect(connected).toMatchObject({ rep: 'Avery', seconds: 125, status: null, day: 'Mon 12', href: `/call-center?lead=${encodeURIComponent(lead.nate)}` })
    expect(connected.recording?.src).toMatch(/^\/api\/voice\/recordings\//)
    expect(leadText).toMatchObject({ text: 'On my way at 3', rep: 'Avery' })
    expect(missed).toMatchObject({ status: 'Missed', href: null, recording: null, seconds: null })
    expect(voicemail).toMatchObject({ seconds: 22, transcript: 'Call me back at •••-•••-0102' })
    expect(busy).toMatchObject({ status: 'Busy', rep: 'Blake' })
    const json = JSON.stringify(page)
    for (const digits of ['5550101', '5550102', '5550199', '5550188', '555-0199', REC]) expect(json).not.toContain(digits)
  })

  it('filters by chip', async () => {
    const kinds = async (filter: HistoryFilter) => (await loadHistory(admin, { filter }, NOW)).rows.map((r) => r.name)
    expect(await kinds('calls')).toEqual(['Nate Fuller', '•••-•••-4321', 'Mara Ellison', 'Bo Other'])
    expect(await kinds('answered')).toEqual(['Nate Fuller'])
    expect(await kinds('missed')).toEqual(['•••-•••-4321', 'Mara Ellison'])
    expect(await kinds('sms')).toEqual(['Cara Client', 'Nate Fuller'])
    expect(await kinds('unattached')).toEqual(['•••-•••-4321'])
  })

  it('searches by name or last 4', async () => {
    const names = async (q: string) => (await loadHistory(admin, { q }, NOW)).rows.map((r) => `${r.kind}:${r.name}`)
    expect(await names('nate ful')).toEqual(['out:Nate Fuller', 'sms-out:Nate Fuller'])
    expect(await names('4321')).toEqual(['missed:•••-•••-4321'])
    expect(await names('0199')).toEqual(['sms-in:Cara Client'])
    expect(await names('cara')).toEqual(['sms-in:Cara Client'])
    expect(await names('nobody here')).toEqual([])
  })

  it('shows a closer only their own calls, clients and held leads', async () => {
    const mine = await loadHistory(avery, {}, NOW)
    expect(mine.rows.map((r) => `${r.kind}:${r.name}`)).toEqual(['sms-in:Cara Client', 'out:Nate Fuller', 'sms-out:Nate Fuller'])
    const other = await loadHistory(blake, {}, NOW)
    expect(other.rows.map((r) => `${r.kind}:${r.name}`)).toEqual(['out:Bo Other'])
  })

  it('pages 50 at a time with no gaps or repeats', async () => {
    await db.voiceCall.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        organizationId: orgId,
        callSid: `CA${run}page${i}`,
        accountSid: 'AC_test_history',
        direction: 'OUTBOUND' as const,
        status: 'completed',
        outcome: 'NO_ANSWER' as const,
        userId: blake.id,
        remoteLast4: '7777',
        // The last seven share one timestamp, so the page boundary lands on a tie.
        startedAt: ago(100 + Math.min(i, 48)),
      })),
    })
    const first = await loadHistory(admin, { q: '7777' }, NOW)
    expect(first.rows).toHaveLength(50)
    expect(first.nextCursor).toBeTruthy()
    const second = await loadHistory(admin, { q: '7777', cursor: first.nextCursor }, NOW)
    expect(second.rows).toHaveLength(5)
    expect(second.nextCursor).toBeNull()
    const keys = [...first.rows, ...second.rows].map((r) => r.key)
    expect(new Set(keys).size).toBe(55)
  })

  it('lists desk activity with who and when, scoped like calls', async () => {
    const page = await loadActivity(admin, {}, NOW)
    const lines = page.rows.map((r) => `${r.title}|${r.subject}|${r.who}`)
    // Form rows are stamped with the real clock at ingest, so they are checked apart from the seeded ones.
    const forms = lines.filter((l) => l.startsWith('New lead|'))
    expect(lines.filter((l) => !forms.includes(l))).toEqual([
      'Added to Do not call|Mara Ellison|Hector',
      'Visit confirmed|Nate Fuller|Avery',
      'Visit held|Nate Fuller|Avery',
      'Booked|Nate Fuller|Avery',
      'Took the lead|Nate Fuller|Avery',
    ])
    expect(forms.sort()).toEqual(['New lead|Mara Ellison|Facebook', 'New lead|Nate Fuller|Facebook'])
    expect(page.rows.find((r) => r.title === 'Added to Do not call')?.detail).toBe('Number ending 0102 added to the do-not-call list')
    expect(page.rows.find((r) => r.kind === 'hold')?.detail).toBe('Thu, Oct 15, 9:00 AM · Gatsby')

    const averyLines = (await loadActivity(avery, {}, NOW)).rows.map((r) => r.title)
    expect(averyLines.filter((t) => t !== 'New lead')).toEqual(['Visit confirmed', 'Visit held', 'Booked', 'Took the lead'])
    expect(averyLines.filter((t) => t === 'New lead')).toHaveLength(1)
    expect((await loadActivity(blake, {}, NOW)).rows).toEqual([])
  })
})
