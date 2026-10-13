import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { processInboundMessage } from '@/lib/messaging/inbound'
import { resetTelephonyProvider } from '@/lib/telephony'
import { makeLine, makeOrg, makeUser, sid, stubTelephonyEnv, testNumber } from '../../../tests/fixtures/telephony'
import { ingestCallCenterMetaLead } from './meta-ingest'
import { SCS_ENGLISH_PAGE_ID } from './meta-route'
import {
  applyLeadSmsStatus,
  countUnreadMessages,
  listThreads,
  loadThread,
  markThreadRead,
  recordInboundLeadText,
  sendLeadText,
  sendThreadText,
} from './messages'
import { A2P_PENDING } from './messages-core'
import { formatLeadPhone } from './phone-display'

/**
 * The dialer's Messages section against the test DB (docs/DIALER_APP.md §4):
 * inbound lead texts land on the lead's thread once per carrier id, unread
 * counts and marking read, the lead send path running the one outbound
 * decision, carrier failures kept honestly, and a full number only for a
 * viewer allowed to see it (Super Admin, or the rep holding the lead).
 */

const run = `ccmsg-${Date.now().toString(36)}`
// Tuesday Oct 13, 10:00 in Las Vegas: inside the calling window.
const OPEN = new Date('2026-10-13T17:00:00.000Z')
// Same day, 22:30 in Las Vegas: outside it.
const LATE = new Date('2026-10-14T05:30:00.000Z')

describe('call center messages', () => {
  let orgId = ''
  let leadId = ''
  let noConsentLeadId = ''
  let clientId = ''
  const lead = testNumber(run, 1)
  const stranger = testNumber(run, 2)
  const clientPhone = testNumber(run, 3)
  const line = testNumber(run, 9)
  let admin: Awaited<ReturnType<typeof makeUser>>
  let repA: Awaited<ReturnType<typeof makeUser>>
  let repB: Awaited<ReturnType<typeof makeUser>>

  function hidden(value: unknown, phone = lead) {
    const blob = JSON.stringify(value)
    const digits = phone.replace(/\D/g, '')
    expect(blob).not.toContain(digits)
    expect(blob).not.toContain(digits.slice(1))
    expect(blob).not.toContain(digits.slice(-7))
  }

  beforeAll(async () => {
    const org = await makeOrg(run, 'Msgs')
    orgId = org.orgId
    stubTelephonyEnv(orgId, { SMS_PROVIDER: 'mock' })
    resetTelephonyProvider()
    await makeLine(orgId, line)
    admin = await makeUser(orgId, run, 'Admin Msgs', 'SUPER_ADMIN', {
      permissions: ['users:manage', 'communications:read', 'communications:send', 'telephony:manage'],
    })
    repA = await makeUser(orgId, run, 'Gatsby Rep', 'CLOSER')
    repB = await makeUser(orgId, run, 'Other Rep', 'CLOSER')

    const saved = await ingestCallCenterMetaLead({
      organizationId: orgId,
      pageId: SCS_ENGLISH_PAGE_ID,
      lead: { leadgenId: `${run}-1`, createdTime: OPEN.toISOString(), fields: { full_name: 'Pat Example', phone_number: lead } },
    })
    leadId = saved.leadId
    await db.callCenterLead.update({ where: { id: leadId }, data: { consentAt: OPEN, consentSource: 'manual' } })
    const bare = await ingestCallCenterMetaLead({
      organizationId: orgId,
      pageId: SCS_ENGLISH_PAGE_ID,
      lead: { leadgenId: `${run}-2`, createdTime: OPEN.toISOString(), fields: { full_name: 'Nate Noconsent', phone_number: testNumber(run, 4) } },
    })
    noConsentLeadId = bare.leadId

    const client = await db.client.create({
      data: {
        organizationId: orgId,
        pipelineId: org.pipelineId,
        currentStageId: org.intakeStageId,
        firstName: 'Mara',
        lastName: 'Client',
        email: `mara.${run}@example.test`,
        phone: clientPhone,
        ownerId: admin.id,
      },
    })
    clientId = client.id
  })

  afterAll(async () => {
    if (orgId) await db.organization.delete({ where: { id: orgId } })
    vi.unstubAllEnvs()
  })

  it('files an inbound text from a lead number on that lead, once per carrier id', async () => {
    const msgSid = sid('SM', run, 1)
    const payload = { from: lead, to: line, body: 'Is this about my solar?', external_id: msgSid }
    const first = await processInboundMessage('SMS', payload)
    expect(first.matched).toBe(false)
    await processInboundMessage('SMS', payload)
    const rows = await db.callCenterEvent.findMany({ where: { leadId, type: 'SMS' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].direction).toBe('in')
    expect(rows[0].readAt).toBeNull()
    expect(rows[0].externalRef).toBe(msgSid)
    hidden(rows[0].body)
    // The unmatched-text notice the function always sent still goes out.
    expect(await db.notification.count({ where: { organizationId: orgId, title: 'Unmatched inbound SMS' } })).toBe(2)
  })

  it('ignores a stranger and an org it cannot pin, and never throws', async () => {
    expect(await recordInboundLeadText(orgId, { from: stranger, body: 'hi', external_id: sid('SM', run, 2) })).toBeNull()
    expect(await recordInboundLeadText(null, { from: lead, body: 'hi', external_id: sid('SM', run, 3) })).toBeNull()
    expect(await db.callCenterEvent.count({ where: { leadId, type: 'SMS' } })).toBe(1)
  })

  it('keeps a client text in Communication, not on a lead', async () => {
    const res = await processInboundMessage('SMS', { from: clientPhone, to: line, body: 'Got the papers', external_id: sid('SM', run, 4) })
    expect(res.matched).toBe(true)
    expect(await db.callCenterEvent.count({ where: { lead: { organizationId: orgId }, type: 'SMS', direction: 'in' } })).toBe(1)
  })

  it('lists one thread per lead and client, newest first, unread counted; full lead number only for a Super Admin', async () => {
    const threads = await listThreads(admin.actor, OPEN)
    expect(threads.map((t) => t.key)).toEqual([`client:${clientId}`, `lead:${leadId}`])
    const t = threads.find((x) => x.kind === 'lead')!
    expect(t.name).toBe('Pat Example')
    expect(t.last4).toBe(lead.slice(-4))
    expect(t.snippet).toBe('Is this about my solar?')
    expect(t.unread).toBe(1)
    expect(t.lastDirection).toBe('in')
    // A Super Admin sees the lead's full number (docs/DIALER_APP.md §Phone numbers); a client's never rides along.
    expect(t.phone).toEqual({ state: 'shown', ...formatLeadPhone(lead) })
    hidden(threads.filter((x) => x.kind === 'client'))
    hidden(threads, clientPhone)
    expect(await countUnreadMessages(admin.actor)).toBe(2)
    // A Closer sees the lead thread (the desk is org-wide) but not another owner's client.
    const closer = await listThreads(repA.actor, OPEN)
    expect(closer.map((x) => x.key)).toEqual([`lead:${leadId}`])
    // …and, not holding the lead, only its last four.
    expect(closer[0].phone).toBeNull()
    hidden(closer)
    expect(await countUnreadMessages(repA.actor)).toBe(1)
  })

  it('opening a thread marks its inbound texts read', async () => {
    const thread = await loadThread(admin.actor, { kind: 'lead', id: leadId })
    expect(thread?.messages.map((m) => [m.direction, m.text, m.status])).toEqual([['in', 'Is this about my solar?', 'received']])
    expect(thread?.canSend).toBe(true)
    expect(thread?.phone).toEqual({ state: 'shown', ...formatLeadPhone(lead) })
    hidden(await loadThread(repB.actor, { kind: 'lead', id: leadId }))
    expect(await markThreadRead(admin.actor, { kind: 'lead', id: leadId })).toBe(1)
    expect(await markThreadRead(admin.actor, { kind: 'lead', id: leadId })).toBe(0)
    expect(await markThreadRead(admin.actor, { kind: 'client', id: clientId })).toBe(1)
    expect(await countUnreadMessages(admin.actor)).toBe(0)
  })

  it('sends a text to a lead through the outbound decision and keeps it on the thread', async () => {
    const res = await sendLeadText(repA.actor, leadId, 'Hi Pat, this is Gatsby. Good time to talk?', OPEN)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.message).toMatchObject({ direction: 'out', status: 'sent', by: 'Gatsby', note: null })
    const row = await db.callCenterEvent.findUniqueOrThrow({ where: { id: res.message.id } })
    expect(row.direction).toBe('out')
    expect(row.externalRef).toMatch(/^mock-sms-/)
    hidden(row)
    const threads = await listThreads(repA.actor, OPEN)
    expect(threads[0]).toMatchObject({ key: `lead:${leadId}`, lastDirection: 'out', unread: 0 })
  })

  it('a block sends nothing and writes nothing', async () => {
    const before = await db.callCenterEvent.count({ where: { type: 'SMS', lead: { organizationId: orgId } } })
    const late = await sendLeadText(repA.actor, leadId, 'Late one', LATE)
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.error).toMatch(/Texts can go out after/)
    const noConsent = await sendThreadText(repA.actor, { kind: 'lead', id: noConsentLeadId }, 'Hello', OPEN)
    expect(noConsent).toEqual({ ok: false, error: 'No consent on file for this number.' })
    expect(await db.callCenterEvent.count({ where: { type: 'SMS', lead: { organizationId: orgId } } })).toBe(before)
  })

  it('only the rep holding a lead (or a manager) may text it', async () => {
    await db.callCenterLead.update({ where: { id: leadId }, data: { lockedBy: repB.id } })
    const refused = await sendLeadText(repA.actor, leadId, 'Mine?', OPEN)
    expect(refused).toEqual({ ok: false, error: 'Another rep has this lead.' })
    expect((await loadThread(repA.actor, { kind: 'lead', id: leadId }))?.canSend).toBe(false)
    expect((await sendLeadText(admin.actor, leadId, 'Manager here', OPEN)).ok).toBe(true)
    await db.callCenterLead.update({ where: { id: leadId }, data: { lockedBy: null } })
  })

  it('shows "waiting on carrier approval" when the carrier reports 30034, and stays final', async () => {
    const res = await sendLeadText(repA.actor, leadId, 'Second try', OPEN)
    if (!res.ok) throw new Error(res.error)
    const row = await db.callCenterEvent.findUniqueOrThrow({ where: { id: res.message.id }, select: { externalRef: true } })
    expect(await applyLeadSmsStatus(orgId, row.externalRef!, { status: 'undelivered', errorCode: '30034' })).toBe('failed')
    expect(await applyLeadSmsStatus(orgId, row.externalRef!, { status: 'delivered', errorCode: null })).toBe('ignored')
    const thread = await loadThread(repA.actor, { kind: 'lead', id: leadId })
    const last = thread!.messages.find((m) => m.id === res.message.id)!
    expect(last.status).toBe('failed')
    expect(last.note).toBe(A2P_PENDING)
    // Another org's callback can't touch it.
    expect(await applyLeadSmsStatus('other-org', row.externalRef!, { status: 'delivered', errorCode: null })).toBe('ignored')
  })

  it('refuses a lead from another org and an unknown client', async () => {
    const other = await makeOrg(`${run}-x`, 'Other')
    try {
      const outsider = await makeUser(other.orgId, run, 'Outsider', 'SUPER_ADMIN', {
        permissions: ['communications:read', 'communications:send'],
      })
      expect(await loadThread(outsider.actor, { kind: 'lead', id: leadId })).toBeNull()
      expect(await sendLeadText(outsider.actor, leadId, 'hi', OPEN)).toEqual({ ok: false, error: "That lead isn't in your list." })
      expect(await markThreadRead(outsider.actor, { kind: 'lead', id: leadId })).toBe(0)
      expect(await loadThread(outsider.actor, { kind: 'client', id: clientId })).toBeNull()
      expect(await listThreads(outsider.actor, OPEN)).toEqual([])
    } finally {
      await db.organization.delete({ where: { id: other.orgId } })
    }
  })
})
