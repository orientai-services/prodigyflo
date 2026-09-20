import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import {
  processInboundMessage,
  signInboundBody,
  verifyInboundSignature,
} from '@/lib/messaging/inbound'
import { runDueWork, retryBackoffMs, MAX_ATTEMPTS } from '@/lib/automation/engine'
import { enrollOnStageChange } from '@/lib/automation/triggers'

/**
 * Messaging-automation slice: inbound webhook processing, the sequence /
 * scheduled-message engine, and stage-change enrollment triggers.
 * DB-backed with a throwaway org; the org delete cascades everything.
 */

const stamp = `autotest-${Date.now()}`
const TOKEN = `jobs-token-${stamp}`

let orgId: string
let roleId: string
let senderId: string
let pipelineId: string
let stageId: string

let emailClientId: string // email consent, owner = sender
let stopClientId: string // TCPA consent, receives the STOP message
let revokedClientId: string // TCPA revoked
let orphanClientId: string // no owner
let failClientId: string // email consent, address triggers mock provider failure

const CONSENT_BASE = { textVersion: 'v1', text: 'Test consent text', purpose: 'testing' }

async function makeClient(data: {
  firstName: string
  email: string
  phone: string
  ownerId?: string | null
  consents?: { type: 'ELECTRONIC_COMMUNICATION' | 'TCPA_CONTACT'; granted: boolean; revokedAt?: Date | null }[]
}): Promise<string> {
  const client = await db.client.create({
    data: {
      organizationId: orgId,
      pipelineId,
      currentStageId: stageId,
      firstName: data.firstName,
      lastName: 'Automation',
      email: data.email,
      phone: data.phone,
      ownerId: data.ownerId ?? null,
      consents: {
        create: (data.consents ?? []).map((c) => ({
          ...CONSENT_BASE,
          type: c.type,
          granted: c.granted,
          revokedAt: c.revokedAt ?? null,
        })),
      },
    },
  })
  return client.id
}

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: 'Automation Test Org', slug: stamp } })
  orgId = org.id

  const role = await db.role.create({ data: { organizationId: orgId, key: 'SUPER_ADMIN', name: 'Admin' } })
  roleId = role.id
  // loadActor reads permissions from the DB, so the role needs real rows.
  for (const key of ['communications:send', 'clients:read_all', 'users:manage'] as const) {
    const permission = await db.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: key, category: 'test' },
    })
    await db.rolePermission.create({ data: { roleId, permissionId: permission.id } })
  }

  const sender = await db.user.create({
    data: {
      organizationId: orgId,
      roleId,
      email: `sender.${stamp}@example.com`,
      passwordHash: 'x',
      name: 'Automation Sender',
      phone: '+17025551000',
    },
  })
  senderId = sender.id

  const pipeline = await db.pipeline.create({ data: { organizationId: orgId, name: 'Test pipeline' } })
  pipelineId = pipeline.id
  const stage = await db.pipelineStage.create({
    data: { pipelineId, key: 'NEW_LEAD', name: 'New lead', category: 'INTAKE', position: 0 },
  })
  stageId = stage.id

  emailClientId = await makeClient({
    firstName: 'Elena',
    email: `elena.${stamp}@example.com`,
    phone: '+17025551101',
    ownerId: senderId,
    consents: [{ type: 'ELECTRONIC_COMMUNICATION', granted: true }],
  })
  stopClientId = await makeClient({
    firstName: 'Stella',
    email: `stella.${stamp}@example.com`,
    phone: '+17025551103',
    ownerId: senderId,
    consents: [{ type: 'TCPA_CONTACT', granted: true }],
  })
  revokedClientId = await makeClient({
    firstName: 'Rita',
    email: `rita.${stamp}@example.com`,
    phone: '+17025551104',
    ownerId: senderId,
    consents: [{ type: 'TCPA_CONTACT', granted: true, revokedAt: new Date() }],
  })
  orphanClientId = await makeClient({
    firstName: 'Omar',
    email: `omar.${stamp}@example.com`,
    phone: '+17025551105',
    ownerId: null,
    consents: [{ type: 'ELECTRONIC_COMMUNICATION', granted: true }],
  })
  failClientId = await makeClient({
    firstName: 'Bounce',
    email: `bounce.fail.${stamp}@example.com`,
    phone: '+17025551106',
    ownerId: senderId,
    consents: [{ type: 'ELECTRONIC_COMMUNICATION', granted: true }],
  })

  await db.messageTemplate.createMany({
    data: [
      {
        organizationId: orgId,
        key: 'auto_follow_email',
        name: 'Auto follow-up',
        channel: 'EMAIL',
        locale: 'en',
        subject: 'Checking in, {{first_name}}',
        body: 'Hi {{first_name}}, just checking in from {{company_name}}.',
      },
      {
        organizationId: orgId,
        key: 'auto_follow_sms',
        name: 'Auto follow-up (SMS)',
        channel: 'SMS',
        locale: 'en',
        subject: null,
        body: 'Hi {{first_name}}, checking in from {{company_name}}. Reply STOP to opt out.',
      },
    ],
  })
})

afterAll(async () => {
  await db.organization.delete({ where: { id: orgId } }).catch(() => {})
})

// ─── Inbound HMAC ────────────────────────────────────────────────────────────

describe('inbound signature', () => {
  const raw = '{"from":"a@b.c","body":"hi","external_id":"x1"}'

  it('accepts a correct HMAC and rejects a wrong key', () => {
    const header = signInboundBody(TOKEN, raw)
    expect(verifyInboundSignature(raw, header, TOKEN)).toBe(true)
    expect(verifyInboundSignature(raw, header, 'other-token')).toBe(false)
  })

  it('rejects a tampered body and a missing header', () => {
    const header = signInboundBody(TOKEN, raw)
    expect(verifyInboundSignature(raw + ' ', header, TOKEN)).toBe(false)
    expect(verifyInboundSignature(raw, null, TOKEN)).toBe(false)
  })

  it('refuses everything when no token is configured', () => {
    expect(verifyInboundSignature(raw, signInboundBody(TOKEN, raw), undefined)).toBe(false)
  })
})

// ─── Inbound processing ──────────────────────────────────────────────────────

describe('processInboundMessage', () => {
  it('matches a client by email and records an INBOUND/RECEIVED communication', async () => {
    const result = await processInboundMessage('EMAIL', {
      from: `Elena.${stamp}@EXAMPLE.com`, // case-insensitive match
      to: `sender.${stamp}@example.com`,
      subject: 'Re: your email',
      body: 'Sounds good, thank you!',
      external_id: `${stamp}-in-1`,
    })
    expect(result.matched).toBe(true)
    if (!result.matched) return
    expect(result.duplicate).toBe(false)
    expect(result.clientId).toBe(emailClientId)

    const comm = await db.communication.findUniqueOrThrow({
      where: { id: result.communicationId },
      include: { message: true },
    })
    expect(comm.direction).toBe('INBOUND')
    expect(comm.status).toBe('RECEIVED')
    expect(comm.subject).toBe('Re: your email')
    expect(comm.externalRef).toBe(`${stamp}-in-1`)
    expect(comm.message?.optOutDetected).toBe(false)
  })

  it('is idempotent on external_id — a replay writes nothing new', async () => {
    const before = await db.communication.count({ where: { clientId: emailClientId } })
    const result = await processInboundMessage('EMAIL', {
      from: `elena.${stamp}@example.com`,
      body: 'Sounds good, thank you!',
      external_id: `${stamp}-in-1`,
    })
    expect(result).toMatchObject({ matched: true, duplicate: true })
    expect(await db.communication.count({ where: { clientId: emailClientId } })).toBe(before)
  })

  it('matches by phone for SMS and a STOP body revokes TCPA consent', async () => {
    const result = await processInboundMessage('SMS', {
      from: '(702) 555-1103', // formatted differently from the stored value
      to: '+17025551000', // the sender user's number pins the tenant
      body: 'STOP',
      external_id: `${stamp}-in-stop`,
    })
    expect(result.matched).toBe(true)
    if (!result.matched) return
    expect(result.clientId).toBe(stopClientId)
    expect(result.optOut).toBe(true)

    const comm = await db.communication.findUniqueOrThrow({
      where: { id: result.communicationId },
      include: { message: true },
    })
    expect(comm.message?.optOutDetected).toBe(true)

    const consents = await db.consent.findMany({ where: { clientId: stopClientId, type: 'TCPA_CONTACT' } })
    expect(consents.length).toBeGreaterThan(0)
    expect(consents.every((c) => c.revokedAt !== null)).toBe(true)
  })

  it('routes an unmatched message to users:manage holders as a notification', async () => {
    const before = await db.notification.count({ where: { userId: senderId } })
    const result = await processInboundMessage('EMAIL', {
      from: `nobody.${stamp}@example.com`,
      to: `sender.${stamp}@example.com`, // pins the tenant via the recipient
      body: 'Hello, is anyone there?',
      external_id: `${stamp}-in-unmatched`,
    })
    expect(result.matched).toBe(false)

    const after = await db.notification.findMany({
      where: { userId: senderId, kind: 'MESSAGE' },
      orderBy: { createdAt: 'desc' },
    })
    expect(after.length).toBe(before + 1)
    expect(after[0].title).toMatch(/^Unmatched inbound/)
    expect(after[0].href).toBe('/inbox')
  })
})

// ─── Engine: scheduled messages ──────────────────────────────────────────────

describe('engine — scheduled messages', () => {
  it('sends a due scheduled message and marks it SENT with its communication', async () => {
    const sm = await db.scheduledMessage.create({
      data: {
        organizationId: orgId,
        clientId: emailClientId,
        userId: senderId,
        channel: 'EMAIL',
        subject: 'Scheduled hello',
        body: 'Hi {{first_name}}, this was scheduled.',
        sendAt: new Date(Date.now() - 60_000),
      },
    })

    await runDueWork(new Date(), { organizationId: orgId })

    const updated = await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })
    expect(updated.status).toBe('SENT')
    expect(updated.communicationId).toBeTruthy()
    const comm = await db.communication.findUniqueOrThrow({ where: { id: updated.communicationId! } })
    expect(comm.direction).toBe('OUTBOUND')
    expect(comm.status).toBe('SENT')
    expect(comm.body).toContain('Hi Elena')
  })

  it('never touches a CANCELLED message, even when its sendAt has passed', async () => {
    const sm = await db.scheduledMessage.create({
      data: {
        organizationId: orgId,
        clientId: emailClientId,
        userId: senderId,
        channel: 'EMAIL',
        subject: 'Should not send',
        body: 'Cancelled body',
        sendAt: new Date(Date.now() - 60_000),
        status: 'CANCELLED',
      },
    })
    await runDueWork(new Date(), { organizationId: orgId })
    const updated = await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })
    expect(updated.status).toBe('CANCELLED')
    expect(updated.attempts).toBe(0)
    expect(updated.communicationId).toBeNull()
  })

  it('retries a provider failure with backoff and gives up after the cap', async () => {
    const sm = await db.scheduledMessage.create({
      data: {
        organizationId: orgId,
        clientId: failClientId, // mock provider fails any address containing "fail"
        userId: senderId,
        channel: 'EMAIL',
        subject: 'Doomed',
        body: 'This send always fails.',
        sendAt: new Date(Date.now() - 60_000),
      },
    })

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const now = new Date()
      await runDueWork(now, { organizationId: orgId })
      const updated = await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })
      expect(updated.attempts).toBe(attempt)
      if (attempt < MAX_ATTEMPTS) {
        expect(updated.status).toBe('PENDING')
        expect(updated.error).toBeTruthy()
        // Backoff pushed the next try into the future…
        expect(updated.sendAt.getTime()).toBeGreaterThan(now.getTime())
        expect(updated.sendAt.getTime()).toBeLessThanOrEqual(now.getTime() + retryBackoffMs(attempt) + 1000)
        // …so pull it back to make it due for the next loop iteration.
        await db.scheduledMessage.update({ where: { id: sm.id }, data: { sendAt: new Date(Date.now() - 1000) } })
      } else {
        expect(updated.status).toBe('FAILED')
        expect(updated.error).toMatch(/Gave up after 3 attempts/)
      }
    }
  })

  it('fails (no retry) a message whose consent is refused', async () => {
    const sm = await db.scheduledMessage.create({
      data: {
        organizationId: orgId,
        clientId: revokedClientId, // TCPA revoked
        userId: senderId,
        channel: 'SMS',
        body: 'Should be blocked by consent.',
        sendAt: new Date(Date.now() - 60_000),
      },
    })
    await runDueWork(new Date(), { organizationId: orgId })
    const updated = await db.scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })
    expect(updated.status).toBe('FAILED')
    expect(updated.error).toMatch(/revoked/i)
  })
})

// ─── Engine: sequences ───────────────────────────────────────────────────────

async function makeSequence(name: string, steps: { delayHours: number; channel: 'EMAIL' | 'SMS'; templateKey: string; stopIfReplied: boolean }[], triggerStageKey: 'NEW_LEAD' | null = null) {
  return db.sequence.create({
    data: {
      organizationId: orgId,
      name,
      isActive: true,
      triggerStageKey,
      steps: { create: steps.map((s, position) => ({ position, ...s })) },
    },
  })
}

describe('engine — sequences', () => {
  it('sends a due step, advances, and completes after the last step', async () => {
    const seq = await makeSequence(`${stamp}-two-step`, [
      { delayHours: 1, channel: 'EMAIL', templateKey: 'auto_follow_email', stopIfReplied: false },
      { delayHours: 48, channel: 'EMAIL', templateKey: 'auto_follow_email', stopIfReplied: false },
    ])
    const enrollment = await db.sequenceEnrollment.create({
      data: {
        sequenceId: seq.id,
        clientId: emailClientId,
        status: 'ACTIVE',
        currentStep: 0,
        nextRunAt: new Date(Date.now() - 1000),
        enrolledById: senderId,
      },
    })

    const commsBefore = await db.communication.count({ where: { clientId: emailClientId, direction: 'OUTBOUND' } })
    const now = new Date()
    await runDueWork(now, { organizationId: orgId })

    let updated = await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })
    expect(updated.status).toBe('ACTIVE')
    expect(updated.currentStep).toBe(1)
    expect(updated.nextRunAt?.getTime()).toBe(now.getTime() + 48 * 3_600_000)
    expect(await db.communication.count({ where: { clientId: emailClientId, direction: 'OUTBOUND' } })).toBe(
      commsBefore + 1,
    )

    // Make step 2 due and finish the sequence.
    await db.sequenceEnrollment.update({ where: { id: enrollment.id }, data: { nextRunAt: new Date(Date.now() - 1000) } })
    await runDueWork(new Date(), { organizationId: orgId })
    updated = await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })
    expect(updated.status).toBe('COMPLETED')
    expect(updated.currentStep).toBe(2)
    expect(updated.nextRunAt).toBeNull()
    expect(await db.communication.count({ where: { clientId: emailClientId, direction: 'OUTBOUND' } })).toBe(
      commsBefore + 2,
    )
  })

  it('stopIfReplied completes the enrollment without sending when the client replied', async () => {
    const seq = await makeSequence(`${stamp}-stop-replied`, [
      { delayHours: 1, channel: 'EMAIL', templateKey: 'auto_follow_email', stopIfReplied: true },
    ])
    const enrollment = await db.sequenceEnrollment.create({
      data: {
        sequenceId: seq.id,
        clientId: emailClientId,
        status: 'ACTIVE',
        currentStep: 0,
        // Enrolled in the past; the earlier inbound reply is newer than this.
        nextRunAt: new Date(Date.now() - 1000),
        enrolledById: senderId,
      },
    })
    await db.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: { createdAt: new Date(Date.now() - 7 * 86_400_000) },
    })

    const commsBefore = await db.communication.count({ where: { clientId: emailClientId, direction: 'OUTBOUND' } })
    await runDueWork(new Date(), { organizationId: orgId })

    const updated = await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })
    expect(updated.status).toBe('COMPLETED')
    expect(updated.stoppedReason).toMatch(/replied/i)
    expect(await db.communication.count({ where: { clientId: emailClientId, direction: 'OUTBOUND' } })).toBe(commsBefore)
  })

  it('a consent refusal stops the enrollment with the reason', async () => {
    const seq = await makeSequence(`${stamp}-consent-stop`, [
      { delayHours: 1, channel: 'SMS', templateKey: 'auto_follow_sms', stopIfReplied: false },
    ])
    const enrollment = await db.sequenceEnrollment.create({
      data: {
        sequenceId: seq.id,
        clientId: revokedClientId,
        status: 'ACTIVE',
        currentStep: 0,
        nextRunAt: new Date(Date.now() - 1000),
        enrolledById: senderId,
      },
    })
    await runDueWork(new Date(), { organizationId: orgId })
    const updated = await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })
    expect(updated.status).toBe('STOPPED')
    expect(updated.stoppedReason).toMatch(/revoked/i)
  })

  it('stops with "no sender" when neither enroller nor owner exists', async () => {
    const seq = await makeSequence(`${stamp}-no-sender`, [
      { delayHours: 1, channel: 'EMAIL', templateKey: 'auto_follow_email', stopIfReplied: false },
    ])
    const enrollment = await db.sequenceEnrollment.create({
      data: {
        sequenceId: seq.id,
        clientId: orphanClientId,
        status: 'ACTIVE',
        currentStep: 0,
        nextRunAt: new Date(Date.now() - 1000),
        enrolledById: null,
      },
    })
    await runDueWork(new Date(), { organizationId: orgId })
    const updated = await db.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } })
    expect(updated.status).toBe('STOPPED')
    expect(updated.stoppedReason).toMatch(/no sender/i)
  })
})

// ─── Triggers ────────────────────────────────────────────────────────────────

describe('enrollOnStageChange', () => {
  it('enrolls once on the trigger stage and never duplicates', async () => {
    const seq = await makeSequence(
      `${stamp}-triggered`,
      [{ delayHours: 2, channel: 'EMAIL', templateKey: 'auto_follow_email', stopIfReplied: true }],
      'NEW_LEAD',
    )
    const clientId = await makeClient({
      firstName: 'Tara',
      email: `tara.${stamp}@example.com`,
      phone: '+17025551107',
      ownerId: senderId,
      consents: [{ type: 'ELECTRONIC_COMMUNICATION', granted: true }],
    })

    await enrollOnStageChange(clientId, 'NEW_LEAD')
    const first = await db.sequenceEnrollment.findMany({ where: { sequenceId: seq.id, clientId } })
    expect(first).toHaveLength(1)
    expect(first[0].status).toBe('ACTIVE')
    expect(first[0].currentStep).toBe(0)
    expect(first[0].nextRunAt).not.toBeNull()

    // A second bounce through the stage does not re-enroll.
    await enrollOnStageChange(clientId, 'NEW_LEAD')
    expect(await db.sequenceEnrollment.count({ where: { sequenceId: seq.id, clientId } })).toBe(1)

    // A different stage never enrolls.
    await enrollOnStageChange(clientId, 'SURVEY_STARTED')
    expect(await db.sequenceEnrollment.count({ where: { clientId } })).toBe(1)
  })
})
