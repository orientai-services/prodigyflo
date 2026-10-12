import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { ingestCallCenterMetaLead } from '../meta-ingest'
import { SCS_ENGLISH_PAGE_ID } from '../meta-route'
import {
  confirmSlot,
  holdSlot,
  listFollowUps,
  listSlotsBetween,
  listToSchedule,
  recordSlotOutcome,
  rescheduleSlot,
  schedulerInputs,
} from './service'
import { zonedToUtc } from './time'

// Wednesday 2026-10-14 08:00 PT (UTC-7). Every hold is checked against this clock.
const NOW = new Date('2026-10-14T15:00:00Z')
const at = (d: number, hh: number, mm = 0) => zonedToUtc(2026, 10, d, hh * 60 + mm)
const run = `cccal-${Date.now().toString(36)}`
const WEEK = { from: at(12, 0), to: at(19, 0) }

describe('call center calendar planner service', () => {
  let orgId = ''
  let userId = ''
  const lead: Record<'nate' | 'mara' | 'owen' | 'dnc', string> = { nate: '', mara: '', owen: '', dnc: '' }

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: `Calendar ${run}`, slug: run } })
    orgId = org.id
    const role = await db.role.create({ data: { organizationId: orgId, key: 'CLOSER', name: 'Closer' } })
    const user = await db.user.create({
      data: { organizationId: orgId, roleId: role.id, name: 'Rep A', email: `a-${run}@example.test`, passwordHash: 'x' },
    })
    userId = user.id
    const people: [keyof typeof lead, string, string][] = [
      ['nate', 'Nate Fuller', '+1 702 555 0101'],
      ['mara', 'Mara Ellison', '+1 702 555 0102'],
      ['owen', 'Owen Briggs', '+1 702 555 0103'],
      ['dnc', 'Dee Nocall', '+1 702 555 0104'],
    ]
    for (const [i, [key, name, phone]] of people.entries()) {
      const saved = await ingestCallCenterMetaLead({
        organizationId: orgId,
        pageId: SCS_ENGLISH_PAGE_ID,
        lead: { leadgenId: `${run}-${key}`, createdTime: NOW.toISOString(), fields: { full_name: name, phone_number: phone, zip_code: '89117' } },
      })
      lead[key] = saved.leadId
      // Distinct arrival times so "newest first" is deterministic.
      await db.callCenterLead.update({ where: { id: saved.leadId }, data: { createdAt: new Date(NOW.getTime() - (10 - i) * 60_000) } })
    }
    await db.callCenterLead.update({ where: { id: lead.dnc }, data: { doNotCallAt: NOW } })
    await db.callCenterEvent.create({
      data: { leadId: lead.nate, type: 'NOTE', body: JSON.stringify({ label: 'Note', detail: 'Wants the visit after school pickup' }) },
    })
  })

  afterAll(async () => {
    if (orgId) await db.organization.delete({ where: { id: orgId } })
  })

  it('lists visits with the desk name, last four and the last real note', async () => {
    const held = await holdSlot({ organizationId: orgId, leadId: lead.nate, repKey: 'gatsby', startsAt: at(15, 9), now: NOW })
    expect(held.ok).toBe(true)
    const other = await holdSlot({ organizationId: orgId, leadId: lead.mara, repKey: 'hector', startsAt: at(15, 10), now: NOW })
    expect(other.ok).toBe(true)

    const visits = await listSlotsBetween(orgId, WEEK.from, WEEK.to, { now: NOW })
    expect(visits.map((v) => v.name)).toEqual(['Nate Fuller', 'Mara Ellison'])
    expect(visits[0]).toMatchObject({ repKey: 'gatsby', status: 'HOLD', last4: '0101', language: 'EN' })
    // The calendar's own "hold placed" line is not the lead's note.
    expect(visits[0].note).toBe('Wants the visit after school pickup')
    expect(visits[1].note).toBeNull()
    expect(JSON.stringify(visits)).not.toContain('5550101')

    const gatsby = await listSlotsBetween(orgId, WEEK.from, WEEK.to, { repKey: 'gatsby', now: NOW })
    expect(gatsby.map((v) => v.name)).toEqual(['Nate Fuller'])
    expect(await listSlotsBetween(orgId, at(19, 0), at(26, 0), { now: NOW })).toEqual([])
  })

  it('to schedule: open leads with no active visit, newest first, no do-not-call', async () => {
    const rows = await listToSchedule(orgId)
    expect(rows.map((r) => r.name)).toEqual(['Owen Briggs'])
    expect(rows[0]).toMatchObject({ last4: '0103', language: 'EN' })
  })

  it('follow-ups: next try within 24 hours', async () => {
    await db.callCenterLead.update({ where: { id: lead.owen }, data: { nextAttemptAt: new Date(NOW.getTime() + 5 * 3_600_000) } })
    await db.callCenterLead.update({ where: { id: lead.mara }, data: { nextAttemptAt: new Date(NOW.getTime() + 30 * 3_600_000) } })
    const rows = await listFollowUps(orgId, NOW)
    expect(rows.map((r) => r.name)).toEqual(['Owen Briggs'])
    expect(rows[0].at.getTime()).toBe(NOW.getTime() + 5 * 3_600_000)
  })

  it('reschedule: old slot RESCHEDULED and linked, new HOLD passes the rules, one transaction', async () => {
    const [nate] = await listSlotsBetween(orgId, WEEK.from, WEEK.to, { repKey: 'gatsby', now: NOW })
    expect((await confirmSlot({ organizationId: orgId, slotId: nate.id, userId })).ok).toBe(true)

    // Moving the same rep by 30 minutes is fine: the old visit no longer counts as busy.
    const moved = await rescheduleSlot({ organizationId: orgId, slotId: nate.id, repKey: 'gatsby', startsAt: at(15, 9, 30), userId, now: NOW })
    expect(moved.ok).toBe(true)
    const old = await db.callCenterSlot.findUniqueOrThrow({ where: { id: nate.id } })
    expect(old.status).toBe('RESCHEDULED')
    expect(moved.ok && old.rescheduledToId).toBe(moved.ok ? moved.slotId : null)
    const fresh = await db.callCenterSlot.findUniqueOrThrow({ where: { id: old.rescheduledToId! } })
    expect(fresh).toMatchObject({ status: 'HOLD', repKey: 'gatsby', leadId: lead.nate })
    expect(fresh.startsAt.toISOString()).toBe(at(15, 9, 30).toISOString())
    // A hold is not a booking: the lead waits for the rep's confirm again.
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: lead.nate } })).status).toBe('WAITING')

    // Struck visits stay on the grid for a day after the change.
    const visible = await listSlotsBetween(orgId, WEEK.from, WEEK.to, { repKey: 'gatsby', now: NOW })
    expect(visible.map((v) => v.status)).toEqual(['RESCHEDULED', 'HOLD'])
    const later = await listSlotsBetween(orgId, WEEK.from, WEEK.to, { repKey: 'gatsby', now: new Date(NOW.getTime() + 25 * 3_600_000) })
    expect(later.map((v) => v.status)).toEqual(['HOLD'])
  })

  it('reschedule refuses a broken rule and leaves everything as it was', async () => {
    const [mara] = await listSlotsBetween(orgId, WEEK.from, WEEK.to, { repKey: 'hector', now: NOW })
    // Gatsby holds 9:30 on the 15th; 10:30 is inside his 90-minute gap.
    const clash = await rescheduleSlot({ organizationId: orgId, slotId: mara.id, repKey: 'gatsby', startsAt: at(15, 10, 30), userId, now: NOW })
    expect(clash).toEqual({ ok: false, reason: 'rep already has a visit then' })
    const tooFar = await rescheduleSlot({ organizationId: orgId, slotId: mara.id, repKey: 'hector', startsAt: at(20, 9), userId, now: NOW })
    expect(tooFar).toEqual({ ok: false, reason: 'more than 5 days ahead' })
    const row = await db.callCenterSlot.findUniqueOrThrow({ where: { id: mara.id } })
    expect(row.status).toBe('HOLD')
    expect(row.rescheduledToId).toBeNull()
    expect(await db.callCenterSlot.count({ where: { leadId: lead.mara } })).toBe(1)

    // Closed visits can't move.
    expect((await recordSlotOutcome({ organizationId: orgId, slotId: mara.id, outcome: 'cancelled', now: NOW })).ok).toBe(true)
    const closed = await rescheduleSlot({ organizationId: orgId, slotId: mara.id, repKey: 'hector', startsAt: at(16, 9), userId, now: NOW })
    expect(closed).toEqual({ ok: false, reason: 'visit already closed' })
  })

  it('scheduler inputs: active visits only, rep hours as plain windows', async () => {
    await db.callCenterRepHours.create({ data: { organizationId: orgId, repKey: 'dakota', weekday: 4, active: false } })
    const { busy, hours } = await schedulerInputs(orgId, NOW)
    expect(busy.map((b) => b.repKey).sort()).toEqual(['gatsby'])
    expect(hours).toEqual({ dakota: { 4: { startMinute: 540, endMinute: 1050, active: false } } })
  })
})
