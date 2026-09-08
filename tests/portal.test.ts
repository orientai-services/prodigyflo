import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StageKey, DocumentStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'
import { permissionsForRole, type PermissionKey } from '@/lib/permissions'
import {
  canClientUpload,
  CLIENT_STAGE_VIEWS,
  clientStageView,
  DOC_STATUS_VIEWS,
  findPortalClient,
  loadPortalDocuments,
  loadPortalMessages,
  portalUploadTarget,
  PORTAL_STEPS,
} from '@/lib/portal'

process.env.AUTH_SECRET ??= 'test-secret'

// ── Stage-label mapping ──────────────────────────────────────────────────────

describe('client-safe stage mapping', () => {
  it('covers every StageKey', () => {
    for (const key of Object.values(StageKey)) {
      const view = CLIENT_STAGE_VIEWS[key]
      expect(view, `missing view for ${key}`).toBeDefined()
      expect(view.headline.length).toBeGreaterThan(0)
      expect(view.detail.length).toBeGreaterThan(0)
      expect(view.step === null || (view.step >= 0 && view.step < PORTAL_STEPS.length)).toBe(true)
    }
  })

  it('never leaks internal or negative vocabulary to the client', () => {
    const banned = /\b(lost|disqualif\w*|credit|dq|pipeline|lead|reject\w*|deal)\b/i
    for (const key of Object.values(StageKey)) {
      const view = CLIENT_STAGE_VIEWS[key]
      expect(banned.test(view.headline), `banned word in ${key} headline: "${view.headline}"`).toBe(false)
      expect(banned.test(view.detail), `banned word in ${key} detail: "${view.detail}"`).toBe(false)
    }
  })

  it('maps terminal-negative and hold states to the neutral view', () => {
    expect(clientStageView('CLOSED_LOST').step).toBeNull()
    expect(clientStageView('NOT_QUALIFIED').step).toBeNull()
    expect(clientStageView('ON_HOLD').step).toBeNull()
  })

  it('maps the happy path onto ordered tracker steps', () => {
    expect(clientStageView('NEW_LEAD').step).toBe(0)
    expect(clientStageView('DOCUMENT_COLLECTION').step).toBe(3)
    expect(clientStageView('CLOSED_WON').step).toBe(PORTAL_STEPS.length - 1)
  })
})

describe('document status mapping', () => {
  it('covers every DocumentStatus with client language', () => {
    for (const status of Object.values(DocumentStatus)) {
      const view = DOC_STATUS_VIEWS[status]
      expect(view, `missing view for ${status}`).toBeDefined()
      expect(/rejected|internal|extraction/i.test(view.label)).toBe(false)
    }
  })

  it('locks approved and in-review documents against client uploads', () => {
    expect(canClientUpload('APPROVED')).toBe(false)
    expect(canClientUpload('UNDER_REVIEW')).toBe(false)
    expect(canClientUpload('PROCESSING')).toBe(false)
    expect(canClientUpload('REQUESTED')).toBe(true)
    expect(canClientUpload('REJECTED')).toBe(true)
    expect(canClientUpload('EXPIRED')).toBe(true)
  })
})

// ── Permission wiring ────────────────────────────────────────────────────────

describe('portal permission surface', () => {
  it('CLIENT has only portal:self — the staff upload permission is absent', () => {
    const perms = permissionsForRole('CLIENT')
    expect(perms).toContain('portal:self')
    expect(perms).not.toContain('documents:upload')
    expect(perms).not.toContain('clients:read_all')
  })
})

// ── DB-backed scoping ────────────────────────────────────────────────────────

function clientSession(overrides: Partial<SessionUser> & { organizationId: string }): SessionUser {
  return {
    id: 'portal-test-user',
    name: 'Portal Client',
    email: 'portal-test@example.com',
    organizationName: 'Test Org',
    roleId: 'role',
    isOwner: false,
    role: 'CLIENT',
    roleName: 'Client',
    regionId: null,
    teamId: null,
    managerId: null,
    avatarUrl: null,
    title: null,
    permissions: new Set<PermissionKey>(['portal:self']),
    portalClientId: null,
    ...overrides,
  }
}

describe('portal scoping (DB)', () => {
  const stamp = `portaltest-${Date.now()}`
  let orgId: string
  let clientA: string
  let clientB: string
  let userA: string
  let userB: string
  let reqA: string
  let reqB: string

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: 'Portal Test Org', slug: stamp } })
    orgId = org.id
    const pipeline = await db.pipeline.create({
      data: { organizationId: orgId, name: 'Test pipeline', isDefault: true },
    })
    const stage = await db.pipelineStage.create({
      data: { pipelineId: pipeline.id, key: 'DOCUMENT_COLLECTION', name: 'Docs', category: 'FULFILLMENT', position: 0 },
    })
    const role = await db.role.create({ data: { organizationId: orgId, key: 'CLIENT', name: 'Client' } })

    const mkPortal = async (suffix: string) => {
      const user = await db.user.create({
        data: {
          organizationId: orgId,
          roleId: role.id,
          email: `${stamp}-${suffix}@example.com`,
          passwordHash: 'x',
          name: `Portal ${suffix}`,
        },
      })
      const client = await db.client.create({
        data: {
          organizationId: orgId,
          pipelineId: pipeline.id,
          currentStageId: stage.id,
          portalUserId: user.id,
          firstName: 'Portal',
          lastName: suffix.toUpperCase(),
          email: `${stamp}-${suffix}-client@example.com`,
          phone: '7025550101',
        },
      })
      return { user, client }
    }

    const a = await mkPortal('a')
    const b = await mkPortal('b')
    userA = a.user.id
    userB = b.user.id
    clientA = a.client.id
    clientB = b.client.id

    // One requested document requirement per client.
    const pkg = await db.documentPackage.create({ data: { organizationId: orgId, name: 'Test package' } })
    const mkReq = async (key: string, clientId: string) => {
      const req = await db.documentRequirement.create({
        data: { packageId: pkg.id, key, name: `Requirement ${key}` },
      })
      await db.clientDocument.create({
        data: { clientId, requirementId: req.id, status: 'REQUESTED' },
      })
      return req.id
    }
    reqA = await mkReq('req-a', clientA)
    reqB = await mkReq('req-b', clientB)

    // Comms on client A: one client-visible, one internal, one internal-ish note.
    await db.communication.createMany({
      data: [
        { clientId: clientA, channel: 'EMAIL', direction: 'OUTBOUND', subject: 'Welcome', body: 'Visible to client', isInternal: false },
        { clientId: clientA, channel: 'EMAIL', direction: 'OUTBOUND', subject: 'Internal strategy', body: 'Staff only', isInternal: true },
        { clientId: clientA, channel: 'NOTE', direction: 'OUTBOUND', subject: 'Case note', body: 'Also staff only', isInternal: false },
      ],
    })
  })

  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: orgId } })
  })

  it('a portal session resolves only its own client', async () => {
    const session = clientSession({ organizationId: orgId, id: userA, portalClientId: clientA })
    const found = await findPortalClient(session)
    expect(found?.id).toBe(clientA)
  })

  it('client A can never load client B, even with a forged portalClientId', async () => {
    // The session claims B's client id but is signed in as user A: clientScope
    // pins CLIENT sessions to portalUserId, so the forged id resolves to nothing.
    const forged = clientSession({ organizationId: orgId, id: userA, portalClientId: clientB })
    expect(await findPortalClient(forged)).toBeNull()

    const direct = await db.client.findFirst({
      where: { AND: [clientScope(clientSession({ organizationId: orgId, id: userA, portalClientId: clientA })), { id: clientB }] },
    })
    expect(direct).toBeNull()
  })

  it('a staff-shaped session without CLIENT role gets nothing from the portal loader', async () => {
    const staff = clientSession({ organizationId: orgId, id: userA, portalClientId: clientA, role: 'CLOSER' })
    expect(await findPortalClient(staff)).toBeNull()
  })

  it('upload target accepts the session’s own requested requirement', async () => {
    const session = clientSession({ organizationId: orgId, id: userA, portalClientId: clientA })
    const target = await portalUploadTarget(session, reqA)
    expect(target.ok).toBe(true)
    if (target.ok) {
      expect(target.client.id).toBe(clientA)
      expect(target.requirement.id).toBe(reqA)
    }
  })

  it('upload target rejects another client’s requirement (ownership check)', async () => {
    const session = clientSession({ organizationId: orgId, id: userA, portalClientId: clientA })
    const target = await portalUploadTarget(session, reqB)
    expect(target.ok).toBe(false)
    if (!target.ok) expect(target.status).toBe(404)
  })

  it('upload target rejects a session with no portal link (permission bypass attempt)', async () => {
    const noPortal = clientSession({ organizationId: orgId, id: userB, portalClientId: null })
    const target = await portalUploadTarget(noPortal, reqA)
    expect(target.ok).toBe(false)
    if (!target.ok) expect(target.status).toBe(403)
  })

  it('upload target locks a requirement whose latest version is under review', async () => {
    await db.clientDocument.updateMany({
      where: { clientId: clientA, requirementId: reqA },
      data: { status: 'UNDER_REVIEW' },
    })
    const session = clientSession({ organizationId: orgId, id: userA, portalClientId: clientA })
    const target = await portalUploadTarget(session, reqA)
    expect(target.ok).toBe(false)
    if (!target.ok) expect(target.status).toBe(409)
    await db.clientDocument.updateMany({
      where: { clientId: clientA, requirementId: reqA },
      data: { status: 'REQUESTED' },
    })
  })

  it('portal messages exclude internal communications and notes', async () => {
    const messages = await loadPortalMessages(clientA, 'The Team')
    expect(messages.some((m) => m.body === 'Visible to client')).toBe(true)
    expect(messages.some((m) => m.body === 'Staff only')).toBe(false)
    expect(messages.some((m) => m.body === 'Also staff only')).toBe(false)
  })

  it('portal documents expose only client-visible comments', async () => {
    await db.clientDocument.updateMany({
      where: { clientId: clientA, requirementId: reqA },
      data: {
        status: 'REJECTED',
        clientVisibleComment: 'Please send a color photo.',
        internalComment: 'Looks doctored — escalate.',
        rejectionReason: 'quality',
      },
    })
    const docs = await loadPortalDocuments(clientA)
    const doc = docs.find((d) => d.requirementId === reqA)
    expect(doc).toBeDefined()
    expect(doc?.clientVisibleComment).toBe('Please send a color photo.')
    expect(JSON.stringify(docs)).not.toContain('doctored')
    expect(doc?.canUpload).toBe(true)
  })
})
