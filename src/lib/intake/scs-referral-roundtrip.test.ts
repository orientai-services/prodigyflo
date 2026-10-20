import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { IntakeSource } from '@prisma/client'
import { db } from '@/lib/db'
import { POST as prefill } from '@/app/api/intake/scs/prefill/route'
import { contactSecrets } from '@/lib/call-center/contact'
import { signIntakeToken } from '@/lib/call-center/intake-link'
import { INTAKE_SURVEY_NAME } from '@/lib/org/bootstrap'
import { makeOrg, makeUser } from '../../../tests/fixtures/telephony'
import { processInbound } from './apply'
import { BoundClientUnavailableError, IntakeBindingConflictError } from './errors'
import { hashIntakeSecret } from './hmac'

const run = `scs-roundtrip-${Date.now()}`
const known = { first_name: 'Ada', last_name: 'Example', email: 'ada@example.test', phone: '+17025550123',
  property_street: '123 Example St', city: 'Las Vegas', state: 'NV', zip: '89117' }
const requestPrefill = (token: string) => prefill(new Request('https://pf.test/api/intake/scs/prefill', {
  method: 'POST', body: JSON.stringify({ token }),
}))
const packet = (caseId: string, token: string, answers: Record<string, unknown> = {}, files: unknown[] = []) => ({
  id: randomUUID(), lead_id: caseId, event_type: 'lead.received', ...known,
  data: { schema_version: 'schema_42.v1', attribution: { pfl: token },
    stage1_answers: { ...known, ...answers }, documents: { files } },
})

describe('SunOff referral → SCS → the same ProdigyFlo profile', () => {
  let org = '', otherOrg = '', rep = '', pipelineId = '', stageId = '', clientId = ''
  let otherPipelineId = '', otherStageId = ''
  let source: IntakeSource
  let leadId = '', token = ''
  const caseId = randomUUID()
  const receive = (body: ReturnType<typeof packet>) => processInbound(source, `scs:${body.lead_id}`, body)
  const newLead = async (data: { clientId?: string; organizationId?: string } = {}) => {
    const contact = contactSecrets({ phone: known.phone, email: known.email })
    return db.callCenterLead.create({ data: {
      organizationId: org, source: 'FORM', language: 'EN', pageId: 'sunoff', lockedBy: rep,
      phoneSecret: contact.phoneSecret!, emailSecret: contact.emailSecret!,
      leadAttribution: { sunoff: { id: randomUUID(), active: true, userId: '63', name: 'Ada Example',
        address: '123 Example St, Las Vegas, NV 89117' } }, ...data,
    } })
  }
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '::1'].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error('Local test DB required')
    vi.stubEnv('AUTH_SECRET', 'synthetic-scs-roundtrip-auth-secret')
    vi.stubEnv('VAULT_KEY', 'synthetic-scs-roundtrip-vault-key')
    const workspace = await makeOrg(run, 'Referral')
    org = workspace.orgId; pipelineId = workspace.pipelineId; stageId = workspace.fulfillmentStageId
    const foreign = await makeOrg(run, 'Foreign')
    otherOrg = foreign.orgId; otherPipelineId = foreign.pipelineId; otherStageId = foreign.intakeStageId
    rep = (await makeUser(org, run, 'Assigned Closer', 'CLOSER')).id
    await db.survey.create({ data: { organizationId: org, name: INTAKE_SURVEY_NAME, version: 1, schema: {} } })
    source = await db.intakeSource.create({ data: {
      organizationId: org, name: 'SCS', slug: 'scs-website', kind: 'WEB_FORM', authMode: 'TOKEN',
      secretHash: hashIntakeSecret(`synthetic-${run}`),
      fieldMapping: { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone' },
      dedupeKeys: ['email', 'phone'],
    } })
    leadId = (await newLead()).id; token = signIntakeToken(leadId)
  })
  afterAll(async () => {
    for (const id of [org, otherOrg]) if (id) await db.organization.delete({ where: { id } })
    vi.unstubAllEnvs()
  })

  it('opens with saved contact details without creating a second lead or client', async () => {
    const res = await requestPrefill(token)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ leadId, language: 'EN', values: {
      first_name: known.first_name, last_name: known.last_name, email: known.email, phone: known.phone,
      address_line1: known.property_street, city: known.city, state: known.state, zip: known.zip,
    } })
    expect(await db.callCenterLead.count({ where: { organizationId: org } })).toBe(1)
    expect(await db.client.count({ where: { organizationId: org } })).toBe(0)
  })

  it('attaches the completed intake to the original lead and keeps its assigned closer', async () => {
    const result = await receive(packet(caseId, token, { product_confirmed: 'ppa' }))
    clientId = result.submission.clientId!
    expect(result.submission.createdClient).toBe(true)
    expect(await db.callCenterLead.findUniqueOrThrow({ where: { id: leadId } })).toMatchObject({ clientId, lockedBy: rep })
    expect(await db.client.findUniqueOrThrow({ where: { id: clientId } })).toMatchObject({ ownerId: rep })
    expect(await db.callCenterLead.count({ where: { organizationId: org } })).toBe(1)
    expect(await db.client.count({ where: { organizationId: org } })).toBe(1)
  })

  it('updates answers and queues documents on that same profile, retaining pipeline progress', async () => {
    await db.client.update({ where: { id: clientId }, data: { currentStageId: stageId } })
    const files = [{ id: randomUUID(), doc_type: 'agreement', original_filename: 'example.pdf', mime: 'application/pdf', size_bytes: 12 }]
    const body = packet(caseId, token, { monthly_utility_bill: 180, product_confirmed: 'loan' }, files)
    const first = await receive(body), retry = await receive(body)
    expect(first.submission.clientId).toBe(clientId)
    expect(retry.submission.clientId).toBe(clientId)
    expect(retry.duplicate).toBe(true)
    const answers = await db.surveyResponse.findFirstOrThrow({ where: { clientId } })
    expect(answers.answers).toMatchObject({ monthly_utility_bill: 180, product_confirmed: 'loan' })
    expect(await db.surveyResponse.count({ where: { clientId } })).toBe(1)
    expect(await db.externalDocumentImport.findMany({ where: { clientId } })).toMatchObject([{ sourceDocumentId: files[0].id, sourceLeadId: caseId }])
    expect(await db.client.findUniqueOrThrow({ where: { id: clientId } })).toMatchObject({ currentStageId: stageId, ownerId: rep })
    expect(await db.client.count({ where: { organizationId: org } })).toBe(1)
  })

  it('reuses the linked profile from a new SCS session and serves current saved contact details', async () => {
    await db.client.update({ where: { id: clientId }, data: { email: 'ada.updated@example.test' } })
    const res = await requestPrefill(signIntakeToken(leadId))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ values: { email: 'ada.updated@example.test', address_line1: known.property_street } })
    const result = await receive(packet(randomUUID(), signIntakeToken(leadId), { credit_band: '740_plus' }))
    expect(result.submission).toMatchObject({ clientId, createdClient: false, status: 'DUPLICATE' })
    expect(await db.client.count({ where: { organizationId: org } })).toBe(1)
    expect((await db.surveyResponse.findFirstOrThrow({ where: { clientId } })).answers).toMatchObject({ credit_band: '740_plus' })
  })

  it('serializes simultaneous first completions for one referral', async () => {
    const lead = await newLead(), signed = signIntakeToken(lead.id)
    const count = await db.client.count({ where: { organizationId: org } })
    const results = await Promise.all([receive(packet(randomUUID(), signed)), receive(packet(randomUUID(), signed))])
    expect(results[0].submission.clientId).toBe(results[1].submission.clientId)
    expect(await db.client.count({ where: { organizationId: org } })).toBe(count + 1)
  })

  it('refuses conflicting exact bindings and rolls back the entire update', async () => {
    const second = await db.client.create({ data: {
      organizationId: org, pipelineId, currentStageId: stageId, firstName: 'Other', lastName: 'Home', email: '', phone: '',
    } })
    const different = await newLead({ clientId: second.id })
    const before = await db.intakeSubmission.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId: source.id, externalId: `scs:${caseId}` } } })
    const count = await db.client.count({ where: { organizationId: org } })
    await expect(receive(packet(caseId, signIntakeToken(different.id), { product_confirmed: 'cash' }))).rejects.toBeInstanceOf(IntakeBindingConflictError)
    expect(await db.intakeSubmission.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before)
    expect(await db.client.count({ where: { organizationId: org } })).toBe(count)
    expect((await db.surveyResponse.findFirstOrThrow({ where: { clientId } })).answers).toMatchObject({ product_confirmed: 'loan' })
  })

  it('never replaces a deleted or foreign linked client with a new profile', async () => {
    const deleted = await db.client.create({ data: {
      organizationId: org, pipelineId, currentStageId: stageId, firstName: 'Deleted', lastName: 'Home', email: '', phone: '', deletedAt: new Date(),
    } })
    const missing = await newLead({ clientId: deleted.id })
    const count = await db.client.count({ where: { organizationId: org } })
    await expect(receive(packet(randomUUID(), signIntakeToken(missing.id)))).rejects.toBeInstanceOf(BoundClientUnavailableError)
    expect((await requestPrefill(signIntakeToken(missing.id))).status).toBe(404)
    // Even a bad historical client pointer must not expose or update another workspace.
    const foreign = await db.client.create({ data: {
      organizationId: otherOrg, pipelineId: otherPipelineId, currentStageId: otherStageId,
      firstName: 'Foreign', lastName: 'Home', email: 'foreign@example.test', phone: '',
    } })
    await db.callCenterLead.update({ where: { id: missing.id }, data: { clientId: foreign.id } })
    await expect(receive(packet(randomUUID(), signIntakeToken(missing.id)))).rejects.toBeInstanceOf(BoundClientUnavailableError)
    expect((await requestPrefill(signIntakeToken(missing.id))).status).toBe(404)
    expect(await db.client.count({ where: { organizationId: org } })).toBe(count)
    expect((await db.client.findUniqueOrThrow({ where: { id: foreign.id } })).email).toBe('foreign@example.test')
  })
})
