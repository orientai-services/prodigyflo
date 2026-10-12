import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { getFileStorage } from '@/lib/storage'
import { INTAKE_SURVEY_NAME } from '@/lib/org/bootstrap'
import { QUESTIONNAIRE_NAME, QUESTIONNAIRE_VERSION } from '@/lib/final-desk/questions'
import { makeOrg, makeUser, testNumber } from '../../../tests/fixtures/telephony'
import { GET as getDocument } from '@/app/api/bridge/sunoff/files/[handoffId]/[documentId]/route'
import { GET as getReview } from '@/app/api/bridge/sunoff/files/[handoffId]/packet-review/route'
import { POST as postStatus } from '@/app/api/bridge/sunoff/status/route'
import { FACT_KEYS, buildSunoffPayload } from './payload'
import {
  provisionSunoffUserFor,
  refreshSunoffHandoffFor,
  resendStaleHandoffs,
  startSunoffHandoffFor,
  sunoffHandoffStateFor,
  sunoffUserIdFor,
} from './handoff'
import { signBridgeRequest, verifyBridgeRequest } from './sign'

/**
 * CYS sign-up hand-off against the test DB and a mock SunOff (no live calls):
 * the golden payload, access rules, the signed request toward SunOff,
 * idempotent re-sends, the signed file pulls and the monotonic status hook.
 */

const run = `sohand-${Date.now().toString(36)}`
const KEY = 'test-only-pf-sunoff-bridge-key-0123456789abcdef'
const SUNOFF = 'https://sunoff.test'
const APPT = new Date('2030-03-05T17:00:00.000Z')

type Sent = { path: string; headers: Record<string, string>; body: Record<string, unknown> }

/** A SunOff stand-in: checks the signature like the real one and answers like pf_handoff.py should. */
function mockSunoff(answer: (body: Record<string, unknown>) => { status: number; json: unknown } | 'network' = () => ({
  status: 200,
  json: { ok: true, sunoff_lead_id: 4242, created: true, matched_by: 'new', status: 'standby', url: `${SUNOFF}/sso/pf?t=one-time`, expires_in: 600 },
})) {
  const sent: Sent[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const text = String(init?.body ?? '')
    const verdict = verifyBridgeRequest({ key: KEY, method: String(init?.method), path: url.pathname, body: text, ts: headers['x-pf-bridge-ts'], sig: headers['x-pf-bridge-sig'] })
    if (!verdict.ok) return Response.json({ ok: false, error: 'bad_signature', message: 'no' }, { status: 401 })
    const body = JSON.parse(text) as Record<string, unknown>
    sent.push({ path: url.pathname, headers, body })
    const out = answer(body)
    if (out === 'network') throw new TypeError('fetch failed')
    return Response.json(out.json, { status: out.status })
  }) as typeof fetch
  return { sent, fetchImpl }
}

function signedGet(path: string, key = KEY, at = new Date()) {
  const headers = signBridgeRequest({ key, method: 'GET', path, body: '', now: at })
  return new Request(`https://www.prodigyflo.ai${path}`, { method: 'GET', headers })
}

function signedPost(path: string, body: unknown, idem: string, at = new Date()) {
  const text = JSON.stringify(body)
  const headers = signBridgeRequest({ key: KEY, method: 'POST', path, body: text, now: at, idempotencyKey: idem })
  return new Request(`https://www.prodigyflo.ai${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: text })
}

describe('SunOff CYS hand-off', () => {
  let orgId = ''
  let clientId = ''
  let leadId = ''
  let bareLeadId = ''
  let contractDocId = ''
  let oldDocId = ''
  let strangerDocId = ''
  const clientPhone = testNumber(run, 1)
  const storedKeys: string[] = []
  let admin: Awaited<ReturnType<typeof makeUser>>
  let repA: Awaited<ReturnType<typeof makeUser>>
  let repB: Awaited<ReturnType<typeof makeUser>>

  beforeAll(async () => {
    vi.stubEnv('PF_SUNOFF_BRIDGE_KEY', KEY)
    vi.stubEnv('SUNOFF_BRIDGE_URL', SUNOFF)
    const org = await makeOrg(run, 'Handoff')
    orgId = org.orgId
    admin = await makeUser(orgId, run, 'Admin Handoff', 'SUPER_ADMIN')
    repA = await makeUser(orgId, run, 'Gatsby Rep', 'CLOSER')
    repB = await makeUser(orgId, run, 'Other Rep', 'CLOSER')

    const client = await db.client.create({
      data: {
        organizationId: orgId, pipelineId: org.pipelineId, currentStageId: org.intakeStageId,
        firstName: 'Mara', lastName: 'Example', email: `mara.${run}@example.test`, phone: clientPhone, preferredLanguage: 'es', ownerId: repB.id,
        addresses: { create: { line1: '123 Sun St', line2: 'Unit 4', city: 'Las Vegas', state: 'NV', postalCode: '89101' } },
        contracts: { create: { counterparty: 'GoodLeap', productType: 'loan', signedAt: new Date('2021-06-15T00:00:00.000Z') } },
        appointments: { create: { startsAt: APPT, endsAt: new Date(APPT.getTime() + 90 * 60_000), type: 'PRESENTATION', timezone: 'America/Los_Angeles' } },
      },
    })
    clientId = client.id
    const intakeSurvey = await db.survey.create({
      data: { organizationId: orgId, name: INTAKE_SURVEY_NAME, schema: [{ title: 'About you', fields: [{ key: 'installer_guess', label: 'Who installed it?' }, { key: 'consent_sms', label: 'OK to text', type: 'consent' }] }] },
    })
    await db.surveyResponse.create({
      data: {
        surveyId: intakeSurvey.id, clientId, status: 'COMPLETED',
        answers: { installer_guess: 'Sunrun Installs', consent_sms: true, pain_type: 'bill_higher', pain_narrative: 'They said my bill would be zero.', experience_flags: ['promised_offset', 'in_home_sale', 'payment_increase'] },
      },
    })
    const finalSurvey = await db.survey.create({ data: { organizationId: orgId, name: QUESTIONNAIRE_NAME, version: QUESTIONNAIRE_VERSION, schema: [] } })
    await db.surveyResponse.create({
      data: {
        surveyId: finalSurvey.id, clientId, status: 'IN_PROGRESS', currentStep: 4,
        answers: {
          _manual: { sole_owner: true, prop_type: true, pressure: true, promises: true, age: true, goal: true, oob: true, mo_pay: true, first_contact: true },
          sole_owner: 'Yes', prop_type: 'Single-family home', pressure: ['Limited-time offer', 'Told I had to sign immediately'],
          promises: ['"No cost solar" / "Free solar"'], age: '65+', goal: ['Cancel the contract entirely', 'Remove lien'], oob: 'No', mo_pay: '$199',
          first_contact: 'Door-to-door salesperson',
        },
      },
    })

    const storage = getFileStorage()
    const put = async (name: string) => {
      const { key } = await storage.put(Buffer.from(`%PDF-1.4 ${name} ${run}`), { fileName: name, mimeType: 'application/pdf', clientId })
      storedKeys.push(key)
      return key
    }
    const old = await db.clientDocument.create({
      data: { clientId, status: 'RECEIVED', fileName: 'loan-agreement-v1.pdf', storageKey: await put('v1'), mimeType: 'application/pdf', sizeBytes: 20, checksum: 'a'.repeat(64), label: 'Loan agreement', receivedAt: new Date('2026-09-01T00:00:00Z') },
    })
    oldDocId = old.id
    const contract = await db.clientDocument.create({
      data: {
        clientId, status: 'RECEIVED', fileName: 'GoodLeap loan agreement.pdf', storageKey: await put('v2'), mimeType: 'application/pdf', sizeBytes: 30,
        checksum: 'b'.repeat(64), label: 'Loan agreement', supersedesId: old.id, version: 2, receivedAt: new Date('2026-09-02T00:00:00Z'),
        extractions: {
          create: {
            status: 'COMPLETED', detectedTypeKey: 'finance_agreement',
            fields: {
              create: [
                { key: 'product_type', label: 'Product', value: 'loan', verification: 'VERIFIED' },
                { key: 'lender_name', label: 'Lender', value: 'GoodLeap', verification: 'VERIFIED' },
                { key: 'apr', label: 'APR', value: '3.99', verification: 'VERIFIED' },
                { key: 'monthly_payment', label: 'Monthly', value: '212.50', verification: 'VERIFIED' },
                { key: 'term_months', label: 'Term', value: '300', verification: 'UNVERIFIED' },
                { key: 'amount_financed', label: 'Amount', value: '48000', verification: 'UNVERIFIED' },
              ],
            },
          },
        },
      },
    })
    contractDocId = contract.id
    await db.clientDocument.create({
      data: { clientId, status: 'RECEIVED', fileName: 'NV Energy bill.pdf', storageKey: await put('bill'), mimeType: 'application/pdf', sizeBytes: 10, label: 'Utility bill', receivedAt: new Date('2026-09-03T00:00:00Z') },
    })
    await db.clientDocument.create({
      data: { clientId, status: 'RECEIVED', fileName: 'huge-scan.pdf', storageKey: await put('huge'), mimeType: 'application/pdf', sizeBytes: 26 * 1024 * 1024, label: 'Other', receivedAt: new Date('2026-09-04T00:00:00Z') },
    })
    await db.closerBrief.create({ data: { organizationId: orgId, clientId, requestedById: admin.id, content: { situation: 'Loan with a zero-bill promise.', approved: true } } })

    // A document of another client in the same org: never servable through this hand-off.
    const other = await db.client.create({
      data: { organizationId: orgId, pipelineId: org.pipelineId, currentStageId: org.intakeStageId, firstName: 'Nora', lastName: 'Other', email: `nora.${run}@example.test`, phone: testNumber(run, 2) },
    })
    strangerDocId = (await db.clientDocument.create({ data: { clientId: other.id, status: 'RECEIVED', fileName: 'x.pdf', storageKey: await put('x'), mimeType: 'application/pdf' } })).id

    const lead = await db.callCenterLead.create({
      data: {
        organizationId: orgId, source: 'FORM', language: 'ES', lockedBy: repA.id, clientId, phoneLast4: clientPhone.slice(-4),
        consentAt: new Date('2026-10-01T16:00:00.000Z'), consentSource: 'lead_form', consentTextVersion: 'pf-scs-2026-10-01',
        leadAttribution: { adId: 'ad-1', campaignId: 'camp-1', formId: 'form-1' }, createdAt: new Date('2026-10-01T15:59:00.000Z'),
      },
    })
    leadId = lead.id
    bareLeadId = (await db.callCenterLead.create({ data: { organizationId: orgId, source: 'FORM', language: 'EN', lockedBy: repA.id } })).id
  })

  afterAll(async () => {
    for (const key of storedKeys) await getFileStorage().delete(key).catch(() => undefined)
    if (orgId) await db.organization.delete({ where: { id: orgId } })
    vi.unstubAllEnvs()
  })

  it('builds the golden pf-handoff/v1 payload: every §B3.4 block, every FACTS key present or explicitly null', async () => {
    const built = await buildSunoffPayload({ organizationId: orgId, clientId, leadId, handoffId: 'HANDOFF', rep: { id: repA.id, name: 'Gatsby Rep', email: 'gatsby@example.test' } })
    expect(built).not.toBeNull()
    const p = built!.payload
    expect(Object.keys(p).sort()).toEqual(['appointment', 'attribution', 'consent', 'contact', 'dates', 'documents', 'facts', 'intake_verbatim', 'internal', 'issue', 'pf_client_id', 'pf_lead_id', 'purpose', 'questionnaire', 'rep', 'revision', 'story', 'version'].sort())
    expect(Object.keys(p.facts).sort()).toEqual([...FACT_KEYS].sort())
    for (const entry of Object.values(p.facts)) {
      expect(entry).toHaveProperty('v')
      expect(entry).toHaveProperty('src')
      if (entry.v === null) expect(entry.src).toBeNull()
      else expect(['pf', 'pf_verified']).toContain(entry.src)
    }
    expect(p.story.testimonial).toBeNull()

    // Ids and run-specific values become stable tokens; the rest is the golden file.
    const tokens: [string, string][] = [[orgId, '<org>'], [leadId, '<lead>'], [clientId, '<client>'], [repA.id, '<rep>'], [contractDocId, '<doc:contract>'], [oldDocId, '<doc:v1>'], [run, '<run>'], [clientPhone, '<phone>']]
    let text = JSON.stringify(p, null, 2)
    for (const [from, to] of tokens) text = text.split(from).join(to)
    text = text.replace(/"(c[a-z0-9]{20,30})"/g, '"<id>"').replace(/\/(c[a-z0-9]{20,30})"/g, '/<id>"').replace(/"revision": "[0-9a-f]{64}"/, '"revision": "<sha256>"')
      .replace(/"generated_at": "[^"]+"/, '"generated_at": "<generated>"')
    await expect(text).toMatchFileSnapshot('./__fixtures__/handoff-payload.golden.json')

    // The facts that matter for CYS, spelled out.
    expect(p.facts['finance.finance_company']).toEqual({ v: 'GoodLeap', src: 'pf_verified' })
    expect(p.facts['finance.apr']).toEqual({ v: 3.99, src: 'pf_verified' })
    expect(p.facts['finance.monthly']).toEqual({ v: 212.5, src: 'pf_verified' }) // the verified document beats the typed $199
    expect(p.facts['finance.contract_type']).toEqual({ v: 'loan', src: 'pf_verified' })
    expect(p.facts['issue.promised']).toEqual({ v: ['no_cost', 'free'], src: 'pf' })
    expect(p.facts['client.age_band']).toEqual({ v: '65_plus', src: 'pf' })
    expect(p.facts['system.installer_status']).toEqual({ v: 'active', src: 'pf' })
    expect(p.facts['sale.signed_year']).toEqual({ v: 2021, src: 'pf' })
    expect(p.issue.reasons).toEqual(['zero_bill_promise', 'high_pressure_tactics'])
    expect(p.issue.flags).toContain('payment_increase')
    expect(p.contact).toMatchObject({ first: 'Mara', last: 'Example', phone: clientPhone, language: 'es' })

    // Documents: the superseded v1 drops out, the 25 MB+ scan is listed but not offered, internal PDFs never get a CYS slot.
    const ids = p.documents.map((d) => d.id)
    expect(ids).not.toContain(oldDocId)
    expect(p.documents.find((d) => d.id === contractDocId)).toMatchObject({ category: 'finance_agreement', cys_slot: 'finance_agreement', sha256: 'b'.repeat(64) })
    expect(p.documents.find((d) => d.file_name === 'huge-scan.pdf')).toMatchObject({ url: null, skipped: 'over_25mb' })
    for (const d of p.documents.filter((x) => x.category === 'pf_internal')) expect(d.cys_slot).toBeNull()
    expect(built!.manifest.map((m) => m.id)).toEqual(expect.arrayContaining([contractDocId, 'packet-review', 'packet-pitch']))
    expect(built!.manifest.map((m) => m.id)).not.toContain(oldDocId)
    expect(p.internal.brief?.approved).toBe(true)

    // Same data, same revision.
    const again = await buildSunoffPayload({ organizationId: orgId, clientId, leadId, handoffId: 'HANDOFF', rep: { id: repA.id, name: 'Gatsby Rep', email: 'gatsby@example.test' } })
    expect(again!.revision).toBe(built!.revision)
  })

  it('refuses without the lock, without a linked client, and for another org', async () => {
    const sunoff = mockSunoff()
    expect(await startSunoffHandoffFor(repB.actor, leadId, { fetchImpl: sunoff.fetchImpl })).toEqual({ ok: false, reason: 'Take the lead first', code: 'NOT_ALLOWED' })
    expect(await startSunoffHandoffFor(repA.actor, bareLeadId, { fetchImpl: sunoff.fetchImpl })).toMatchObject({ ok: false, code: 'NO_CLIENT' })
    expect(await startSunoffHandoffFor({ ...repA.actor, organizationId: 'other-org' }, leadId, { fetchImpl: sunoff.fetchImpl })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' })
    expect(await sunoffHandoffStateFor(repA.actor, leadId)).toBeNull()
    expect(sunoff.sent).toHaveLength(0)
  })

  it('reports a SunOff outage as ERROR and NO_SUNOFF_USER with SunOff\'s message', async () => {
    const down = mockSunoff(() => 'network')
    expect(await startSunoffHandoffFor(repA.actor, leadId, { fetchImpl: down.fetchImpl })).toEqual({ ok: false, reason: "SunOff didn't answer · Retry", code: 'SUNOFF_DOWN' })
    expect((await sunoffHandoffStateFor(repA.actor, leadId))?.status).toBe('ERROR')
    const nouser = mockSunoff(() => ({ status: 422, json: { ok: false, error: 'no_sunoff_user', message: 'Ask the owner to link your SunOff account' } }))
    expect(await startSunoffHandoffFor(repA.actor, leadId, { fetchImpl: nouser.fetchImpl })).toEqual({ ok: false, reason: 'Ask the owner to link your SunOff account', code: 'NO_SUNOFF_USER' })
    const offsite = mockSunoff(() => ({ status: 200, json: { ok: true, sunoff_lead_id: 1, status: 'standby', url: 'https://evil.test/sso' } }))
    expect(await startSunoffHandoffFor(repA.actor, leadId, { fetchImpl: offsite.fetchImpl })).toMatchObject({ ok: false, code: 'SUNOFF_DOWN' })
  })

  it('sends a signed, idempotent hand-off and opens the one-time SunOff link', async () => {
    const sunoff = mockSunoff()
    const first = await startSunoffHandoffFor(repA.actor, leadId, { fetchImpl: sunoff.fetchImpl })
    expect(first).toEqual({ ok: true, url: `${SUNOFF}/sso/pf?t=one-time`, status: 'STANDBY', created: true })
    expect(sunoff.sent).toHaveLength(1)
    const req = sunoff.sent[0]
    expect(req.path).toBe('/api/internal/pf-handoff')
    expect(req.body).toMatchObject({ version: 'pf-handoff/v1', purpose: 'handoff', pf_lead_id: `pf:${orgId}:${leadId}`, pf_client_id: clientId })
    const row = await db.sunoffHandoff.findUniqueOrThrow({ where: { callCenterLeadId: leadId } })
    expect(req.headers['idempotency-key']).toBe(`${row.id}:${req.body.revision}:${row.attempts}`)
    expect(row).toMatchObject({ status: 'STANDBY', sunoffLeadId: 4242, revision: req.body.revision, lastError: null })
    expect(await db.auditEvent.count({ where: { organizationId: orgId, action: 'sunoff.handoff_sent', entityId: row.id } })).toBe(1)
    const audit = await db.auditEvent.findFirstOrThrow({ where: { organizationId: orgId, action: 'sunoff.handoff_sent' } })
    expect(JSON.stringify(audit)).not.toContain(clientPhone)
    expect(await db.callCenterEvent.count({ where: { leadId, type: 'HANDOFF' } })).toBeGreaterThan(0)

    // Unchanged: a second click only asks for a fresh link (purpose "open"), never a duplicate lead, and a new key.
    const second = await startSunoffHandoffFor(repA.actor, leadId, { fetchImpl: sunoff.fetchImpl })
    expect(second).toMatchObject({ ok: true, status: 'STANDBY' })
    expect(sunoff.sent[1].body).toMatchObject({ purpose: 'open', revision: req.body.revision })
    expect(sunoff.sent[1].body).not.toHaveProperty('facts')
    expect(sunoff.sent[1].headers['idempotency-key']).not.toBe(req.headers['idempotency-key'])
    expect(await db.sunoffHandoff.count({ where: { callCenterLeadId: leadId } })).toBe(1)
    expect(await db.auditEvent.count({ where: { organizationId: orgId, action: 'sunoff.handoff_sent' } })).toBe(1)

    // Super Admin may send without the lock.
    expect(await startSunoffHandoffFor(admin.actor, leadId, { fetchImpl: sunoff.fetchImpl })).toMatchObject({ ok: true })
    // "Re-send profile" always sends the whole payload.
    await refreshSunoffHandoffFor(repA.actor, leadId, { fetchImpl: sunoff.fetchImpl })
    expect(sunoff.sent.at(-1)!.body).toMatchObject({ purpose: 'handoff' })
  })

  it('marks the hand-off stale after the Client changes, and the cron re-sends it', async () => {
    expect(await sunoffHandoffStateFor(repA.actor, leadId)).toMatchObject({ status: 'STANDBY', sunoffLeadId: 4242, stale: false, lastError: null })
    await new Promise((r) => setTimeout(r, 20))
    await db.client.update({ where: { id: clientId }, data: { email: `mara.new.${run}@example.test` } })
    expect(await sunoffHandoffStateFor(repB.actor, leadId)).toMatchObject({ stale: true })
    const sunoff = mockSunoff()
    const totals = await resendStaleHandoffs({ fetchImpl: sunoff.fetchImpl })
    expect(totals.sent).toBeGreaterThanOrEqual(1)
    expect(sunoff.sent.find((s) => s.body.pf_client_id === clientId)?.body).toMatchObject({ purpose: 'handoff' })
    expect(await sunoffHandoffStateFor(repA.actor, leadId)).toMatchObject({ stale: false })
  })

  it('serves only manifest files on a signed GET', async () => {
    const row = await db.sunoffHandoff.findUniqueOrThrow({ where: { callCenterLeadId: leadId } })
    const path = (doc: string) => `/api/bridge/sunoff/files/${row.id}/${doc}`
    const ctx = (doc: string) => ({ params: Promise.resolve({ handoffId: row.id, documentId: doc }) }) as never

    const ok = await getDocument(signedGet(path(contractDocId)), ctx(contractDocId))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('application/pdf')
    expect(ok.headers.get('x-pf-sha256')).toBe('b'.repeat(64))
    expect(Buffer.from(await ok.arrayBuffer()).toString()).toContain('v2')
    expect(await db.auditEvent.count({ where: { organizationId: orgId, action: 'sunoff.file_served' } })).toBe(1)

    expect((await getDocument(new Request(`https://www.prodigyflo.ai${path(contractDocId)}`), ctx(contractDocId))).status).toBe(401)
    expect((await getDocument(signedGet(path(contractDocId), `${KEY}-wrong`), ctx(contractDocId))).status).toBe(401)
    expect((await getDocument(signedGet(path(contractDocId), KEY, new Date(Date.now() - 600_000)), ctx(contractDocId))).status).toBe(401)
    expect((await getDocument(signedGet(path(oldDocId)), ctx(oldDocId))).status).toBe(403)
    expect((await getDocument(signedGet(path(strangerDocId)), ctx(strangerDocId))).status).toBe(403)
    const missing = `/api/bridge/sunoff/files/nope/${contractDocId}`
    expect((await getDocument(signedGet(missing), { params: Promise.resolve({ handoffId: 'nope', documentId: contractDocId }) } as never)).status).toBe(404)

    const pdf = await getReview(signedGet(`/api/bridge/sunoff/files/${row.id}/packet-review`), { params: Promise.resolve({ handoffId: row.id }) } as never)
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
  })

  it('applies signed status hooks monotonically and refuses replays', async () => {
    const path = '/api/bridge/sunoff/status'
    const pf = `pf:${orgId}:${leadId}`
    const send = async (status: string, idem: string, extra: Record<string, unknown> = {}, signedAt = new Date()) => {
      const res = await postStatus(signedPost(path, { pf_lead_id: pf, sunoff_lead_id: 4242, status, at: '2026-10-12T19:00:00.000Z', ...extra }, idem, signedAt))
      return { http: res.status, body: (await res.json()) as Record<string, unknown> }
    }
    expect(await send('started', 'st-1')).toEqual({ http: 200, body: { ok: true, status: 'started', changed: true } })
    // SunOff's retry: same Idempotency-Key, freshly signed: an idempotent no-op.
    expect(await send('started', 'st-1', {}, new Date(Date.now() + 2000))).toEqual({ http: 200, body: { ok: true, status: 'started', changed: false } })
    // The identical signed request again: a replay.
    const once = signedPost(path, { pf_lead_id: pf, status: 'standby' }, 'st-1b')
    const twin = new Request(once.url, { method: 'POST', headers: once.headers, body: JSON.stringify({ pf_lead_id: pf, status: 'standby' }) })
    expect((await postStatus(once)).status).toBe(200)
    const replayed = await postStatus(twin)
    expect([replayed.status, ((await replayed.json()) as { error: string }).error]).toEqual([409, 'replay'])
    expect(await send('standby', 'st-2')).toEqual({ http: 200, body: { ok: true, status: 'started', changed: false } })
    expect(await send('submitted', 'st-3')).toEqual({ http: 200, body: { ok: true, status: 'submitted', changed: true } })
    expect(await send('started', 'st-4', {}, new Date(Date.now() + 3000))).toEqual({ http: 200, body: { ok: true, status: 'submitted', changed: false } })
    expect(await send('started', 'st-5', { sunoff_lead_id: 999 })).toMatchObject({ http: 409, body: { error: 'lead_mismatch' } })
    expect(await send('bogus', 'st-6')).toMatchObject({ http: 400 })
    const row = await db.sunoffHandoff.findUniqueOrThrow({ where: { callCenterLeadId: leadId } })
    expect(row.startedAt?.toISOString()).toBe('2026-10-12T19:00:00.000Z')
    expect(row.submittedAt).not.toBeNull()
    expect(await db.auditEvent.count({ where: { organizationId: orgId, action: 'sunoff.handoff_status' } })).toBe(2)

    // Unsigned, or a signed body changed in transit: refused before anything is read.
    const unsigned = await postStatus(new Request(`https://www.prodigyflo.ai${path}`, { method: 'POST', body: JSON.stringify({ pf_lead_id: pf, status: 'withdrawn' }) }))
    expect(unsigned.status).toBe(401)
    const good = signedPost(path, { pf_lead_id: pf, status: 'withdrawn' }, 'st-7')
    const tampered = new Request(good.url, { method: 'POST', headers: good.headers, body: JSON.stringify({ pf_lead_id: pf, status: 'standby' }) })
    expect((await postStatus(tampered)).status).toBe(401)

    // Withdrawn is the one move backwards, and files stop being served.
    expect(await send('withdrawn', 'st-8')).toEqual({ http: 200, body: { ok: true, status: 'withdrawn', changed: true } })
    const doc = await getDocument(signedGet(`/api/bridge/sunoff/files/${row.id}/${contractDocId}`), { params: Promise.resolve({ handoffId: row.id, documentId: contractDocId }) } as never)
    expect(doc.status).toBe(404)
    const pfTrail = await db.callCenterEvent.findMany({ where: { leadId, type: 'HANDOFF' }, orderBy: { createdAt: 'asc' } })
    expect(pfTrail.map((e) => JSON.parse(e.body).status)).toEqual(expect.arrayContaining(['STARTED', 'SUBMITTED', 'WITHDRAWN']))
    expect(pfTrail.map((e) => JSON.parse(e.body).detail)).toEqual(expect.arrayContaining(['In SunOff · Started', 'In SunOff · Submitted', 'Withdrawn in SunOff']))

    // A fresh send revives a withdrawn hand-off.
    const sunoff = mockSunoff()
    expect(await startSunoffHandoffFor(repA.actor, leadId, { fetchImpl: sunoff.fetchImpl })).toMatchObject({ ok: true, status: 'STANDBY' })
  })

  it('provisions the signed-in user in SunOff (decision D2)', async () => {
    const sunoff = mockSunoff(() => ({ status: 200, json: { ok: true, user_id: 77, created: true, invite_sent: true } }))
    const res = await provisionSunoffUserFor(repA.actor, { fetchImpl: sunoff.fetchImpl })
    expect(res).toMatchObject({ ok: true, created: true, email: repA.actor.email, sunoffUserId: 77 })
    const lookup = mockSunoff((body) => (body.create === false ? { status: 200, json: { ok: true, user_id: 77, created: false } } : { status: 500, json: {} }))
    expect(await sunoffUserIdFor(repA.actor, { fetchImpl: lookup.fetchImpl })).toBe(77)
    const none = mockSunoff(() => ({ status: 422, json: { ok: false, error: 'no_sunoff_user', message: 'Ask the owner to link your SunOff account' } }))
    expect(await sunoffUserIdFor(repA.actor, { fetchImpl: none.fetchImpl })).toBeNull()
    expect(sunoff.sent[0]).toMatchObject({ path: '/api/internal/pf-provision', body: { pf_user_id: repA.id, email: repA.actor.email, name: 'Gatsby Rep' } })
    const refused = mockSunoff(() => ({ status: 409, json: { ok: false, error: 'ambiguous_email', message: 'More than one SunOff account uses that email.' } }))
    expect(await provisionSunoffUserFor(repA.actor, { fetchImpl: refused.fetchImpl })).toEqual({ ok: false, reason: 'More than one SunOff account uses that email.', code: 'NOT_ALLOWED' })
  })
})
