import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IntakeSource, Organization, Pipeline, PipelineStage, Team } from '@prisma/client'
import { db } from '@/lib/db'
import { hashIntakeSecret, signRawBody, verifySignature } from '@/lib/intake/hmac'
import { deriveExternalId } from '@/lib/intake/external-id'
import { applyMapping, canonicalize, flattenKeys, missingRequiredFields } from '@/lib/intake/mapping'
import { MockSheetsProvider } from '@/lib/intake/sheets'
import { processInbound, reapplySubmission, runSheetSync } from '@/lib/intake/apply'
import { POST as webhookPost } from '@/app/api/intake/[slug]/route'

// ── Pure logic ───────────────────────────────────────────────

describe('intake hmac', () => {
  const secretHash = hashIntakeSecret('ik_test_secret')
  const body = '{"first_name":"Ada"}'

  it('accepts a correctly signed body', () => {
    expect(verifySignature(secretHash, body, signRawBody(secretHash, body))).toBe(true)
  })

  it('rejects a tampered body', () => {
    const sig = signRawBody(secretHash, body)
    expect(verifySignature(secretHash, '{"first_name":"Eve"}', sig)).toBe(false)
  })

  it('rejects a signature from the wrong secret', () => {
    const otherSig = signRawBody(hashIntakeSecret('ik_other'), body)
    expect(verifySignature(secretHash, body, otherSig)).toBe(false)
  })

  it('rejects a missing or malformed header and a missing stored hash', () => {
    expect(verifySignature(secretHash, body, null)).toBe(false)
    expect(verifySignature(secretHash, body, '')).toBe(false)
    expect(verifySignature(secretHash, body, 'sha256=nothex')).toBe(false)
    expect(verifySignature(null, body, signRawBody(secretHash, body))).toBe(false)
  })
})

describe('deriveExternalId', () => {
  it('prefers explicit ids in documented order', () => {
    expect(deriveExternalId({ event_id: 'ev1', id: 'x' })).toBe('ev1')
    expect(deriveExternalId({ submission_id: 'sub9' })).toBe('sub9')
    expect(deriveExternalId({ entry: { id: 42 } })).toBe('42')
    expect(deriveExternalId({ id: 'plain' })).toBe('plain')
  })

  it('hashes the canonicalised body when no id exists, independent of key order', () => {
    const a = deriveExternalId({ first: 'Ada', nested: { x: 1, y: 2 } })
    const b = deriveExternalId({ nested: { y: 2, x: 1 }, first: 'Ada' })
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(a).toBe(b)
    expect(deriveExternalId({ first: 'Eve' })).not.toBe(a)
  })
})

describe('canonicalize', () => {
  it('sorts keys recursively and preserves arrays', () => {
    expect(canonicalize({ b: 1, a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}],"b":1}')
  })
})

describe('applyMapping', () => {
  const payload = {
    first_name: 'Ada',
    contact: { email: 'ada@example.test', phone: '702-555-0100' },
    utm: { source: 'meta' },
    extra_field: 'hello',
    empty: '',
  }

  it('maps flat and dot-path keys and reports unmapped leaves', () => {
    const { mapped, unmappedKeys } = applyMapping(
      { firstName: 'first_name', email: 'contact.email', phone: 'contact.phone', utmSource: 'utm.source' },
      payload,
    )
    expect(mapped).toEqual({
      firstName: 'Ada',
      email: 'ada@example.test',
      phone: '702-555-0100',
      utmSource: 'meta',
    })
    expect(unmappedKeys.sort()).toEqual(['empty', 'extra_field'])
  })

  it('ignores unknown crm fields and missing incoming keys', () => {
    const { mapped, unmappedKeys } = applyMapping(
      { firstName: 'nope', bogusField: 'first_name' } as Record<string, string>,
      { first_name: 'Ada' },
    )
    expect(mapped).toEqual({})
    expect(unmappedKeys).toEqual(['first_name'])
  })

  it('flags missing required fields', () => {
    expect(missingRequiredFields({ firstName: 'Ada' })).toEqual(['lastName', 'email or phone'])
    expect(missingRequiredFields({ firstName: 'Ada', lastName: 'L', phone: '1' })).toEqual([])
  })

  it('flattens nested keys with dot-paths', () => {
    expect(flattenKeys({ a: { b: { c: 1 } }, d: 2 })).toEqual(['a.b.c', 'd'])
  })
})

describe('mock sheets provider', () => {
  it('is deterministic and honours fromRow', async () => {
    const provider = new MockSheetsProvider()
    const all = await provider.listRows('any-sheet', 'Leads', 1)
    const again = await provider.listRows('any-sheet', 'Leads', 1)
    expect(all).toEqual(again)
    expect(all.length).toBeGreaterThan(0)
    expect(all[0].rowNumber).toBe(2) // row 1 is the header
    const tail = await provider.listRows('any-sheet', 'Leads', all[all.length - 1].rowNumber)
    expect(tail).toHaveLength(1)
    const none = await provider.listRows('any-sheet', 'Leads', all[all.length - 1].rowNumber + 1)
    expect(none).toHaveLength(0)
  })
})

// ── DB-backed pipeline ───────────────────────────────────────

describe('intake apply pipeline (db)', () => {
  const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  let org: Organization
  let pipeline: Pipeline
  let stage: PipelineStage
  let inboundTeam: Team
  let webSource: IntakeSource
  let sheetSource: IntakeSource
  let scsSource: IntakeSource

  beforeAll(async () => {
    org = await db.organization.create({
      data: { name: `Intake Test Org ${suffix}`, slug: `intake-test-${suffix}` },
    })
    pipeline = await db.pipeline.create({
      data: { organizationId: org.id, name: 'Test pipeline', isDefault: true },
    })
    stage = await db.pipelineStage.create({
      data: { pipelineId: pipeline.id, key: 'NEW_LEAD', name: 'New lead', category: 'INTAKE', position: 0 },
    })
    inboundTeam = await db.team.create({
      data: { organizationId: org.id, name: 'SCS Inbound' },
    })
    webSource = await db.intakeSource.create({
      data: {
        organizationId: org.id,
        kind: 'WEB_FORM',
        name: 'Test web form',
        slug: `test-form-${suffix}`,
        secretHash: hashIntakeSecret('ik_test'),
        fieldMapping: { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone' },
        dedupeKeys: ['email', 'phone'],
        defaultTeamId: inboundTeam.id,
      },
    })
    sheetSource = await db.intakeSource.create({
      data: {
        organizationId: org.id,
        kind: 'GOOGLE_SHEET',
        name: 'Test sheet',
        slug: `test-sheet-${suffix}`,
        fieldMapping: { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone' },
        dedupeKeys: ['email', 'phone'],
        sheetId: 'mock-sheet-test',
        sheetTab: 'Leads',
      },
    })
    scsSource = await db.intakeSource.create({
      data: {
        organizationId: org.id,
        kind: 'WEB_FORM',
        name: 'Test SCS handoff',
        slug: 'scs-website',
        authMode: 'TOKEN',
        secretHash: hashIntakeSecret('scs-test-token'),
        fieldMapping: { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone' },
        dedupeKeys: ['email', 'phone'],
      },
    })
  })

  afterAll(async () => {
    await db.organization.delete({ where: { id: org.id } })
  })

  it('creates a client on first delivery and treats an exact replay as a no-op', async () => {
    const payload = {
      event_id: `evt-replay-${suffix}`,
      first_name: 'Nova',
      last_name: 'Trent',
      email: `nova.trent.${suffix}@example.test`,
      phone: '702-555-0142',
    }

    const first = await processInbound(webSource, payload.event_id, payload)
    expect(first.duplicate).toBe(false)
    expect(first.submission.status).toBe('APPLIED')
    expect(first.submission.createdClient).toBe(true)
    expect(first.submission.clientId).toBeTruthy()

    const replay = await processInbound(webSource, payload.event_id, payload)
    expect(replay.duplicate).toBe(true)
    expect(replay.submission.id).toBe(first.submission.id)
    expect(replay.submission.clientId).toBe(first.submission.clientId)
    expect(replay.submission.attemptCount).toBe(first.submission.attemptCount)

    const clients = await db.client.count({
      where: { organizationId: org.id, email: payload.email },
    })
    expect(clients).toBe(1)

    const submissions = await db.intakeSubmission.count({
      where: { sourceId: webSource.id, externalId: payload.event_id },
    })
    expect(submissions).toBe(1)

    // Exactly one create audit event: the replay never re-applied.
    const audits = await db.auditEvent.count({
      where: { organizationId: org.id, action: 'intake.client_created', entityId: first.submission.clientId },
    })
    expect(audits).toBe(1)

    // A created lead lands on the first stage with a stage-history row.
    const client = await db.client.findUniqueOrThrow({ where: { id: first.submission.clientId! } })
    expect(client.currentStageId).toBe(stage.id)
    expect(client.teamId).toBe(inboundTeam.id)
    const history = await db.stageHistory.count({ where: { clientId: client.id, toKey: 'NEW_LEAD' } })
    expect(history).toBe(1)
  })

  it('never stamps a team from another organization', async () => {
    const foreignOrg = await db.organization.create({
      data: { name: `Foreign Team Org ${suffix}`, slug: `foreign-team-${suffix}` },
    })
    try {
      const foreignTeam = await db.team.create({
        data: { organizationId: foreignOrg.id, name: 'Foreign queue' },
      })
      const source = await db.intakeSource.create({
        data: {
          organizationId: org.id,
          kind: 'WEB_FORM',
          name: 'Unsafe configured source',
          slug: `unsafe-team-${suffix}`,
          fieldMapping: { firstName: 'first_name', lastName: 'last_name', email: 'email' },
          defaultTeamId: foreignTeam.id,
        },
      })
      const { submission } = await processInbound(source, `evt-foreign-team-${suffix}`, {
        first_name: 'Rae',
        last_name: 'Safe',
        email: `rae.safe.${suffix}@example.test`,
      })
      const client = await db.client.findUniqueOrThrow({ where: { id: submission.clientId! } })
      expect(client.teamId).toBeNull()
    } finally {
      await db.organization.delete({ where: { id: foreignOrg.id } })
    }
  })

  it('matches an existing client instead of creating a second one, filling only blanks', async () => {
    const email = `dupe.match.${suffix}@example.test`
    const existing = await db.client.create({
      data: {
        organizationId: org.id,
        pipelineId: pipeline.id,
        currentStageId: stage.id,
        firstName: 'Dana',
        lastName: 'Prior',
        email,
        phone: '',
      },
    })

    const payload = {
      event_id: `evt-dupe-${suffix}`,
      first_name: 'Dana-Changed',
      last_name: 'Prior',
      email,
      phone: '702-555-0175',
    }
    const { submission } = await processInbound(webSource, payload.event_id, payload)
    expect(submission.status).toBe('DUPLICATE')
    expect(submission.matchedOn).toBe('email')
    expect(submission.clientId).toBe(existing.id)
    expect(submission.createdClient).toBe(false)

    const after = await db.client.findUniqueOrThrow({ where: { id: existing.id } })
    expect(after.firstName).toBe('Dana') // existing value never overwritten
    expect(after.phone).toBe('702-555-0175') // blank filled from inbound

    const count = await db.client.count({ where: { organizationId: org.id, email } })
    expect(count).toBe(1)
  })

  it('parks an unmappable payload as NEEDS_MAPPING and applies it after a mapping fix', async () => {
    const payload = {
      event_id: `evt-fix-${suffix}`,
      nombre: 'Iris',
      apellido: 'Camacho',
      correo: `iris.camacho.${suffix}@example.test`,
    }
    const { submission } = await processInbound(webSource, payload.event_id, payload)
    expect(submission.status).toBe('NEEDS_MAPPING')
    expect(submission.clientId).toBeNull()
    expect(submission.error).toContain('firstName')
    expect(submission.unmappedKeys).toEqual(expect.arrayContaining(['nombre', 'apellido', 'correo']))

    const fixed = await reapplySubmission(submission, webSource, {
      overrideMapping: { firstName: 'nombre', lastName: 'apellido', email: 'correo' },
    })
    expect(fixed.status).toBe('APPLIED')
    expect(fixed.attemptCount).toBe(2)
    expect(fixed.clientId).toBeTruthy()
    const client = await db.client.findUniqueOrThrow({ where: { id: fixed.clientId! } })
    expect(client.firstName).toBe('Iris')
  })

  it('handles the webhook route end to end: signed create, replay, bad signature, unknown slug', async () => {
    const secretHash = hashIntakeSecret('ik_test')
    const body = JSON.stringify({
      event_id: `evt-route-${suffix}`,
      first_name: 'Remy',
      last_name: 'Okada',
      email: `remy.okada.${suffix}@example.test`,
      phone: '702-555-0190',
    })
    const call = (slug: string, raw: string, signature?: string) =>
      webhookPost(
        new Request(`http://localhost/api/intake/${slug}`, {
          method: 'POST',
          body: raw,
          headers: signature ? { 'x-intake-signature': signature } : {},
        }) as never,
        { params: Promise.resolve({ slug }) },
      )

    const first = await call(webSource.slug, body, signRawBody(secretHash, body))
    expect(first.status).toBe(200)
    const firstJson = (await first.json()) as { duplicate: boolean; status: string; clientId: string }
    expect(firstJson.duplicate).toBe(false)
    expect(firstJson.status).toBe('APPLIED')
    expect(firstJson.clientId).toBeTruthy()

    const replay = await call(webSource.slug, body, signRawBody(secretHash, body))
    expect(replay.status).toBe(200)
    const replayJson = (await replay.json()) as { duplicate: boolean; clientId: string }
    expect(replayJson.duplicate).toBe(true)
    expect(replayJson.clientId).toBe(firstJson.clientId)
    expect(await db.client.count({ where: { organizationId: org.id, id: firstJson.clientId } })).toBe(1)

    const bad = await call(webSource.slug, body, signRawBody(hashIntakeSecret('wrong'), body))
    expect(bad.status).toBe(401)
    const missing = await call(webSource.slug, body)
    expect(missing.status).toBe(401)
    const unknown = await call(`no-such-slug-${suffix}`, body, signRawBody(secretHash, body))
    expect(unknown.status).toBe(404)
  })

  it('accepts a normal authenticated SCS receipt without a restoration admission and keeps one case binding', async () => {
    const leadId = '11111111-1111-4111-8111-111111111111'
    const packet = (deliveryId: string, email: string, eventType = 'lead.received') => JSON.stringify({
      id: deliveryId,
      lead_id: leadId,
      event_type: eventType,
      first_name: 'Mira',
      last_name: 'Testley',
      email,
      phone: '702-555-0191',
      data: {
        schema_version: 'schema_42.v1',
        stage1_answers: { first_name: 'Mira', last_name: 'Testley', email, phone: '702-555-0191', zip: '89101' },
        documents: { files: [] },
      },
    })
    const call = (body: string) => webhookPost(
      new Request('http://localhost/api/intake/scs-website', {
        method: 'POST', body, headers: { 'x-connector-token': 'scs-test-token' },
      }) as never,
      { params: Promise.resolve({ slug: scsSource.slug }) },
    )

    const first = await call(packet('delivery-a', `mira.${suffix}@example.test`))
    const firstJson = (await first.json()) as { clientId: string }
    const refreshed = await call(packet('delivery-b', `mira.updated.${suffix}@example.test`))
    const refreshedJson = (await refreshed.json()) as { clientId: string }

    expect(first.status).toBe(200)
    expect(refreshed.status).toBe(200)
    expect(refreshedJson.clientId).toBe(firstJson.clientId)
    expect(await db.intakeSubmission.count({ where: { sourceId: scsSource.id, externalId: `scs:${leadId}` } })).toBe(1)
    expect(await db.client.count({ where: { organizationId: org.id, id: firstJson.clientId } })).toBe(1)
  })

  it('syncs sheet rows through the same pipeline, advances the cursor, and re-syncs as a no-op', async () => {
    const first = await runSheetSync(sheetSource)
    expect(first.ok).toBe(true)
    expect(first.synced).toBeGreaterThan(0)
    expect(first.cursor).toBeGreaterThan(sheetSource.lastRowCursor)
    expect(first.applied + first.duplicates + first.needsMapping + first.failed).toBe(first.synced)

    const afterFirst = await db.intakeSource.findUniqueOrThrow({ where: { id: sheetSource.id } })
    expect(afterFirst.lastRowCursor).toBe(first.cursor)
    expect(afterFirst.lastSyncAt).not.toBeNull()
    expect(afterFirst.lastError).toBeNull()

    const clientsAfterFirst = await db.client.count({ where: { organizationId: org.id } })
    const submissionsAfterFirst = await db.intakeSubmission.count({ where: { sourceId: sheetSource.id } })
    expect(submissionsAfterFirst).toBe(first.synced)

    // Cursor is past every row: nothing new to pull.
    const second = await runSheetSync(afterFirst)
    expect(second.synced).toBe(0)
    expect(second.cursor).toBe(first.cursor)

    // Even with the cursor reset, row:<n> idempotency blocks duplicates.
    const reset = await db.intakeSource.update({ where: { id: sheetSource.id }, data: { lastRowCursor: 0 } })
    const third = await runSheetSync(reset)
    expect(third.alreadySeen).toBe(first.synced)
    expect(third.applied).toBe(0)
    expect(await db.client.count({ where: { organizationId: org.id } })).toBe(clientsAfterFirst)
    expect(await db.intakeSubmission.count({ where: { sourceId: sheetSource.id } })).toBe(submissionsAfterFirst)
    expect((await db.intakeSource.findUniqueOrThrow({ where: { id: sheetSource.id } })).lastRowCursor).toBe(first.cursor)
  })
})
