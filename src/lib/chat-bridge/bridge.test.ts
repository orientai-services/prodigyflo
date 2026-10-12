import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { makeOrg, makeUser, stubTelephonyEnv, testNumber } from '../../../tests/fixtures/telephony'
import { ingestCallCenterMetaLead } from '@/lib/call-center/meta-ingest'
import { SCS_ENGLISH_PAGE_ID } from '@/lib/call-center/meta-route'
import { buildCaseFeed } from './cases'
import { parseCaseSms, sendCaseSms } from './sms'

/**
 * The chat bridge against the test DB (docs/CYS_BRIDGE.md §B4): the case feed
 * lists only leads held by a linked rep, with linked Super Admins as watchers
 * and the last four digits only; case-sms is refused without a link, by a
 * non-holder, without consent, on do-not-call and while texting is the mock,
 * and a replayed request never sends twice.
 */

const mockMode = vi.hoisted(() => ({ on: true }))
vi.mock('@/lib/messaging', async (orig) => {
  const real = await orig<typeof import('@/lib/messaging')>()
  return { ...real, isMockMode: () => mockMode.on }
})

const run = `ccchat-${Date.now().toString(36)}`
// Tuesday Oct 13, 10:00 in Las Vegas: inside the texting window.
const OPEN = new Date('2026-10-13T17:00:00.000Z')

describe('chat bridge', () => {
  let orgId = ''
  let heldLead = ''
  let otherLead = ''
  let admin: Awaited<ReturnType<typeof makeUser>>
  let rep: Awaited<ReturnType<typeof makeUser>>
  let other: Awaited<ReturnType<typeof makeUser>>
  const phone = testNumber(run, 1)

  beforeAll(async () => {
    const org = await makeOrg(run, 'Chat')
    orgId = org.orgId
    stubTelephonyEnv(orgId, { SMS_PROVIDER: 'mock' })
    admin = await makeUser(orgId, run, 'Ada Admin', 'SUPER_ADMIN', {
      permissions: ['users:manage', 'communications:read', 'communications:send', 'telephony:manage'],
    })
    rep = await makeUser(orgId, run, 'Gatsby Rep', 'CLOSER')
    other = await makeUser(orgId, run, 'Other Rep', 'CLOSER')
    vi.stubEnv('CHAT_USER_LINKS', JSON.stringify({ [admin.id]: 1, [rep.id]: 16 }))
    const a = await ingestCallCenterMetaLead({
      organizationId: orgId,
      pageId: SCS_ENGLISH_PAGE_ID,
      lead: { leadgenId: `${run}-1`, createdTime: OPEN.toISOString(), fields: { full_name: 'Paula Prospect', phone_number: phone } },
    })
    heldLead = a.leadId
    await db.callCenterLead.update({ where: { id: heldLead }, data: { lockedBy: rep.id, consentAt: OPEN, consentSource: 'manual' } })
    await db.callCenterEvent.create({
      data: {
        leadId: heldLead,
        type: 'SMS',
        direction: 'in',
        createdAt: OPEN,
        body: JSON.stringify({ label: 'Text received', detail: 'Is this about my solar?', status: 'received' }),
      },
    })
    const b = await ingestCallCenterMetaLead({
      organizationId: orgId,
      pageId: SCS_ENGLISH_PAGE_ID,
      lead: { leadgenId: `${run}-2`, createdTime: OPEN.toISOString(), fields: { full_name: 'Unlinked Holder', phone_number: testNumber(run, 2) } },
    })
    otherLead = b.leadId
    await db.callCenterLead.update({ where: { id: otherLead }, data: { lockedBy: other.id, consentAt: OPEN, consentSource: 'manual' } })
  })

  afterAll(async () => {
    if (orgId) await db.organization.delete({ where: { id: orgId } })
    vi.unstubAllEnvs()
  })

  it('feeds leads held by a linked rep, with linked Super Admins watching, last four only', async () => {
    const at = new Date(OPEN.getTime() + 60_000)
    const feed = await buildCaseFeed(null, at)
    const held = feed.cases.find((c) => c.lead_id === heldLead)
    expect(held).toMatchObject({ name: 'Paula Prospect', rep_uid: 'u16', rep_name: 'Gatsby R.', watchers: ['u1'], phone4: phone.slice(-4) })
    // A lead held by a rep with no SunOff link is not a case at all (§B4: the holder or owner must be linked).
    expect(feed.cases.find((c) => c.lead_id === otherLead)).toBeUndefined()
    const msgs = feed.msgs.filter((m) => m.lead_id === heldLead)
    expect(msgs.map((m) => [m.dir, m.body])).toEqual([['in', 'Is this about my solar?']])
    const blob = JSON.stringify(feed)
    expect(blob).not.toContain(phone.replace(/\D/g, '').slice(1))
    expect(blob).not.toContain('@example.test')
    // Equal-time rows come again (the chat dedupes by id); nothing older does.
    const again = await buildCaseFeed(feed.cursor, at)
    expect(again.msgs.filter((m) => m.lead_id === heldLead).map((m) => m.id)).toEqual(msgs.map((m) => m.id))
  })

  it('refuses unlinked, non-holder, no consent, do-not-call and mock texting', async () => {
    const req = (o: Record<string, string> = {}) =>
      parseCaseSms({ pf_lead_id: heldLead, uid: 'u16', pf_user_id: rep.id, body: 'Hi Paula', request_id: `req_${Math.random().toString(36).slice(2, 10)}`, ...o })!
    expect(parseCaseSms({ pf_lead_id: heldLead, uid: '16', pf_user_id: rep.id, body: 'x', request_id: 'abcdefg' })).toBeNull()
    expect(parseCaseSms({ pf_lead_id: heldLead, uid: 'u16', body: 'x', request_id: 'abcdefg' })).toBeNull()
    // The PF user the chat names must really link to the uid it claims.
    expect((await sendCaseSms(req({ uid: 'u999' }), OPEN)).body).toMatchObject({ ok: false, error: 'not_linked' })
    expect((await sendCaseSms(req({ uid: 'u1' }), OPEN)).body).toMatchObject({ ok: false, error: 'not_linked' })
    expect((await sendCaseSms(req({ pf_user_id: other.id }), OPEN)).body).toMatchObject({ ok: false, error: 'not_linked' })
    expect((await sendCaseSms(req({ pf_lead_id: otherLead }), OPEN)).body).toMatchObject({ ok: false, error: 'not_holder' })
    expect((await sendCaseSms(req(), OPEN)).body).toMatchObject({ ok: false, error: 'sms_off' })
    mockMode.on = false
    try {
      await db.callCenterLead.update({ where: { id: heldLead }, data: { consentRevokedAt: OPEN } })
      expect((await sendCaseSms(req(), OPEN)).body).toMatchObject({ ok: false, error: 'no_consent' })
      await db.callCenterLead.update({ where: { id: heldLead }, data: { consentRevokedAt: null, doNotCallAt: OPEN } })
      expect((await sendCaseSms(req(), OPEN)).body).toMatchObject({ ok: false, error: 'dnc' })
      await db.callCenterLead.update({ where: { id: heldLead }, data: { doNotCallAt: null } })
    } finally {
      mockMode.on = true
    }
    expect(await db.callCenterEvent.count({ where: { leadId: heldLead, type: 'SMS', direction: 'out' } })).toBe(0)
  })

  it('sends through the lead path once per request id (a Super Admin may text a held lead)', async () => {
    mockMode.on = false
    try {
      const request = parseCaseSms({ pf_lead_id: heldLead, uid: 'u1', pf_user_id: admin.id, body: 'Hi Paula, this is the office', request_id: `req_${run}_once` })!
      const first = await sendCaseSms(request, OPEN)
      const second = await sendCaseSms(request, OPEN)
      expect(first.status).toBe(200)
      expect(second.body).toMatchObject({ ok: true, duplicate: true })
      if (first.body.ok && second.body.ok) expect(second.body.id).toBe(first.body.id)
    } finally {
      mockMode.on = true
    }
    expect(await db.callCenterEvent.count({ where: { leadId: heldLead, type: 'SMS', direction: 'out' } })).toBe(1)
    const audit = await db.auditEvent.findFirst({ where: { organizationId: orgId, action: 'chat.case_sms_sent' } })
    expect(audit?.actorId).toBe(admin.id)
    expect(JSON.stringify(audit)).not.toContain(phone.replace(/\D/g, '').slice(1))
  })
})
