import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { ForbiddenError, type SessionUser } from '@/lib/rbac'
import type { PermissionKey } from '@/lib/permissions'
import { evaluateConsent, isStopMessage, type ConsentRow } from '@/lib/messaging/consent'
import { pickTemplate, renderTemplate } from '@/lib/messaging/render'
import { MockEmailProvider, MockSmsProvider } from '@/lib/messaging/mock'
import { sendMessage } from '@/lib/messaging/send'

// ─── Pure logic ──────────────────────────────────────────────────────────────

const NOW = new Date('2026-08-01T12:00:00Z')

function consent(overrides: Partial<ConsentRow> & { type: ConsentRow['type'] }): ConsentRow {
  return {
    granted: true,
    grantedAt: new Date('2026-07-01T00:00:00Z'),
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

describe('consent gate (pure)', () => {
  it('allows email with a live ELECTRONIC_COMMUNICATION consent', () => {
    const d = evaluateConsent({ consents: [consent({ type: 'ELECTRONIC_COMMUNICATION' })], now: NOW }, 'EMAIL')
    expect(d.allowed).toBe(true)
  })

  it('allows SMS with a live TCPA_CONTACT consent', () => {
    const d = evaluateConsent({ consents: [consent({ type: 'TCPA_CONTACT' })], now: NOW }, 'SMS')
    expect(d.allowed).toBe(true)
  })

  it('blocks SMS when only email consent exists (wrong type)', () => {
    const d = evaluateConsent({ consents: [consent({ type: 'ELECTRONIC_COMMUNICATION' })], now: NOW }, 'SMS')
    expect(d).toMatchObject({ allowed: false, code: 'NO_CONSENT' })
  })

  it('blocks when there is no consent at all', () => {
    const d = evaluateConsent({ consents: [], now: NOW }, 'EMAIL')
    expect(d).toMatchObject({ allowed: false, code: 'NO_CONSENT' })
  })

  it('blocks a revoked consent', () => {
    const d = evaluateConsent(
      { consents: [consent({ type: 'TCPA_CONTACT', revokedAt: new Date('2026-07-15T00:00:00Z') })], now: NOW },
      'SMS',
    )
    expect(d).toMatchObject({ allowed: false, code: 'CONSENT_REVOKED' })
  })

  it('blocks a declined consent', () => {
    const d = evaluateConsent(
      { consents: [consent({ type: 'ELECTRONIC_COMMUNICATION', granted: false })], now: NOW },
      'EMAIL',
    )
    expect(d).toMatchObject({ allowed: false, code: 'CONSENT_DECLINED' })
  })

  it('blocks an expired consent', () => {
    const d = evaluateConsent(
      { consents: [consent({ type: 'TCPA_CONTACT', expiresAt: new Date('2026-07-20T00:00:00Z') })], now: NOW },
      'SMS',
    )
    expect(d).toMatchObject({ allowed: false, code: 'CONSENT_EXPIRED' })
  })

  it('uses the most recent consent row when several exist', () => {
    const d = evaluateConsent(
      {
        consents: [
          consent({ type: 'TCPA_CONTACT', grantedAt: new Date('2026-06-01T00:00:00Z'), granted: false }),
          consent({ type: 'TCPA_CONTACT', grantedAt: new Date('2026-07-10T00:00:00Z') }),
        ],
        now: NOW,
      },
      'SMS',
    )
    expect(d.allowed).toBe(true)
  })

  it('blocks after a STOP-type inbound message even with a live consent', () => {
    const d = evaluateConsent(
      {
        consents: [consent({ type: 'TCPA_CONTACT' })],
        latestInbound: { body: 'STOP', optOutDetected: false },
        now: NOW,
      },
      'SMS',
    )
    expect(d).toMatchObject({ allowed: false, code: 'OPTED_OUT' })
  })

  it('blocks when the provider flagged the inbound as an opt-out', () => {
    const d = evaluateConsent(
      {
        consents: [consent({ type: 'ELECTRONIC_COMMUNICATION' })],
        latestInbound: { body: 'take me off the list', optOutDetected: true },
        now: NOW,
      },
      'EMAIL',
    )
    expect(d).toMatchObject({ allowed: false, code: 'OPTED_OUT' })
  })

  it('does not treat a normal message mentioning stop as an opt-out', () => {
    const d = evaluateConsent(
      {
        consents: [consent({ type: 'TCPA_CONTACT' })],
        latestInbound: { body: 'please stop by the office tomorrow', optOutDetected: false },
        now: NOW,
      },
      'SMS',
    )
    expect(d.allowed).toBe(true)
  })
})

describe('isStopMessage', () => {
  it.each(['STOP', 'stop', ' Stop ', 'STOP!', 'unsubscribe', 'QUIT', 'Cancel.'])('detects %s', (body) => {
    expect(isStopMessage(body)).toBe(true)
  })

  it.each(['please stop calling my office', 'can you cancel my appointment', '', null])(
    'does not flag %s',
    (body) => {
      expect(isStopMessage(body as string | null)).toBe(false)
    },
  )
})

describe('template rendering', () => {
  const vars = { first_name: 'Ana', company_name: 'ProdigyFlo' }

  it('substitutes variables in subject and body', () => {
    const r = renderTemplate({ subject: 'Hi {{first_name}}', body: '{{first_name}} — {{ company_name }}' }, vars)
    expect(r.subject).toBe('Hi Ana')
    expect(r.body).toBe('Ana — ProdigyFlo')
    expect(r.unresolved).toEqual([])
  })

  it('reports unresolved variables and leaves the placeholder intact', () => {
    const r = renderTemplate({ body: 'Hi {{first_name}}, see you {{appointment_date}}' }, vars)
    expect(r.unresolved).toEqual(['appointment_date'])
    expect(r.body).toContain('{{appointment_date}}')
  })

  it('treats empty-string values as unresolved', () => {
    const r = renderTemplate({ body: 'Hi {{owner_name}}' }, { owner_name: '' })
    expect(r.unresolved).toEqual(['owner_name'])
  })

  it('pickTemplate prefers exact locale, then falls back to English', () => {
    const en = { locale: 'en', id: 'a' }
    const es = { locale: 'es', id: 'b' }
    expect(pickTemplate([en, es], 'es')).toBe(es)
    expect(pickTemplate([en, es], 'fr')).toBe(en)
    expect(pickTemplate([es], 'fr')).toBeNull()
  })
})

describe('mock providers', () => {
  it('email send is confirmed with a deterministic externalRef', async () => {
    const p = new MockEmailProvider()
    const msg = { to: 'ana@example.com', subject: 'Hello', body: 'Body' }
    const [a, b] = [await p.send(msg), await p.send(msg)]
    expect(a.status).toBe('SENT')
    expect(a.externalRef).toMatch(/^mock-email-[0-9a-f]{12}$/)
    expect(a.externalRef).toBe(b.externalRef)
  })

  it('email to an address containing "fail" fails with an error', async () => {
    const r = await new MockEmailProvider().send({ to: 'bounce.fail@example.com', subject: 's', body: 'b' })
    expect(r.status).toBe('FAILED')
    expect(r.externalRef).toBeNull()
    expect(r.error).toMatch(/fail/i)
  })

  it('sms mirrors the same behaviour', async () => {
    const ok = await new MockSmsProvider().send({ to: '+17025550111', body: 'hi' })
    expect(ok.status).toBe('SENT')
    expect(ok.externalRef).toMatch(/^mock-sms-/)
    const bad = await new MockSmsProvider().send({ to: '+1702FAIL999', body: 'hi' })
    expect(bad.status).toBe('FAILED')
  })
})

// ─── Send service (DB-backed, own fixtures in a throwaway org) ───────────────

const stamp = `msgtest-${Date.now()}`
let orgId: string
let userId: string
let roleId: string
let clientOkId: string
let clientFailId: string
let clientRevokedId: string
let emailTemplateId: string

function sessionUser(permissions: PermissionKey[]): SessionUser {
  return {
    id: userId,
    name: 'Test Sender',
    email: `${stamp}@example.com`,
    organizationId: orgId,
    organizationName: 'Msg Test Org',
    roleId,
    isOwner: false,
    role: 'ADMIN',
    roleName: 'Admin',
    regionId: null,
    teamId: null,
    managerId: null,
    avatarUrl: null,
    title: null,
    permissions: new Set(permissions),
    portalClientId: null,
  }
}

const CONSENT_BASE = { textVersion: 'v1', text: 'Test consent text', purpose: 'testing' }

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: 'Msg Test Org', slug: stamp } })
  orgId = org.id
  const role = await db.role.create({ data: { organizationId: orgId, key: 'ADMIN', name: 'Admin' } })
  roleId = role.id
  const user = await db.user.create({
    data: { organizationId: orgId, roleId, email: `${stamp}@example.com`, passwordHash: 'x', name: 'Test Sender' },
  })
  userId = user.id
  const pipeline = await db.pipeline.create({ data: { organizationId: orgId, name: 'Test pipeline' } })
  const stage = await db.pipelineStage.create({
    data: { pipelineId: pipeline.id, key: 'NEW_LEAD', name: 'New lead', category: 'INTAKE', position: 0 },
  })

  const clientBase = { organizationId: orgId, pipelineId: pipeline.id, currentStageId: stage.id }

  const ok = await db.client.create({
    data: {
      ...clientBase,
      firstName: 'Ana',
      lastName: 'Serrano',
      email: `ana.${stamp}@example.com`,
      phone: '+17025550111',
      consents: {
        create: [
          { ...CONSENT_BASE, type: 'ELECTRONIC_COMMUNICATION', granted: true },
          { ...CONSENT_BASE, type: 'TCPA_CONTACT', granted: true },
        ],
      },
    },
  })
  clientOkId = ok.id

  const fail = await db.client.create({
    data: {
      ...clientBase,
      firstName: 'Bounce',
      lastName: 'Rivera',
      email: `bounce.fail.${stamp}@example.com`,
      phone: '+17025550112',
      consents: { create: [{ ...CONSENT_BASE, type: 'ELECTRONIC_COMMUNICATION', granted: true }] },
    },
  })
  clientFailId = fail.id

  const revoked = await db.client.create({
    data: {
      ...clientBase,
      firstName: 'Rosa',
      lastName: 'Nguyen',
      email: `rosa.${stamp}@example.com`,
      phone: '+17025550113',
      consents: {
        create: [{ ...CONSENT_BASE, type: 'TCPA_CONTACT', granted: true, revokedAt: new Date() }],
      },
    },
  })
  clientRevokedId = revoked.id

  const template = await db.messageTemplate.create({
    data: {
      organizationId: orgId,
      key: 'test_follow_up_email',
      name: 'Test follow up',
      channel: 'EMAIL',
      locale: 'en',
      subject: 'Hello {{first_name}}',
      body: 'Hi {{first_name}}, this is {{company_name}}.',
    },
  })
  emailTemplateId = template.id
})

afterAll(async () => {
  // The org cascades to every fixture row (users, clients, comms, audit, templates).
  await db.organization.delete({ where: { id: orgId } }).catch(() => {})
})

describe('sendMessage', () => {
  it('refuses a caller without communications:send and persists nothing', async () => {
    const before = await db.communication.count({ where: { clientId: clientOkId } })
    await expect(
      sendMessage(sessionUser(['clients:read_all']), { clientId: clientOkId, channel: 'EMAIL', body: 'hi' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(await db.communication.count({ where: { clientId: clientOkId } })).toBe(before)
  })

  it('refuses a client outside the sender scope', async () => {
    const strangerScope = sessionUser(['communications:send', 'clients:read_assigned'])
    await expect(
      sendMessage(strangerScope, { clientId: clientOkId, channel: 'EMAIL', body: 'hi' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('sends a template email and records Communication + Message as SENT with an audit event', async () => {
    const user = sessionUser(['communications:send', 'clients:read_all'])
    const outcome = await sendMessage(user, {
      clientId: clientOkId,
      channel: 'EMAIL',
      templateId: emailTemplateId,
      followUpTask: { dueAt: new Date(Date.now() + 3 * 86_400_000) },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.status).toBe('SENT')

    const comm = await db.communication.findUniqueOrThrow({
      where: { id: outcome.communicationId },
      include: { message: true },
    })
    expect(comm.status).toBe('SENT')
    expect(comm.channel).toBe('EMAIL')
    expect(comm.direction).toBe('OUTBOUND')
    expect(comm.templateKey).toBe('test_follow_up_email')
    expect(comm.externalRef).toMatch(/^mock-email-/)
    expect(comm.subject).toBe('Hello Ana')
    expect(comm.body).toContain('Msg Test Org')
    expect(comm.message?.toMasked).toContain('@')
    expect(comm.message?.failureCode).toBeNull()

    const audit = await db.auditEvent.findFirst({
      where: { organizationId: orgId, action: 'communication.send', entityId: comm.id },
    })
    expect(audit).not.toBeNull()

    const task = await db.task.findFirst({ where: { clientId: clientOkId, createdById: userId } })
    expect(task).not.toBeNull()
    expect(task?.dueAt).not.toBeNull()
  })

  it('records FAILED with a failure code when the provider rejects the recipient', async () => {
    const user = sessionUser(['communications:send', 'clients:read_all'])
    const outcome = await sendMessage(user, {
      clientId: clientFailId,
      channel: 'EMAIL',
      subject: 'Test',
      body: 'Plain body with no variables.',
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.status).toBe('FAILED')

    const comm = await db.communication.findUniqueOrThrow({
      where: { id: outcome.communicationId },
      include: { message: true },
    })
    expect(comm.status).toBe('FAILED')
    expect(comm.externalRef).toBeNull()
    expect(comm.message?.failureCode).toMatch(/fail/i)
  })

  it('refuses an SMS when the TCPA consent was revoked, persisting nothing', async () => {
    const user = sessionUser(['communications:send', 'clients:read_all'])
    const before = await db.communication.count({ where: { clientId: clientRevokedId } })
    const outcome = await sendMessage(user, { clientId: clientRevokedId, channel: 'SMS', body: 'hi' })
    expect(outcome).toMatchObject({ ok: false, code: 'CONSENT_REVOKED' })
    expect(await db.communication.count({ where: { clientId: clientRevokedId } })).toBe(before)
  })

  it('refuses a message containing an unresolved variable, persisting nothing', async () => {
    const user = sessionUser(['communications:send', 'clients:read_all'])
    const before = await db.communication.count({ where: { clientId: clientOkId } })
    const outcome = await sendMessage(user, {
      clientId: clientOkId,
      channel: 'EMAIL',
      subject: 'Hi {{first_name}}',
      body: 'See you on {{appointment_date}}',
    })
    expect(outcome).toMatchObject({ ok: false, code: 'UNRESOLVED_VARIABLES' })
    expect(await db.communication.count({ where: { clientId: clientOkId } })).toBe(before)
  })

  it('refuses a template on the wrong channel', async () => {
    const user = sessionUser(['communications:send', 'clients:read_all'])
    const outcome = await sendMessage(user, {
      clientId: clientOkId,
      channel: 'SMS',
      templateId: emailTemplateId,
    })
    expect(outcome).toMatchObject({ ok: false, code: 'TEMPLATE_NOT_FOUND' })
  })
})
