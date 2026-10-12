import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { ROLE_PERMISSIONS } from '@/lib/permissions'
import type { RoleKey } from '@prisma/client'
import type { SessionUser } from '@/lib/rbac'
import { ingestCallCenterMetaLead } from './meta-ingest'
import { SCS_ENGLISH_PAGE_ID } from './meta-route'
import { callRepId, isReady, loadTeamToday, loadTodayStats, shortName } from './team'

// Monday 2026-10-12 12:00 PT.
const NOW = new Date('2026-10-12T19:00:00Z')
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000)
const run = `ccteam-${Date.now().toString(36)}`

function sessionUser(id: string, orgId: string, roleId: string, role: RoleKey, name: string): SessionUser {
  return {
    id, name, email: `${id}@example.test`, organizationId: orgId, organizationName: 'Team test', roleId, role,
    roleName: role, isOwner: role === 'SUPER_ADMIN', regionId: null, teamId: null, managerId: null, avatarUrl: null,
    title: null, permissions: new Set(ROLE_PERMISSIONS[role]), portalClientId: null,
  }
}

describe('team helpers', () => {
  it('shortens names, finds the rep on a call and reads presence', () => {
    expect(shortName('Nate Fuller')).toBe('Nate F.')
    expect(shortName('Mara de la Cruz')).toBe('Mara C.')
    expect(shortName('Cher')).toBe('Cher')
    expect(shortName('  ')).toBeNull()
    expect(callRepId({ userId: 'u1', answeredBy: null })).toBe('u1')
    expect(callRepId({ userId: null, answeredBy: 'browser:u2' })).toBe('u2')
    expect(callRepId({ userId: null, answeredBy: 'voicemail' })).toBeNull()
    expect(isReady({ state: 'ready', lastSeenAt: ago(1) }, NOW)).toBe(true)
    expect(isReady({ state: 'ready', lastSeenAt: ago(3) }, NOW)).toBe(false)
    expect(isReady({ state: 'offline', lastSeenAt: ago(0) }, NOW)).toBe(false)
    expect(isReady(undefined, NOW)).toBe(false)
  })
})

describe('team loaders', () => {
  let orgId = ''
  let admin: SessionUser
  let closer: SessionUser
  const userIds: string[] = []
  const lead = { nate: '', mara: '' }

  async function call(data: Record<string, unknown>) {
    return db.voiceCall.create({
      data: {
        organizationId: orgId,
        callSid: `CA${run}${Math.random().toString(36).slice(2, 10)}`,
        accountSid: 'AC_test_team',
        direction: 'OUTBOUND',
        status: 'completed',
        ...data,
      },
    })
  }

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: `Team ${run}`, slug: run } })
    orgId = org.id
    const superRole = await db.role.create({ data: { organizationId: orgId, key: 'SUPER_ADMIN', name: 'Super Admin' } })
    const closerRole = await db.role.create({ data: { organizationId: orgId, key: 'CLOSER', name: 'Closer' } })
    const mk = (name: string, roleId: string, tag: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { organizationId: orgId, roleId, name, email: `${tag}-${run}@example.test`, passwordHash: 'x', ...extra } })
    const clientRole = await db.role.create({ data: { organizationId: orgId, key: 'CLIENT', name: 'Client' } })
    const [h, g, gone, portal] = await Promise.all([
      mk('Hector Owner', superRole.id, 'h'),
      mk('Gatsby Rep', closerRole.id, 'g'),
      mk('Former Rep', closerRole.id, 'f', { isActive: false }),
      mk('Portal Client', clientRole.id, 'c'),
    ])
    userIds.push(h.id, g.id, gone.id, portal.id)
    admin = sessionUser(h.id, orgId, superRole.id, 'SUPER_ADMIN', h.name)
    closer = sessionUser(g.id, orgId, closerRole.id, 'CLOSER', g.name)

    for (const [key, name, phone] of [['nate', 'Nate Fuller', '+1 702 555 0201'], ['mara', 'Mara Ellison', '+1 702 555 0202']] as const) {
      const saved = await ingestCallCenterMetaLead({
        organizationId: orgId,
        pageId: SCS_ENGLISH_PAGE_ID,
        lead: { leadgenId: `${run}-${key}`, createdTime: ago(600).toISOString(), fields: { full_name: name, phone_number: phone, zip_code: '89117' } },
      })
      lead[key] = saved.leadId
    }

    await db.voicePresence.create({ data: { userId: g.id, organizationId: orgId, identity: `pf_${orgId}_${g.id}`, state: 'ready', lastSeenAt: ago(1) } })
    await db.voicePresence.create({ data: { userId: h.id, organizationId: orgId, identity: `pf_${orgId}_${h.id}`, state: 'ready', lastSeenAt: ago(30) } })

    // Gatsby takes Nate, calls him (answered, 2:14), books and confirms a visit; Mara calls in and is missed.
    await db.callCenterEvent.create({ data: { leadId: lead.nate, type: 'LOCK', body: JSON.stringify({ action: 'take', userId: g.id, name: g.name, label: 'Lock' }), createdAt: ago(60) } })
    await call({ callCenterLeadId: lead.nate, userId: g.id, outcome: 'CONNECTED', startedAt: ago(50), answeredAt: ago(50), endedAt: ago(48), talkSeconds: 134, remoteLast4: '0201' })
    await db.callCenterEvent.create({ data: { leadId: lead.nate, type: 'OUTCOME', body: JSON.stringify({ label: 'Appointment', detail: 'Moved to booked' }), createdAt: ago(47) } })
    await db.callCenterSlot.create({
      data: { organizationId: orgId, leadId: lead.nate, repKey: 'gatsby', startsAt: new Date('2026-10-15T16:00:00Z'), endsAt: new Date('2026-10-15T17:30:00Z'), status: 'CONFIRMED', createdAt: ago(46), confirmedAt: ago(45), confirmedById: g.id },
    })
    await call({ direction: 'INBOUND', callCenterLeadId: lead.mara, status: 'no-answer', outcome: 'NO_ANSWER', startedAt: ago(20), endedAt: ago(19), remoteLast4: '0202' })
    await call({ direction: 'INBOUND', status: 'completed', outcome: 'VOICEMAIL', recordingKind: 'voicemail', startedAt: ago(10), endedAt: ago(9), remoteLast4: '4321' })
    await db.callCenterEvent.create({ data: { leadId: lead.mara, type: 'SMS', direction: 'in', body: 'Hi, call me', createdAt: ago(5) } })
    // Yesterday: not today's work. Next week: not this week's bookings.
    await call({ callCenterLeadId: lead.mara, userId: g.id, outcome: 'NO_ANSWER', startedAt: ago(60 * 24), endedAt: ago(60 * 24) })
    await db.callCenterSlot.create({
      data: { organizationId: orgId, leadId: lead.mara, repKey: 'gatsby', startsAt: new Date('2026-10-20T16:00:00Z'), endsAt: new Date('2026-10-20T17:30:00Z'), status: 'HOLD', createdAt: ago(60 * 30) },
    })
  })

  afterAll(async () => {
    if (userIds.length) await db.voicePresence.deleteMany({ where: { userId: { in: userIds } } })
    if (orgId) await db.organization.delete({ where: { id: orgId } })
  })

  it('writes the team feed newest first, in plain words, without full numbers', async () => {
    const today = await loadTeamToday(closer, NOW)
    expect(today.feed.map((row) => row.text)).toEqual([
      'Mara E. texted',
      '•••-•••-4321 called in · left a voicemail',
      'Mara E. called in · missed',
      'Gatsby confirmed Nate F. for Thu 9:00 AM',
      'Gatsby booked Nate F. for Thu 9:00 AM',
      'Gatsby marked Nate F. · Appointment',
      'Gatsby called Nate F. · 2:14 · answered',
    ])
    expect(today.count).toBe(7)
    expect(JSON.stringify(today)).not.toMatch(/555|0201|0202/)
  })

  it('lists every active user with presence and today\'s numbers, the same for a closer and an admin', async () => {
    const forCloser = await loadTeamToday(closer, NOW)
    const forAdmin = await loadTeamToday(admin, NOW)
    expect(forCloser.members).toEqual(forAdmin.members)
    expect(forCloser.members.map((m) => [m.name, m.role, m.ready, m.calls, m.talkSeconds, m.booked])).toEqual([
      ['Gatsby Rep', 'Closer', true, 1, 134, 1],
      ['Hector Owner', 'Super Admin', false, 0, 0, 0],
    ])
    expect(forCloser.members[0].lastAt).toBe(ago(45).toISOString())
    expect(forCloser.members[1].lastAt).toBeNull()
  })

  it('counts this week\'s visits, today\'s confirmations and each lead\'s next visit', async () => {
    const stats = await loadTodayStats(closer, NOW)
    expect(stats.bookedWeek).toBe(1)
    expect(stats.confirmedToday).toBe(1)
    expect(stats.appointments).toEqual({
      [lead.nate]: '2026-10-15T16:00:00.000Z',
      [lead.mara]: '2026-10-20T16:00:00.000Z',
    })
  })
})
