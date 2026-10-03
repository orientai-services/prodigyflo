import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { readSecret } from '@/lib/call-center/contact'
import {
  loadCallCenterLeadsFor,
  recordCallCenterNoteFor,
  recordCallCenterOutcomeFor,
  recordCallCenterTextFor,
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
    expect(lead?.nextAttemptAt).toBe('2026-10-04T17:00:00.000Z')
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
