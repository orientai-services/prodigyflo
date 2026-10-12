import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { IntakeSource } from '@prisma/client'
import type { SessionUser } from '@/lib/rbac'
import { db } from '@/lib/db'
import { processInbound } from '@/lib/intake/apply'
import { hashIntakeSecret } from '@/lib/intake/hmac'
import { INTAKE_SURVEY_NAME } from '@/lib/org/bootstrap'
import { resetTelephonyProvider } from '@/lib/telephony'
import { makeOrg, makeUser, stubTelephonyEnv, testNumber } from '../../../tests/fixtures/telephony'
import { scsIntakeLinkFor, scsIntakeTextStatusFor, takeCallCenterLeadFor } from './desk'
import { signIntakeToken } from './intake-link'
import { ingestCallCenterMetaLead } from './meta-ingest'
import { SCS_ENGLISH_PAGE_ID } from './meta-route'
import { findPossibleMatch, linkLeadToClientFor } from './possible-match'

const run = `cclink-${Date.now().toString(36)}`
const NOW = new Date('2026-10-12T18:00:00.000Z')

function packet(scsLeadId: string, pfl: string | null, extra: Record<string, unknown> = {}) {
  const email = `link.${scsLeadId.slice(0, 8)}@example.test`
  return {
    id: `delivery-${scsLeadId}`,
    lead_id: scsLeadId,
    event_type: 'lead.received',
    first_name: 'Linda',
    last_name: 'Linked',
    email,
    phone: '702-555-0177',
    data: {
      schema_version: 'schema_42.v1',
      stage1_answers: { first_name: 'Linda', last_name: 'Linked', email, phone: '702-555-0177' },
      documents: { files: [] },
      attribution: { utm_source: 'prodigyflo', ...(pfl ? { pfl } : {}) },
      ...extra,
    },
  }
}

async function ingest(source: IntakeSource, body: ReturnType<typeof packet>) {
  const { submission } = await processInbound(source, `scs:${body.lead_id}`, body)
  expect(submission.status).toBe('APPLIED')
  expect(submission.clientId).toBeTruthy()
  return submission.clientId as string
}

describe('SCS intake link (desk + receiver)', () => {
  let orgId = ''
  let pipelineId = ''
  let stageId = ''
  let otherOrgId = ''
  let source: IntakeSource
  let rep: { id: string; actor: SessionUser }
  let other: { id: string; actor: SessionUser }
  let admin: { id: string; actor: SessionUser }
  let leadId = ''
  let foreignLeadId = ''
  let matchLeadId = ''
  const matchPhone = testNumber(run, 3)

  beforeAll(async () => {
    vi.stubEnv('AUTH_SECRET', 'test-only-auth-secret-for-intake-links')
    const org = await makeOrg(run, 'Link')
    orgId = org.orgId
    pipelineId = org.pipelineId
    stageId = org.intakeStageId
    stubTelephonyEnv(orgId, { SMS_PROVIDER: 'mock' })
    vi.stubEnv('SMS_PROVIDER', 'mock')
    resetTelephonyProvider()
    rep = await makeUser(orgId, run, 'Link Rep', 'CLOSER')
    other = await makeUser(orgId, run, 'Other Rep', 'CLOSER')
    admin = await makeUser(orgId, run, 'Link Admin', 'SUPER_ADMIN', { permissions: ['users:manage', 'clients:reassign'] })
    await db.survey.create({ data: { organizationId: orgId, name: INTAKE_SURVEY_NAME, version: 1, schema: {} } })
    source = await db.intakeSource.create({
      data: {
        organizationId: orgId,
        kind: 'WEB_FORM',
        name: 'SCS',
        slug: 'scs-website',
        authMode: 'TOKEN',
        secretHash: hashIntakeSecret(`scs-${run}`),
        fieldMapping: { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone' },
        dedupeKeys: ['email', 'phone'],
      },
    })
    const saved = await ingestCallCenterMetaLead({
      organizationId: orgId,
      pageId: SCS_ENGLISH_PAGE_ID,
      lead: { leadgenId: `${run}-1`, createdTime: NOW.toISOString(), fields: { full_name: 'Linda Linked', phone_number: testNumber(run, 1) } },
    })
    leadId = saved.leadId
    const matched = await ingestCallCenterMetaLead({
      organizationId: orgId,
      pageId: SCS_ENGLISH_PAGE_ID,
      lead: { leadgenId: `${run}-3`, createdTime: NOW.toISOString(), fields: { full_name: 'Mo Match', phone_number: matchPhone } },
    })
    matchLeadId = matched.leadId

    const foreign = await makeOrg(run, 'Foreign')
    otherOrgId = foreign.orgId
    const f = await ingestCallCenterMetaLead({
      organizationId: otherOrgId,
      pageId: SCS_ENGLISH_PAGE_ID,
      lead: { leadgenId: `${run}-2`, createdTime: NOW.toISOString(), fields: { full_name: 'Far Away', phone_number: testNumber(run, 2) } },
    })
    foreignLeadId = f.leadId
  })

  afterAll(async () => {
    if (orgId) await db.organization.delete({ where: { id: orgId } })
    if (otherOrgId) await db.organization.delete({ where: { id: otherOrgId } })
    vi.unstubAllEnvs()
  })

  it('needs the lock', async () => {
    expect(await scsIntakeLinkFor(rep.actor, leadId, 'copy', NOW)).toEqual({ ok: false, reason: 'Take this lead first' })
    expect((await takeCallCenterLeadFor(orgId, rep.actor, leadId, NOW)).ok).toBe(true)
    expect(await scsIntakeLinkFor(other.actor, leadId, 'copy', NOW)).toEqual({ ok: false, reason: 'Another rep has this lead' })
  })

  it('opens (rep-assisted) and copies, logging each mode and keeping the first send time', async () => {
    const opened = await scsIntakeLinkFor(rep.actor, leadId, 'open', NOW)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const url = new URL(opened.url!)
    expect(url.searchParams.get('assist')).toBe('1')
    expect(url.searchParams.get('fresh')).toBe('1')
    expect(opened.url).not.toContain(testNumber(run, 1).slice(-7))

    const later = new Date(NOW.getTime() + 60_000)
    const copied = await scsIntakeLinkFor(rep.actor, leadId, 'copy', later)
    expect(copied.ok && new URL(copied.url!).searchParams.has('assist')).toBe(false)

    const row = await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId }, select: { intakeLinkSentAt: true } })
    expect(row.intakeLinkSentAt?.toISOString()).toBe(NOW.toISOString())
    const events = await db.callCenterEvent.findMany({ where: { leadId, type: 'INTAKE_LINK' }, orderBy: { createdAt: 'asc' } })
    expect(events.map((e) => JSON.parse(e.body).mode)).toEqual(['open', 'copy'])
    expect(JSON.parse(events[0].body).tokenId).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  it('refuses the text mode without consent, with mock SMS, and on do-not-call', async () => {
    expect(await scsIntakeLinkFor(rep.actor, leadId, 'text', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/No consent/) })
    await db.callCenterLead.update({ where: { id: leadId }, data: { consentAt: NOW, consentSource: 'manual' } })
    expect(await scsIntakeTextStatusFor(rep.actor, leadId, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/not switched on/) })
    expect(await scsIntakeLinkFor(rep.actor, leadId, 'text', NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/not switched on/) })
    await db.callCenterLead.update({ where: { id: leadId }, data: { doNotCallAt: NOW } })
    expect(await scsIntakeLinkFor(rep.actor, leadId, 'text', NOW)).toEqual({ ok: false, reason: 'Do not call' })
    await db.callCenterLead.update({ where: { id: leadId }, data: { doNotCallAt: null } })
    expect(await db.callCenterEvent.count({ where: { leadId, type: 'SMS' } })).toBe(0)
  })

  it('links the lead when the SCS packet carries a valid token, and records rep assistance', async () => {
    const token = signIntakeToken(leadId, NOW)
    const assisted = { by: 'Link Rep', at: '2026-10-12T18:05:00.000Z', mode: 'rep_filled' }
    const clientId = await ingest(source, packet(randomUUID(), token, { assisted }))

    const lead = await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId }, select: { clientId: true } })
    expect(lead.clientId).toBe(clientId)
    const linked = await db.callCenterEvent.findMany({ where: { leadId, type: 'INTAKE_LINK' } })
    const body = JSON.parse(linked[linked.length - 1].body)
    expect(body).toMatchObject({ action: 'linked', clientId, via: 'intake_token', assisted })
    const audit = await db.auditEvent.findFirst({ where: { organizationId: orgId, action: 'call_center.lead_linked', entityId: leadId } })
    expect(audit?.after).toMatchObject({ clientId, via: 'intake_token', assisted })
    const response = await db.surveyResponse.findFirst({ where: { clientId }, select: { answers: true } })
    expect((response?.answers as Record<string, unknown>)._scs_assisted).toEqual(assisted)

    // The button is spent once the lead has its Client.
    expect(await scsIntakeLinkFor(rep.actor, leadId, 'copy', NOW)).toEqual({ ok: false, reason: 'This lead already has its intake linked' })
  })

  it('keeps the first link when a second SCS case arrives with the same token', async () => {
    const first = (await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId }, select: { clientId: true } })).clientId
    const token = signIntakeToken(leadId, NOW)
    const second = await ingest(source, packet(randomUUID(), token))
    expect(second).not.toBe(first)
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId }, select: { clientId: true } })).clientId).toBe(first)
    expect(await db.auditEvent.count({ where: { organizationId: orgId, action: 'call_center.link_conflict', entityId: leadId } })).toBe(1)
  })

  it('still ingests the intake when the token is bad, expired or for another workspace', async () => {
    const bad = await ingest(source, packet(randomUUID(), 'v1.bm9wZQ.9999999999.forged'))
    const expired = await ingest(source, packet(randomUUID(), signIntakeToken(matchLeadId, new Date('2026-01-01T00:00:00Z'))))
    const foreign = await ingest(source, packet(randomUUID(), signIntakeToken(foreignLeadId, NOW)))
    const rejected = await db.auditEvent.findMany({
      where: { organizationId: orgId, action: 'call_center.link_rejected', entityId: { in: [bad, expired, foreign] } },
      select: { entityId: true, after: true },
    })
    const reasons = Object.fromEntries(rejected.map((r) => [r.entityId, (r.after as { reason: string }).reason]))
    expect(reasons).toEqual({ [bad]: 'bad_signature', [expired]: 'expired', [foreign]: 'no_lead' })
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: foreignLeadId }, select: { clientId: true } })).clientId).toBeNull()
    expect((await db.callCenterLead.findUniqueOrThrow({ where: { id: matchLeadId }, select: { clientId: true } })).clientId).toBeNull()
  })

  it('offers a possible match by phone, and only a manager may link it', async () => {
    const client = await db.client.create({
      data: {
        organizationId: orgId,
        pipelineId,
        currentStageId: stageId,
        firstName: 'Mo Junior',
        lastName: 'Match',
        email: '',
        phone: matchPhone,
      },
    })
    expect(await findPossibleMatch(rep.actor, matchLeadId, NOW)).toBeNull() // not their lead, can't link
    expect((await takeCallCenterLeadFor(orgId, rep.actor, matchLeadId, NOW)).ok).toBe(true)
    expect(await findPossibleMatch(rep.actor, matchLeadId, NOW)).toMatchObject({ clientId: client.id, firstName: 'Mo', canLink: false })
    expect(await findPossibleMatch(admin.actor, matchLeadId, NOW)).toMatchObject({ clientId: client.id, canLink: true })
    // Created more than 30 days before "now": no longer offered.
    expect(await findPossibleMatch(admin.actor, matchLeadId, new Date(Date.now() + 31 * 86_400_000))).toBeNull()

    expect((await linkLeadToClientFor(rep.actor, matchLeadId, client.id, NOW)).ok).toBe(false)
    expect(await linkLeadToClientFor(admin.actor, matchLeadId, client.id, NOW)).toEqual({ ok: true })
    expect(await linkLeadToClientFor(admin.actor, matchLeadId, client.id, NOW)).toEqual({ ok: true })
    const after = await db.callCenterLead.findUniqueOrThrow({ where: { id: matchLeadId }, select: { clientId: true } })
    expect(after.clientId).toBe(client.id)
    expect(await findPossibleMatch(admin.actor, matchLeadId, NOW)).toBeNull()
    expect(await db.auditEvent.findFirst({ where: { action: 'call_center.lead_linked', entityId: matchLeadId, actorId: admin.id } })).toBeTruthy()
    const otherClient = await ingest(source, packet(randomUUID(), null))
    expect(await linkLeadToClientFor(admin.actor, matchLeadId, otherClient, NOW)).toEqual({ ok: false, reason: 'This lead is already linked to another client.' })
  })
})
