import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { ForbiddenError, type SessionUser } from '@/lib/rbac'
import type { PermissionKey } from '@/lib/permissions'
import { MockAIProvider } from '@/lib/ai/mock-provider'
import type { AssistContext } from '@/lib/ai/provider'
import { computeFieldConflicts, reviewAssist, runAssist, runDraftAssist, type SourcedValue } from '@/lib/ai/assists'

// ─── Fixtures (pure) ─────────────────────────────────────────────────────────

function fixtureContext(overrides: Partial<AssistContext> = {}): AssistContext {
  return {
    client: {
      id: 'c1',
      firstName: 'Ana',
      lastName: 'Serrano',
      email: 'ana@example.com',
      phone: '+17025550111',
      preferredLanguage: 'en',
      preferredContact: 'phone',
      stageName: 'Presentation',
      city: 'Las Vegas',
      state: 'NV',
      estimatedValue: 4000,
      ownerName: 'Rex Owner',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastActivityAt: '2026-08-01T00:00:00.000Z',
    },
    contracts: [
      {
        counterparty: 'SunBeam Solar',
        productType: 'PPA',
        monthlyAmount: 185,
        termMonths: 300,
        escalatorPct: 2.9,
        signedAt: '2024-05-01T00:00:00.000Z',
      },
    ],
    documents: [
      { name: 'Solar contract', status: 'APPROVED', required: true, isAttorneyRequired: false },
      { name: 'Utility bill', status: 'REQUESTED', required: true, isAttorneyRequired: false },
    ],
    creditSummary: { status: 'COMPLETED', scoreBand: 'GOOD', monthlyObligations: 900, derogatoryMarks: 0 },
    consents: [
      { type: 'ELECTRONIC_COMMUNICATION', granted: true },
      { type: 'SOFT_CREDIT_PULL', granted: false },
    ],
    surveyComplete: false,
    survey: { monthlyAmount: 250 },
    engagement: {
      communicationsCount: 4,
      lastInboundAt: '2026-07-30T00:00:00.000Z',
      lastOutboundAt: '2026-07-31T00:00:00.000Z',
      openTasks: 1,
      notes: 2,
    },
    verifiedFields: [],
    intakeValues: [],
    fieldConflicts: [
      {
        field: 'email',
        a: { source: 'client record', value: 'ana@example.com' },
        b: { source: 'intake (Web form)', value: 'ana.serrano@example.com' },
      },
    ],
    ...overrides,
  }
}

describe('mock provider determinism', () => {
  const provider = new MockAIProvider()

  it('summarizeLead returns identical output for identical input', async () => {
    const [a, b] = [await provider.summarizeLead(fixtureContext()), await provider.summarizeLead(fixtureContext())]
    expect(a).toEqual(b)
    expect(a.summary).toContain('Ana Serrano')
    expect(a.confidence).toBeGreaterThanOrEqual(40)
    expect(a.confidence).toBeLessThanOrEqual(95)
    expect(a.facts.every((f) => f.source.length > 0)).toBe(true)
  })

  it('suggestNextActions is deterministic and grounded in the gaps', async () => {
    const [a, b] = [
      await provider.suggestNextActions(fixtureContext()),
      await provider.suggestNextActions(fixtureContext()),
    ]
    expect(a).toEqual(b)
    expect(a.actions.length).toBeGreaterThan(0)
    expect(a.actions.length).toBeLessThanOrEqual(4)
    // The fixture has a field conflict and an unfinished survey — both surface.
    expect(a.actions.some((x) => x.title.toLowerCase().includes('mismatch'))).toBe(true)
    expect(a.actions.some((x) => x.title.toLowerCase().includes('survey'))).toBe(true)
  })

  it('findDiscrepancies only reports supplied conflicts, with severities', async () => {
    const r = await provider.findDiscrepancies(fixtureContext())
    expect(r.discrepancies).toHaveLength(1)
    expect(r.discrepancies[0].field).toBe('email')
    expect(r.discrepancies[0].severity).toBe('high')
    const none = await provider.findDiscrepancies(fixtureContext({ fieldConflicts: [] }))
    expect(none.discrepancies).toEqual([])
  })

  it('assessQualification returns signals plus a non-decision caveat', async () => {
    const [a, b] = [
      await provider.assessQualification(fixtureContext()),
      await provider.assessQualification(fixtureContext()),
    ]
    expect(a).toEqual(b)
    expect(a.signals.length).toBeGreaterThanOrEqual(4)
    expect(a.caveat.toLowerCase()).toContain('not a qualification decision')
    // Ungranted soft-pull consent must read negative.
    const consent = a.signals.find((s) => s.label === 'Credit-pull consent')
    expect(consent?.direction).toBe('negative')
  })

  it('draftMessage respects channel and language deterministically', async () => {
    const email = await provider.draftMessage(fixtureContext(), 'EMAIL', 'follow_up')
    expect(email.subject).toBeTruthy()
    expect(email.body).toContain('Ana')
    const sms = await provider.draftMessage(fixtureContext(), 'SMS', 'follow_up')
    expect(sms.subject).toBeUndefined()
    const es = await provider.draftMessage(
      fixtureContext({ client: { ...fixtureContext().client, preferredLanguage: 'es' } }),
      'EMAIL',
      'follow_up',
    )
    expect(es.body).toContain('Hola Ana')
    expect(await provider.draftMessage(fixtureContext(), 'EMAIL', 'follow_up')).toEqual(email)
  })

  it('summarizeDocument is deterministic and states only text stats', async () => {
    const text = 'Solar agreement between Ana Serrano and SunBeam. Monthly payment is $185. Term is 300 months.'
    const [a, b] = [await provider.summarizeDocument(text, 'solar_contract'), await provider.summarizeDocument(text, 'solar_contract')]
    expect(a).toEqual(b)
    expect(a.keyPoints.some((k) => k.includes('185'))).toBe(true)
    expect((await provider.summarizeDocument('', 'other')).summary).toContain('no readable text')
  })
})

// ─── Rule-based diffing ──────────────────────────────────────────────────────

describe('computeFieldConflicts', () => {
  it('flags a real email mismatch across sources', () => {
    const conflicts = computeFieldConflicts([
      { field: 'email', source: 'client record', value: 'ana@example.com' },
      { field: 'email', source: 'intake (Web form)', value: 'ana.serrano@example.com' },
    ])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].a.source).toBe('client record')
    expect(conflicts[0].b.source).toBe('intake (Web form)')
  })

  it('ignores formatting-only differences (phone punctuation, email case, money format)', () => {
    const conflicts = computeFieldConflicts([
      { field: 'phone', source: 'client record', value: '+1 (702) 555-0111' },
      { field: 'phone', source: 'intake (Web form)', value: '7025550111' },
      { field: 'email', source: 'client record', value: 'Ana@Example.com' },
      { field: 'email', source: 'intake (Web form)', value: 'ana@example.com ' },
      { field: 'monthly payment', source: 'contract on file', value: '185' },
      { field: 'monthly payment', source: 'intake survey', value: '$185.00' },
    ])
    expect(conflicts).toEqual([])
  })

  it('flags value disagreements per field and skips blanks', () => {
    const values: SourcedValue[] = [
      { field: 'monthly payment', source: 'contract on file', value: '185' },
      { field: 'monthly payment', source: 'intake survey', value: '250' },
      { field: 'name', source: 'client record', value: 'Ana Serrano' },
      { field: 'name', source: 'verified document (Government ID)', value: 'Ana  serrano' },
      { field: 'address', source: 'client record', value: '' },
    ]
    const conflicts = computeFieldConflicts(values)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].field).toBe('monthly payment')
  })
})

// ─── Run + review (DB-backed, throwaway org) ─────────────────────────────────

const stamp = `aitest-${Date.now()}`
let orgId: string
let roleId: string
let reviewerId: string
let ownerId: string
let clientId: string

function sessionUser(permissions: PermissionKey[], id?: string): SessionUser {
  return {
    id: id ?? ownerId,
    name: 'Test Reviewer',
    email: `${stamp}@example.com`,
    organizationId: orgId,
    organizationName: 'AI Test Org',
    roleId,
    isOwner: false,
    role: 'CLOSER',
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

const FULL: PermissionKey[] = ['ai:run', 'ai:review', 'clients:read_all']

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: 'AI Test Org', slug: stamp } })
  orgId = org.id
  const role = await db.role.create({ data: { organizationId: orgId, key: 'CLOSER', name: 'Admin' } })
  roleId = role.id
  const reviewer = await db.user.create({
    data: { organizationId: orgId, roleId, email: `${stamp}@example.com`, passwordHash: 'x', name: 'Test Reviewer' },
  })
  reviewerId = reviewer.id
  const owner = await db.user.create({
    data: { organizationId: orgId, roleId, email: `owner.${stamp}@example.com`, passwordHash: 'x', name: 'Lead Owner' },
  })
  ownerId = owner.id

  const pipeline = await db.pipeline.create({ data: { organizationId: orgId, name: 'AI test pipeline' } })
  const stage = await db.pipelineStage.create({
    data: { pipelineId: pipeline.id, key: 'NEW_LEAD', name: 'New lead', category: 'INTAKE', position: 0 },
  })

  const client = await db.client.create({
    data: {
      organizationId: orgId,
      pipelineId: pipeline.id,
      currentStageId: stage.id,
      ownerId,
      firstName: 'Ana',
      lastName: 'Serrano',
      email: `ana.${stamp}@example.com`,
      phone: '+17025550111',
      consents: {
        create: [
          {
            type: 'ELECTRONIC_COMMUNICATION',
            granted: true,
            textVersion: 'v1',
            text: 'Test consent',
            purpose: 'testing',
          },
        ],
      },
      contracts: { create: [{ counterparty: 'SunBeam Solar', productType: 'PPA', monthlyAmount: 185, termMonths: 300 }] },
    },
  })
  clientId = client.id

  // An intake submission whose email disagrees with the client record, so the
  // discrepancy assist has something real to find.
  const source = await db.intakeSource.create({
    data: { organizationId: orgId, kind: 'WEB_FORM', name: 'Web form', slug: `${stamp}-form` },
  })
  await db.intakeSubmission.create({
    data: {
      organizationId: orgId,
      sourceId: source.id,
      externalId: `${stamp}-1`,
      clientId,
      mappedPayload: { firstName: 'Ana', lastName: 'Serrano', email: `ana.other.${stamp}@example.com` },
    },
  })
})

afterAll(async () => {
  await db.organization.delete({ where: { id: orgId } }).catch(() => {})
})

describe('runAssist', () => {
  it('requires the ai:run permission', async () => {
    await expect(runAssist(sessionUser(['ai:review', 'clients:read_all']), { clientId, kind: 'summary' })).rejects.toThrow(
      ForbiddenError,
    )
  })

  it('refuses clients outside the caller scope', async () => {
    const result = await runAssist(sessionUser(['ai:run'], reviewerId), { clientId, kind: 'summary' })
    expect(result.ok).toBe(false)
  })

  it('persists a PENDING_REVIEW recommendation with provider and kind', async () => {
    const result = await runAssist(sessionUser(FULL), { clientId, kind: 'summary' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.item.status).toBe('PENDING_REVIEW')
    expect(result.item.kind).toBe('summary')
    expect(result.item.provider).toBe('mock')

    const row = await db.aIRecommendation.findUniqueOrThrow({ where: { id: result.item.id } })
    expect(row.type).toBe('ONBOARDING_ANALYSIS')
    expect(row.status).toBe('PENDING_REVIEW')
    expect(row.provider).toBe('mock')
    expect(row.reviewedById).toBeNull()
  })

  it('grounds the discrepancy assist in real cross-source data', async () => {
    const result = await runAssist(sessionUser(FULL), { clientId, kind: 'discrepancies' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.item.discrepancies.length).toBeGreaterThanOrEqual(1)
    expect(result.item.discrepancies.some((d) => d.field === 'email')).toBe(true)
  })
})

describe('reviewAssist', () => {
  it('requires the ai:review permission', async () => {
    const run = await runAssist(sessionUser(FULL), { clientId, kind: 'summary' })
    if (!run.ok) throw new Error('run failed')
    await expect(
      reviewAssist(sessionUser(['ai:run', 'clients:read_all']), { recommendationId: run.item.id, decision: 'accept' }),
    ).rejects.toThrow(ForbiddenError)
  })

  it('accepting next actions creates the tasks exactly once, assigned to the client owner', async () => {
    const run = await runAssist(sessionUser(FULL), { clientId, kind: 'next_actions' })
    if (!run.ok) throw new Error('run failed')
    const suggested = run.item.actions.length
    expect(suggested).toBeGreaterThan(0)

    const before = await db.task.count({ where: { clientId } })
    const review = await reviewAssist(sessionUser(FULL), { recommendationId: run.item.id, decision: 'accept' })
    expect(review).toMatchObject({ ok: true, effect: 'tasks_created', count: suggested })

    const after = await db.task.count({ where: { clientId } })
    expect(after - before).toBe(suggested)

    const tasks = await db.task.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' }, take: suggested })
    expect(tasks.every((t) => t.assigneeId === ownerId)).toBe(true)
    expect(tasks.every((t) => t.createdById === ownerId)).toBe(true)

    const row = await db.aIRecommendation.findUniqueOrThrow({ where: { id: run.item.id } })
    expect(row.status).toBe('ACCEPTED')
    expect(row.reviewedById).toBe(ownerId)
    expect(row.reviewedAt).not.toBeNull()

    // A second accept is refused and creates nothing further.
    const again = await reviewAssist(sessionUser(FULL), { recommendationId: run.item.id, decision: 'accept' })
    expect(again.ok).toBe(false)
    expect(await db.task.count({ where: { clientId } })).toBe(after)
  })

  it('accepting a summary pins it as an internal note', async () => {
    const run = await runAssist(sessionUser(FULL), { clientId, kind: 'summary' })
    if (!run.ok) throw new Error('run failed')
    const review = await reviewAssist(sessionUser(FULL), { recommendationId: run.item.id, decision: 'accept' })
    expect(review).toMatchObject({ ok: true, effect: 'note_pinned' })

    const note = await db.note.findFirst({ where: { clientId }, orderBy: { createdAt: 'desc' } })
    expect(note?.isInternal).toBe(true)
    expect(note?.pinned).toBe(true)
    expect(note?.body).toContain('Ana Serrano')
  })

  it('dismissing leaves no side effects', async () => {
    const run = await runAssist(sessionUser(FULL), { clientId, kind: 'discrepancies' })
    if (!run.ok) throw new Error('run failed')

    const tasksBefore = await db.task.count({ where: { clientId } })
    const notesBefore = await db.note.count({ where: { clientId } })

    const review = await reviewAssist(sessionUser(FULL), { recommendationId: run.item.id, decision: 'dismiss' })
    expect(review).toMatchObject({ ok: true, effect: 'recorded', count: 0 })

    expect(await db.task.count({ where: { clientId } })).toBe(tasksBefore)
    expect(await db.note.count({ where: { clientId } })).toBe(notesBefore)

    const row = await db.aIRecommendation.findUniqueOrThrow({ where: { id: run.item.id } })
    expect(row.status).toBe('DISMISSED')
    expect(row.reviewedById).toBe(ownerId)
  })
})

describe('runDraftAssist', () => {
  it('returns a reviewable draft and records it as PENDING_REVIEW', async () => {
    const result = await runDraftAssist(sessionUser(FULL), { clientId, channel: 'EMAIL', intent: 'follow_up' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mock).toBe(true)
    expect(result.draft.body).toContain('Ana')
    expect(result.draft.subject).toBeTruthy()

    const row = await db.aIRecommendation.findUniqueOrThrow({ where: { id: result.recommendationId } })
    expect(row.type).toBe('FOLLOW_UP_DRAFT')
    expect(row.status).toBe('PENDING_REVIEW')
    // Drafts never touch communications: nothing was sent.
    expect(await db.communication.count({ where: { clientId } })).toBe(0)
  })

  it('requires ai:run', async () => {
    await expect(
      runDraftAssist(sessionUser(['clients:read_all']), { clientId, channel: 'SMS', intent: 'follow_up' }),
    ).rejects.toThrow(ForbiddenError)
  })
})
