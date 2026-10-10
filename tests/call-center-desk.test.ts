import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { readSecret } from '@/lib/call-center/contact'
import {
  loadCallCenterLeadsFor,
  recordCallCenterNoteFor,
  recordCallCenterOutcomeFor,
  recordCallCenterTextFor,
  recordCarrierCallFor,
  revealCallCenterContactFor,
  sendCallCenterIntakeFor,
  skipCallCenterLeadFor,
  takeCallCenterLeadFor,
} from '@/lib/call-center/desk'
import { ingestCallCenterMetaLead } from '@/lib/call-center/meta-ingest'
import { SCS_ENGLISH_PAGE_ID } from '@/lib/call-center/meta-route'
import { INTAKE_QUEUED, PREVIEW_BANNER } from '@/lib/call-center/model'

const PHONE = '+1 (702) 555-0199'
const DIAL = '+17025550199'
const EMAIL = 'desk-secret@example.test'
const run = `ccdesk-${Date.now().toString(36)}`
const when = new Date('2026-10-03T17:00:00.000Z')

function hidden(value: unknown) {
  const blob = JSON.stringify(value)
  expect(blob).not.toContain('7025550199')
  expect(blob).not.toContain('17025550199')
  expect(blob).not.toContain('555-0199')
  expect(blob).not.toContain(EMAIL)
  expect(blob).not.toContain('ciphertext')
}

describe('call center desk persistence', () => {
  let orgId = ''
  let leadId = ''
  const repA = { id: '', name: 'Rep A' }
  const repB = { id: '', name: 'Rep B' }

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: `Desk ${run}`, slug: run } })
    orgId = org.id
    const role = await db.role.create({ data: { organizationId: orgId, key: 'CLOSER', name: 'Closer' } })
    const a = await db.user.create({
      data: { organizationId: orgId, roleId: role.id, name: 'Rep A', email: `a-${run}@example.test`, passwordHash: 'x' },
    })
    const b = await db.user.create({
      data: { organizationId: orgId, roleId: role.id, name: 'Rep B', email: `b-${run}@example.test`, passwordHash: 'x' },
    })
    repA.id = a.id
    repB.id = b.id
    const saved = await ingestCallCenterMetaLead({
      organizationId: orgId,
      pageId: SCS_ENGLISH_PAGE_ID,
      lead: {
        leadgenId: `${run}-1`,
        createdTime: when.toISOString(),
        fields: { full_name: 'Pat Example', email: EMAIL, phone_number: PHONE, zip_code: '89117' },
      },
    })
    leadId = saved.leadId
  })

  afterAll(async () => {
    if (orgId) await db.organization.delete({ where: { id: orgId } })
  })

  it('blocks a second rep while the first holds the lock', async () => {
    const taken = await takeCallCenterLeadFor(orgId, repA, leadId, when)
    expect(taken.ok).toBe(true)
    const blocked = await takeCallCenterLeadFor(orgId, repB, leadId, when)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error).toBe('Another rep has this lead')
    const outcome = await recordCallCenterOutcomeFor(orgId, repB, leadId, 'no_answer', when)
    expect(outcome.ok).toBe(false)
    const row = await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId }, select: { tries: true, lockedBy: true } })
    expect(row.tries).toBe(0)
    expect(row.lockedBy).toBe(repA.id)
  })

  it('keeps the call result after a fresh read', async () => {
    const saved = await recordCallCenterOutcomeFor(orgId, repA, leadId, 'no_answer', when)
    expect(saved.ok).toBe(true)
    hidden(saved)
    const reloaded = await loadCallCenterLeadsFor(orgId, repB.id)
    const lead = reloaded.find((row) => row.id === leadId)
    expect(lead?.tries).toBe(1)
    // Cadence step 1: five minutes after the 10:00 (Los Angeles) attempt.
    expect(lead?.nextAttemptAt).toBe('2026-10-03T17:05:00.000Z')
    expect(lead?.followUp).toBe('cadence')
    expect(lead?.status).toBe('retry')
    expect(lead?.lockedBy).toBe(repA.id)
    expect(lead?.lockName).toBe('Rep A')
    expect(lead?.trail.some((event) => event.kind === 'outcome')).toBe(true)
    expect(lead?.trail.some((event) => event.kind === 'sms')).toBe(true)
    hidden(reloaded)
    expect(await db.client.count({ where: { organizationId: orgId } })).toBe(0)
  })

  it('shows the full phone only to the rep holding the lock', async () => {
    const list = await loadCallCenterLeadsFor(orgId, repA.id)
    hidden(list)
    expect(list.find((row) => row.id === leadId)?.last4).toBe('0199')
    const other = await revealCallCenterContactFor(orgId, repB.id, leadId)
    expect(other).toEqual({ phone: null, email: null })
    const holder = await revealCallCenterContactFor(orgId, repA.id, leadId)
    expect(holder.phone).toBe(DIAL)
    expect(holder.email).toBe(EMAIL)
    const stored = await db.callCenterLead.findUniqueOrThrow({
      where: { id: leadId },
      select: { phoneSecret: true, emailSecret: true, phoneLast4: true },
    })
    const secretBlob = JSON.stringify({ phone: stored.phoneSecret, email: stored.emailSecret })
    expect(secretBlob).not.toContain('7025550199')
    expect(secretBlob).not.toContain('555-0199')
    expect(secretBlob).not.toContain(EMAIL)
    expect(readSecret(stored.phoneSecret)).toBe(DIAL)
    expect(readSecret(stored.emailSecret)).toBe(EMAIL)
    expect(stored.phoneLast4).toBe('0199')
  })

  it('keeps a note, a text trail, and the intake link after a fresh read', async () => {
    const note = await recordCallCenterNoteFor(orgId, repA, leadId, 'Left a note on the attempt', when)
    expect(note.ok).toBe(true)
    const text = await recordCallCenterTextFor(orgId, repA, leadId, when)
    expect(text.ok).toBe(true)
    const intake = await sendCallCenterIntakeFor(orgId, repA, leadId, when)
    expect(intake.ok).toBe(true)
    hidden(note)
    hidden(text)
    hidden(intake)
    const lead = (await loadCallCenterLeadsFor(orgId, repB.id)).find((row) => row.id === leadId)
    expect(lead?.trail.some((event) => event.kind === 'note' && event.detail === 'Left a note on the attempt')).toBe(true)
    expect(lead?.trail.some((event) => event.kind === 'sms' && event.detail === PREVIEW_BANNER)).toBe(true)
    expect(lead?.trail.some((event) => event.kind === 'intake' && event.detail === INTAKE_QUEUED)).toBe(true)
    const row = await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId }, select: { intakeLinkSentAt: true, clientId: true } })
    expect(row.intakeLinkSentAt).toBeTruthy()
    expect(row.clientId).toBeNull()
  })

  it('refuses Take after Do not call', async () => {
    const marked = await recordCallCenterOutcomeFor(orgId, repA, leadId, 'do_not_call', when)
    expect(marked.ok).toBe(true)
    const released = await skipCallCenterLeadFor(orgId, repA, leadId, when)
    expect(released.ok).toBe(true)
    if (released.ok) expect(released.lead.lockedBy).toBeNull()
    const takeA = await takeCallCenterLeadFor(orgId, repA, leadId, when)
    const takeB = await takeCallCenterLeadFor(orgId, repB, leadId, when)
    expect(takeA.ok).toBe(false)
    expect(takeB.ok).toBe(false)
    if (!takeA.ok) expect(takeA.error).toBe('Do not call')
    if (!takeB.ok) expect(takeB.error).toBe('Do not call')
    expect(await revealCallCenterContactFor(orgId, repA.id, leadId)).toEqual({ phone: null, email: null })
    const lead = (await loadCallCenterLeadsFor(orgId, repA.id)).find((row) => row.id === leadId)
    expect(lead?.dnc).toBe(true)
    expect(lead?.status).toBe('dnc')
    hidden(lead)
  })
})

describe('call center callbacks and the carrier cadence', () => {
  const run2 = `${run}-cad`
  let orgId = ''
  const rep = { id: '', name: 'Rep C' }

  async function newLead(): Promise<string> {
    const lead = await db.callCenterLead.create({
      data: { organizationId: orgId, source: 'FORM', language: 'EN', status: 'WAITING', lockedBy: rep.id },
    })
    return lead.id
  }

  async function carrierCall(leadId: string, data: { outcome: 'NO_ANSWER' | 'CONNECTED'; talkSeconds?: number; startedAt: Date; endedAt: Date }) {
    return db.voiceCall.create({
      data: {
        organizationId: orgId,
        callSid: `CA${run2}${Math.random().toString(36).slice(2, 10)}`,
        accountSid: 'AC_test_cadence',
        direction: 'OUTBOUND',
        status: 'completed',
        callCenterLeadId: leadId,
        ...data,
      },
    })
  }

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: `Desk ${run2}`, slug: run2 } })
    orgId = org.id
    const role = await db.role.create({ data: { organizationId: orgId, key: 'CLOSER', name: 'Closer' } })
    const user = await db.user.create({
      data: { organizationId: orgId, roleId: role.id, name: 'Rep C', email: `c-${run2}@example.test`, passwordHash: 'x' },
    })
    rep.id = user.id
  })

  afterAll(async () => {
    if (orgId) await db.organization.delete({ where: { id: orgId } })
  })

  it('stores an agreed callback time and refuses a past or far-off one', async () => {
    const leadId = await newLead()
    const past = await recordCallCenterOutcomeFor(orgId, rep, leadId, 'callback', when, { callbackAt: '2026-10-03T16:00:00.000Z' })
    expect(past).toEqual({ ok: false, error: 'The call back time has already passed.' })
    const far = await recordCallCenterOutcomeFor(orgId, rep, leadId, 'callback', when, { callbackAt: '2026-12-31T17:00:00.000Z' })
    expect(far.ok).toBe(false)
    const wrong = await recordCallCenterOutcomeFor(orgId, rep, leadId, 'talked', when, { callbackAt: '2026-10-04T17:00:00.000Z' })
    expect(wrong.ok).toBe(false)
    const saved = await recordCallCenterOutcomeFor(orgId, rep, leadId, 'callback', when, { callbackAt: '2026-10-04T21:30:00.000Z' })
    expect(saved.ok).toBe(true)
    const lead = (await loadCallCenterLeadsFor(orgId, rep.id)).find((row) => row.id === leadId)
    expect(lead?.nextAttemptAt).toBe('2026-10-04T21:30:00.000Z')
    expect(lead?.followUp).toBe('callback')
    expect(lead?.tries).toBe(0)
  })

  it('advances the cadence once per carrier call, and not again for the rep result', async () => {
    const leadId = await newLead()
    const vc = await carrierCall(leadId, { outcome: 'NO_ANSWER', startedAt: new Date('2026-10-03T16:59:00.000Z'), endedAt: when })
    await Promise.all([recordCarrierCallFor(orgId, leadId, vc, when), recordCarrierCallFor(orgId, leadId, vc, when)])
    await recordCarrierCallFor(orgId, leadId, vc, when)
    let row = await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId } })
    expect(row.tries).toBe(1)
    expect(row.nextAttemptAt?.toISOString()).toBe('2026-10-03T17:05:00.000Z')
    expect(await db.callCenterEvent.count({ where: { leadId, type: 'CALL' } })).toBe(1)
    // The wrap-up result for the same call records the label but not a second try.
    const result = await recordCallCenterOutcomeFor(orgId, rep, leadId, 'no_answer', new Date('2026-10-03T17:01:00.000Z'))
    expect(result.ok).toBe(true)
    row = await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId } })
    expect(row.tries).toBe(1)
  })

  it('does not count a call the rep already counted, and clears a cadence follow-up when reached', async () => {
    const leadId = await newLead()
    const first = await recordCallCenterOutcomeFor(orgId, rep, leadId, 'no_answer', new Date('2026-10-03T17:00:30.000Z'))
    expect(first.ok).toBe(true)
    const vc = await carrierCall(leadId, { outcome: 'NO_ANSWER', startedAt: new Date('2026-10-03T16:59:00.000Z'), endedAt: when })
    await recordCarrierCallFor(orgId, leadId, vc, when)
    let row = await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId } })
    expect(row.tries).toBe(1)

    const reached = await carrierCall(leadId, {
      outcome: 'CONNECTED',
      talkSeconds: 45,
      startedAt: new Date('2026-10-03T17:10:00.000Z'),
      endedAt: new Date('2026-10-03T17:11:00.000Z'),
    })
    await recordCarrierCallFor(orgId, leadId, reached, new Date('2026-10-03T17:11:00.000Z'))
    row = await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId } })
    expect(row.tries).toBe(1)
    expect(row.nextAttemptAt).toBeNull()
    expect(row.status).toBe('WAITING')
    const lead = (await loadCallCenterLeadsFor(orgId, rep.id)).find((r) => r.id === leadId)
    expect(lead?.contacted).toBe(true)
    expect(lead?.trail.some((event) => event.kind === 'call' && event.connected)).toBe(true)
  })
})
