/**
 * How the automation engine treats the two calling-rules refusals that are not
 * failures (telephony live review):
 *
 *  - CHECK_FAILED: the check itself could not run (a database blip, or a
 *    deploy before PHONE_HASH_KEY is set). It is retried with backoff, never
 *    turned into a permanent FAILED or a stopped sequence.
 *  - SUPPRESSED + held: texts are on hold while an admin reviews a possible
 *    opt-out. The text waits; once the hold is lifted it goes out.
 *  - UNKNOWN_TIMEZONE: nobody knows where the client is yet. The text is
 *    parked (the sender is told once) until a rep sets the zone.
 *
 * sendMessage is replaced so each run's refusal is chosen here; everything
 * else (rows, actor loading, scheduling) is the real engine against the DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendOutcome } from '@/lib/messaging/send'

const queue = vi.hoisted(() => ({ outcomes: [] as SendOutcome[] }))
vi.mock('@/lib/messaging/send', async (orig) => ({
  ...(await orig<typeof import('@/lib/messaging/send')>()),
  sendMessage: async () => queue.outcomes.shift() ?? { ok: false, code: 'UNEXPECTED', error: 'No outcome queued.' },
}))

import { db } from '@/lib/db'
import { MAX_ATTEMPTS, REVIEW_HOLD_RECHECK_MS, ZONE_RECHECK_MS, ZONE_WAIT_NOTE, retryBackoffMs, runDueWork } from '@/lib/automation/engine'
import { makeOrg, makeUser } from './fixtures/telephony'

const run = `aretry-${Date.now().toString(36)}`
let orgId = ''
let senderId = ''
let clientId = ''
let sequenceId = ''

const CHECK_FAILED: SendOutcome = {
  ok: false,
  code: 'CHECK_FAILED',
  error: "We couldn't check the calling rules just now, so nothing was sent. Try again in a moment.",
}
const HELD: SendOutcome = {
  ok: false,
  code: 'SUPPRESSED',
  error: 'Texts to this number are on hold until an admin reviews a possible opt-out.',
  held: true,
}
const SENT: SendOutcome = { ok: true, communicationId: 'comm-test', status: 'SENT', mock: true }
const NO_ZONE: SendOutcome = {
  ok: false,
  code: 'UNKNOWN_TIMEZONE',
  error: "We don't know their time zone. Press Call and pick where they are, then try again.",
}

function zoneNotices() {
  return db.notification.count({ where: { userId: senderId, title: 'Text waiting for a time zone' } })
}

async function scheduled(now: Date) {
  return db.scheduledMessage.create({
    data: { organizationId: orgId, clientId, userId: senderId, channel: 'SMS', body: 'Hi', sendAt: new Date(now.getTime() - 1000) },
  })
}

async function enrollment(now: Date) {
  await db.sequenceEnrollment.deleteMany({ where: { sequenceId } })
  return db.sequenceEnrollment.create({
    data: { sequenceId, clientId, enrolledById: senderId, nextRunAt: new Date(now.getTime() - 1000) },
  })
}

beforeAll(async () => {
  const org = await makeOrg(run)
  orgId = org.orgId
  senderId = (await makeUser(orgId, run, 'Sender', 'SUPER_ADMIN')).id
  clientId = (
    await db.client.create({
      data: { organizationId: orgId, pipelineId: org.pipelineId, currentStageId: org.intakeStageId, firstName: 'Retry', lastName: 'Client', email: `retry.${run}@example.test`, phone: '+17255550190', ownerId: senderId },
    })
  ).id
  await db.messageTemplate.create({ data: { organizationId: orgId, key: 'follow_up', name: 'Follow up', channel: 'SMS', body: 'Checking in' } })
  sequenceId = (
    await db.sequence.create({
      data: {
        organizationId: orgId,
        name: 'Follow-ups',
        steps: { create: [{ position: 0, delayHours: 24, channel: 'SMS', templateKey: 'follow_up', stopIfReplied: false }] },
      },
    })
  ).id
})

beforeEach(() => {
  queue.outcomes = []
})

afterAll(async () => {
  await db.organization.delete({ where: { id: orgId } })
})

describe('CHECK_FAILED is retried, not a permanent failure (regression-automation-check-failed-permanent)', () => {
  it('a scheduled text that hits a check error stays PENDING with backoff, then goes out on the next run', async () => {
    const now = new Date()
    const sm = await scheduled(now)
    queue.outcomes.push(CHECK_FAILED)
    const first = await runDueWork(now, { organizationId: orgId })
    expect(first.scheduled).toMatchObject({ retried: 1, failed: 0 })
    const waiting = await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })
    expect(waiting).toMatchObject({ status: 'PENDING', attempts: 1 })
    expect(waiting.sendAt.getTime()).toBe(now.getTime() + retryBackoffMs(1))

    queue.outcomes.push(SENT)
    const later = new Date(waiting.sendAt.getTime() + 1000)
    const second = await runDueWork(later, { organizationId: orgId })
    expect(second.scheduled.sent).toBe(1)
    expect(await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })).toMatchObject({ status: 'SENT' })
  })

  it('gives up only after the same attempt cap as a provider error', async () => {
    let now = new Date()
    const sm = await scheduled(now)
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      queue.outcomes.push(CHECK_FAILED)
      await runDueWork(now, { organizationId: orgId })
      const row = await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })
      expect(row.attempts).toBe(i)
      expect(row.status).toBe(i < MAX_ATTEMPTS ? 'PENDING' : 'FAILED')
      now = new Date(row.sendAt.getTime() + 1000)
    }
  })

  it('a sequence step that hits a check error stays ACTIVE on the same step', async () => {
    const now = new Date()
    const e = await enrollment(now)
    queue.outcomes.push(CHECK_FAILED)
    const result = await runDueWork(now, { organizationId: orgId })
    expect(result.sequences).toMatchObject({ failed: 0, stopped: 0, deferred: 1 })
    const row = await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })
    expect(row).toMatchObject({ status: 'ACTIVE', currentStep: 0 })
    expect(row.nextRunAt?.getTime()).toBe(now.getTime() + retryBackoffMs(1))
    expect(row.attempts).toBe(1)
  })

  it('a sequence step stops retrying after the attempt cap instead of forever', async () => {
    let now = new Date()
    const e = await enrollment(now)
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      queue.outcomes.push(CHECK_FAILED)
      await runDueWork(now, { organizationId: orgId })
      const row = await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })
      expect(row.attempts).toBe(i)
      expect(row.status).toBe(i < MAX_ATTEMPTS ? 'ACTIVE' : 'FAILED')
      if (row.nextRunAt) now = new Date(row.nextRunAt.getTime() + 1000)
    }
    const done = await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })
    expect(done.stoppedReason).toContain(`Gave up after ${MAX_ATTEMPTS} attempts`)
    expect(done.nextRunAt).toBeNull()
  })

  it('a step that goes out clears the failed-check count', async () => {
    const now = new Date()
    const e = await enrollment(now)
    queue.outcomes.push(CHECK_FAILED)
    await runDueWork(now, { organizationId: orgId })
    queue.outcomes.push(SENT)
    await runDueWork(new Date(now.getTime() + retryBackoffMs(1) + 1000), { organizationId: orgId })
    expect(await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: 'COMPLETED', attempts: null })
  })
})

describe('no known time zone parks the text instead of failing it (automation-unknown-zone-permanent)', () => {
  it('a scheduled text waits without counting an attempt, tells the sender once, and goes out later', async () => {
    const now = new Date()
    const sm = await scheduled(now)
    const before = await zoneNotices()
    queue.outcomes.push(NO_ZONE)
    expect((await runDueWork(now, { organizationId: orgId })).scheduled).toMatchObject({ deferred: 1, failed: 0 })
    const parked = await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })
    expect(parked).toMatchObject({ status: 'PENDING', attempts: 0, error: ZONE_WAIT_NOTE })
    expect(parked.sendAt.getTime()).toBe(now.getTime() + ZONE_RECHECK_MS)
    expect(await zoneNotices()).toBe(before + 1)

    // Still no zone on the next check: no second notice.
    queue.outcomes.push(NO_ZONE)
    const again = new Date(parked.sendAt.getTime() + 1000)
    await runDueWork(again, { organizationId: orgId })
    expect(await zoneNotices()).toBe(before + 1)

    // A rep set the zone: it goes out and the note is gone.
    queue.outcomes.push(SENT)
    const row = await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })
    await runDueWork(new Date(row.sendAt.getTime() + 1000), { organizationId: orgId })
    expect(await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })).toMatchObject({ status: 'SENT', error: null })
  })

  it('a sequence stays ACTIVE on its step with the waiting note, and resumes once the zone is known', async () => {
    const now = new Date()
    const e = await enrollment(now)
    const before = await zoneNotices()
    queue.outcomes.push(NO_ZONE)
    const result = await runDueWork(now, { organizationId: orgId })
    expect(result.sequences).toMatchObject({ failed: 0, stopped: 0, deferred: 1 })
    const row = await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })
    expect(row).toMatchObject({ status: 'ACTIVE', currentStep: 0, stoppedReason: ZONE_WAIT_NOTE })
    expect(row.nextRunAt?.getTime()).toBe(now.getTime() + ZONE_RECHECK_MS)
    expect(await zoneNotices()).toBe(before + 1)

    queue.outcomes.push(SENT)
    await runDueWork(new Date(row.nextRunAt!.getTime() + 1000), { organizationId: orgId })
    expect(await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: 'COMPLETED', stoppedReason: null })
  })
})

describe('a possible opt-out hold waits instead of failing (regression-revocation-false-positives)', () => {
  it('a scheduled text waits while held, without counting an attempt, and goes out once lifted', async () => {
    const now = new Date()
    const sm = await scheduled(now)
    queue.outcomes.push(HELD)
    expect((await runDueWork(now, { organizationId: orgId })).scheduled).toMatchObject({ deferred: 1, failed: 0 })
    const held = await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })
    expect(held).toMatchObject({ status: 'PENDING', attempts: 0 })
    expect(held.sendAt.getTime()).toBe(now.getTime() + REVIEW_HOLD_RECHECK_MS)

    queue.outcomes.push(SENT)
    await runDueWork(new Date(held.sendAt.getTime() + 1000), { organizationId: orgId })
    expect(await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })).toMatchObject({ status: 'SENT' })
  })

  it('a sequence keeps its step while held', async () => {
    const now = new Date()
    const e = await enrollment(now)
    queue.outcomes.push(HELD)
    await runDueWork(now, { organizationId: orgId })
    const row = await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })
    expect(row).toMatchObject({ status: 'ACTIVE', currentStep: 0 })
    expect(row.nextRunAt?.getTime()).toBe(now.getTime() + REVIEW_HOLD_RECHECK_MS)
  })

  it('a decided block (not a hold) still ends the sequence', async () => {
    const now = new Date()
    const e = await enrollment(now)
    queue.outcomes.push({ ok: false, code: 'SUPPRESSED', error: 'Texts to this number are blocked (opt-out or do-not-contact list).' })
    await runDueWork(now, { organizationId: orgId })
    expect(await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: 'FAILED' })
  })
})
