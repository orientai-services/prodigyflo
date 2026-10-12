import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { ingestCallCenterMetaLead } from '../meta-ingest'
import { SCS_ENGLISH_PAGE_ID } from '../meta-route'
import { holdSlot, runCalendarReminders } from './service'
import { zonedToUtc } from './time'

// Wednesday 2026-10-14 08:00 PT. The visit is Thursday 11:00 PT; the reminder run is 2 h before it.
const NOW = new Date('2026-10-14T15:00:00Z')
const VISIT = zonedToUtc(2026, 10, 15, 11 * 60)
const run = `ccrem-${Date.now().toString(36)}`

describe('calendar client text reminders go through the outbound gate', () => {
  let orgId = ''
  let leadId = ''
  const saved = process.env.CALL_CENTER_A2P_APPROVED

  beforeAll(async () => {
    process.env.CALL_CENTER_A2P_APPROVED = '1'
    const org = await db.organization.create({ data: { name: `Reminders ${run}`, slug: run } })
    orgId = org.id
    const lead = await ingestCallCenterMetaLead({
      organizationId: orgId,
      pageId: SCS_ENGLISH_PAGE_ID,
      lead: { leadgenId: `${run}-a`, createdTime: NOW.toISOString(), fields: { full_name: 'Rita Gate', phone_number: '+1 702 555 0181', zip_code: '89117' } },
    })
    leadId = lead.leadId
    const held = await holdSlot({ organizationId: orgId, leadId, repKey: 'gatsby', startsAt: VISIT, now: NOW })
    expect(held.ok).toBe(true)
    // Marked do-not-call after the visit was booked: the reminder text must not go out.
    await db.callCenterLead.update({ where: { id: leadId }, data: { doNotCallAt: NOW } })
  })

  afterAll(async () => {
    if (saved === undefined) delete process.env.CALL_CENTER_A2P_APPROVED
    else process.env.CALL_CENTER_A2P_APPROVED = saved
    if (orgId) await db.organization.delete({ where: { id: orgId } })
  })

  it('blocks the text and records why, instead of sending', async () => {
    await runCalendarReminders(new Date(VISIT.getTime() - 2 * 3_600_000))
    const slot = await db.callCenterSlot.findFirstOrThrow({ where: { leadId } })
    expect(slot.reminder3ClientAt).toBeNull()
    expect(slot.reminderError).toMatch(/^reminder3ClientAt: blocked /)
  })
})
