/**
 * The 20 s refresh's change check (lib/call-center/desk-version.ts): the
 * fingerprint moves with anything the desk shows and stays put otherwise,
 * a phone heartbeat included.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/chat-bridge/remote', () => ({ teamChatCounts: async () => ({ total: 0, mentions: 0, cases: {} }) }))

import { db } from '@/lib/db'
import { deskVersion } from '@/lib/call-center/desk-version'
import { makeOrg, makeUser } from './fixtures/telephony'

const run = `dver-${Date.now().toString(36)}`
let orgId = ''
let leadId = ''
let user: Awaited<ReturnType<typeof makeUser>>['actor']
let other = ''
const now = new Date('2026-10-13T19:00:00.000Z')

beforeAll(async () => {
  orgId = (await makeOrg(run, 'Version')).orgId
  user = (await makeUser(orgId, run, 'Owner', 'SUPER_ADMIN')).actor
  other = (await makeUser(orgId, run, 'Rep', 'CLOSER')).id
  const lead = await db.callCenterLead.create({
    data: { organizationId: orgId, source: 'FORM', language: 'EN', status: 'WAITING', phoneLast4: '0199', events: { create: { type: 'FORM', body: '{}' } } },
  })
  leadId = lead.id
})

afterAll(async () => {
  await db.callCenterEvent.deleteMany({ where: { lead: { organizationId: orgId } } })
  await db.callCenterLead.deleteMany({ where: { organizationId: orgId } })
  await db.voicePresence.deleteMany({ where: { organizationId: orgId } })
})

describe('deskVersion', () => {
  it('is stable while nothing changes', async () => {
    expect(await deskVersion(user, now)).toBe(await deskVersion(user, now))
  })

  it('moves with a lead update, a new trail line and a text marked read', async () => {
    const v0 = await deskVersion(user, now)
    await db.callCenterLead.update({ where: { id: leadId }, data: { tries: 1 } })
    const v1 = await deskVersion(user, now)
    expect(v1).not.toBe(v0)
    const sms = await db.callCenterEvent.create({ data: { leadId, type: 'SMS', direction: 'IN', body: '{}' } })
    const v2 = await deskVersion(user, now)
    expect(v2).not.toBe(v1)
    await db.callCenterEvent.update({ where: { id: sms.id }, data: { readAt: new Date() } })
    expect(await deskVersion(user, now)).not.toBe(v2)
  })

  it('ignores a heartbeat but sees a rep become ready or drop off', async () => {
    const v0 = await deskVersion(user, now)
    await db.voicePresence.create({ data: { userId: other, organizationId: orgId, identity: `pf_${orgId}_${other}`, state: 'ready', lastSeenAt: new Date(now.getTime() - 30_000) } })
    const ready = await deskVersion(user, now)
    expect(ready).not.toBe(v0)
    // Another heartbeat a few seconds later: still ready, same fingerprint.
    await db.voicePresence.update({ where: { userId_organizationId: { userId: other, organizationId: orgId } }, data: { lastSeenAt: new Date(now.getTime() - 5_000) } })
    expect(await deskVersion(user, now)).toBe(ready)
    // Three minutes later with no heartbeat: no longer ready on the Team list.
    expect(await deskVersion(user, new Date(now.getTime() + 3 * 60_000))).not.toBe(ready)
  })

  it('moves at midnight Pacific (Today counts reset)', async () => {
    const late = new Date('2026-10-14T06:59:00.000Z')
    const after = new Date('2026-10-14T07:01:00.000Z')
    expect(await deskVersion(user, late)).not.toBe(await deskVersion(user, after))
  })
})
