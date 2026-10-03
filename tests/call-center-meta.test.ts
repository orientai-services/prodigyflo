import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { ingestCallCenterMetaLead, recordMetaWebhookLead } from '@/lib/call-center/meta-ingest'
import { SCS_ENGLISH_FORM_ID, SCS_ENGLISH_PAGE_ID } from '@/lib/call-center/meta-route'
import type { MetaLead } from '@/lib/meta/provider'

const run = `ccmeta-${Date.now().toString(36)}`

function lead(leadgenId: string, phone: string): MetaLead {
  return {
    leadgenId,
    createdTime: '2026-10-03T18:00:00.000Z',
    fields: {
      full_name: 'Pat Example',
      email: 'secret-person@example.test',
      phone_number: phone,
      zip_code: '89117',
    },
  }
}

describe('English Page Facebook leads', () => {
  let orgId: string

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: `Org ${run}`, slug: run } })
    orgId = org.id
    const pipeline = await db.pipeline.create({ data: { organizationId: orgId, name: 'P', isDefault: true } })
    await db.pipelineStage.create({
      data: { pipelineId: pipeline.id, key: 'NEW_LEAD', name: 'New', category: 'INTAKE', position: 0 },
    })
  })

  afterAll(async () => {
    await db.organization.delete({ where: { id: orgId } })
  })

  it('writes one Call Center lead and does not create a Client', async () => {
    const first = await recordMetaWebhookLead({
      organizationId: orgId,
      lead: lead(`${run}-en`, '+1 (702) 555-0199'),
      pageId: SCS_ENGLISH_PAGE_ID,
      formId: 'not-the-form',
    })
    expect(first.createdClient).toBe(false)
    expect(first.clientId).toBeNull()
    expect(first.duplicate).toBe(false)
    expect(first.status).toBe('CALL_CENTER')

    const replay = await recordMetaWebhookLead({
      organizationId: orgId,
      lead: lead(`${run}-en`, '+1 (702) 555-0199'),
      pageId: SCS_ENGLISH_PAGE_ID,
      formId: SCS_ENGLISH_FORM_ID,
    })
    expect(replay.duplicate).toBe(true)
    expect(replay.createdClient).toBe(false)

    const leads = await db.callCenterLead.findMany({
      where: { organizationId: orgId },
      include: { events: true },
    })
    expect(leads).toHaveLength(1)
    expect(leads[0].phoneLast4).toBe('0199')
    expect(leads[0].clientId).toBeNull()
    expect(leads[0].pageId).toBe(SCS_ENGLISH_PAGE_ID)
    expect(leads[0].events).toHaveLength(1)
    expect(leads[0].events[0].type).toBe('FORM')
    expect(leads[0].events[0].body).toContain('Facebook form')
    const blob = JSON.stringify(leads)
    expect(blob).not.toContain('7025550199')
    expect(blob).not.toContain('555-0199')
    expect(blob).not.toContain('secret-person@example.test')
    expect(await db.client.count({ where: { organizationId: orgId } })).toBe(0)
    expect(await db.intakeSubmission.count({ where: { organizationId: orgId } })).toBe(0)
  })

  it('routes the English form id even when the page id is different', async () => {
    const saved = await recordMetaWebhookLead({
      organizationId: orgId,
      lead: lead(`${run}-form`, '7025554419'),
      pageId: '999000111',
      formId: SCS_ENGLISH_FORM_ID,
    })
    expect(saved.createdClient).toBe(false)
    const row = await db.callCenterLead.findUniqueOrThrow({
      where: { id: `meta:${orgId}:${run}-form` },
    })
    expect(row.pageId).toBe('999000111')
    expect(row.phoneLast4).toBe('4419')
    expect(await db.client.count({ where: { organizationId: orgId } })).toBe(0)
  })

  it('still creates one Client for a different page', async () => {
    const saved = await recordMetaWebhookLead({
      organizationId: orgId,
      lead: lead(`${run}-other`, '+17025550000'),
      pageId: '111222333',
      formId: '444555666',
    })
    expect(saved.createdClient).toBe(true)
    expect(saved.clientId).toBeTruthy()
    expect(await db.client.count({ where: { organizationId: orgId } })).toBe(1)
    expect(await db.callCenterLead.count({ where: { organizationId: orgId } })).toBe(2)
  })

  it('keeps a single row when the same leadgen id arrives twice at once', async () => {
    const incoming = lead(`${run}-race`, '+17025551212')
    const [a, b] = await Promise.all([
      ingestCallCenterMetaLead({ organizationId: orgId, lead: incoming, pageId: SCS_ENGLISH_PAGE_ID }),
      ingestCallCenterMetaLead({ organizationId: orgId, lead: incoming, pageId: SCS_ENGLISH_PAGE_ID }),
    ])
    expect([a.duplicate, b.duplicate].filter(Boolean)).toHaveLength(1)
    const rows = await db.callCenterLead.findMany({
      where: { id: `meta:${orgId}:${run}-race` },
      include: { events: true },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].events).toHaveLength(1)
    expect(rows[0].phoneLast4).toBe('1212')
  })
})
