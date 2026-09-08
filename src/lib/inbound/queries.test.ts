import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client, IntakeSource, Organization } from '@prisma/client'
import { db } from '@/lib/db'
import type { SessionUser } from '@/lib/rbac'
import { recordInboundEvent } from '@/lib/inbound/record'
import { getInboundStream, getInboundDocuments, getInboundStats } from '@/lib/inbound/queries'

/**
 * End-to-end of my slice's seam: the recording layer writes InboundEvent /
 * InboundDocument, and the (reconciled) read layer returns them org-scoped.
 * Verifies the doc upsert is idempotent by (org, externalId) across status
 * pushes, and that a contact delivery records an event but no document.
 */
describe('inbound recording + queries (db)', () => {
  const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  let org: Organization
  let source: IntakeSource
  let client: Client
  let user: SessionUser

  beforeAll(async () => {
    org = await db.organization.create({
      data: { name: `Inbound Test Org ${suffix}`, slug: `inbound-test-${suffix}` },
    })
    source = await db.intakeSource.create({
      data: {
        organizationId: org.id,
        kind: 'GO_HIGH_LEVEL',
        connectorDefId: 'gohighlevel',
        name: 'Test GHL',
        slug: `test-ghl-${suffix}`,
        isEnabled: true,
      },
    })
    const pipeline = await db.pipeline.create({
      data: { organizationId: org.id, name: 'P', isDefault: true },
    })
    const stage = await db.pipelineStage.create({
      data: { pipelineId: pipeline.id, key: 'NEW_LEAD', name: 'New', category: 'INTAKE', position: 0 },
    })
    client = await db.client.create({
      data: {
        organizationId: org.id,
        pipelineId: pipeline.id,
        currentStageId: stage.id,
        firstName: 'Nova',
        lastName: 'Trent',
        email: `nova.${suffix}@example.test`,
        phone: '7025550142',
      },
    })
    user = {
      id: `u_${suffix}`,
      name: 'Owner',
      email: `owner.${suffix}@example.test`,
      organizationId: org.id,
      organizationName: org.name,
      roleId: 'r',
      role: 'SUPER_ADMIN',
      roleName: 'Super Admin',
      isOwner: true,
      regionId: null,
      teamId: null,
      managerId: null,
      avatarUrl: null,
      title: null,
      permissions: new Set(['clients:read_all']),
      portalClientId: null,
    } as SessionUser
  })

  afterAll(async () => {
    await db.organization.delete({ where: { id: org.id } })
  })

  it('records a document event and upserts one row across repeated status pushes', async () => {
    const base = {
      event_type: 'document.status',
      contact_id: 'c1',
      document_id: `doc-${suffix}`,
      document_name: 'Signed PPA',
    }
    const r1 = await recordInboundEvent({
      source,
      submission: { id: 'sub-1', clientId: client.id },
      payload: { ...base, document_status: 'received' },
      externalId: `ext-1-${suffix}`,
    })
    const r2 = await recordInboundEvent({
      source,
      submission: { id: 'sub-2', clientId: client.id },
      payload: { ...base, document_status: 'completed', document_url: 'https://x/y.pdf' },
      externalId: `ext-2-${suffix}`,
    })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    // Two events, but a single upserted document reflecting the latest status.
    const docs = await getInboundDocuments(user)
    const mine = docs.filter((d) => d.externalId === `doc-${suffix}`)
    expect(mine).toHaveLength(1)
    expect(mine[0].status).toBe('completed')
    expect(mine[0].url).toBe('https://x/y.pdf')
    expect(mine[0].clientName).toBe('Nova Trent')
    expect(mine[0].clientHidden).toBe(false)
  })

  it('records a contact delivery as an event with no document', async () => {
    const r = await recordInboundEvent({
      source,
      submission: { id: 'sub-3', clientId: null },
      payload: { contact_id: 'c2', first_name: 'Jane', last_name: 'Doe', email: 'jane@example.test' },
      externalId: `ext-3-${suffix}`,
    })
    expect(r.ok).toBe(true)

    const contacts = await getInboundStream(user, { category: 'CONTACT' })
    const row = contacts.rows.find((e) => e.externalId === `ext-3-${suffix}`)
    expect(row).toBeDefined()
    expect(row!.category).toBe('CONTACT')
    expect(row!.clientId).toBeNull() // unmatched — still org-visible

    // No new InboundDocument was created by the contact delivery.
    const docCount = await db.inboundDocument.count({ where: { organizationId: org.id } })
    expect(docCount).toBe(1)
  })

  it('reports org-scoped stats: today by category, unmatched, total, connectors', async () => {
    const stats = await getInboundStats(user)
    expect(stats.total).toBe(3) // 2 document + 1 contact
    expect(stats.today).toBe(3)
    expect(stats.unmatched).toBe(1) // the contact delivery
    const byCat = Object.fromEntries(stats.todayByCategory.map((g) => [g.category, g.count]))
    expect(byCat.DOCUMENT).toBe(2)
    expect(byCat.CONTACT).toBe(1)
    expect(stats.connectors.find((c) => c.sourceId === source.id)?.count).toBe(3)
  })
})
