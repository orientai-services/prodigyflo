import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { ingestInstagramEvent } from '@/lib/meta/instagram'

const run = `ig-${Date.now().toString(36)}`

describe('ingestInstagramEvent', () => {
  let orgId: string

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: `Org ${run}`, slug: run } })
    orgId = org.id
    const pipeline = await db.pipeline.create({ data: { organizationId: orgId, name: 'P', isDefault: true } })
    await db.pipelineStage.create({ data: { pipelineId: pipeline.id, key: 'NEW_LEAD', name: 'New', category: 'INTAKE', position: 0 } })
  })

  afterAll(async () => {
    await db.organization.delete({ where: { id: orgId } })
  })

  it('creates a CRM client from a comment, keyed by @handle, with message + ignition notes', async () => {
    const r = await ingestInstagramEvent(orgId, { kind: 'comment', igsid: '6123', username: 'jane_doe', text: 'How much for solar?', eventId: `${run}-c1` })
    expect(r.created).toBe(true)
    expect(r.clientId).toBeTruthy()

    const client = await db.client.findUniqueOrThrow({ where: { id: r.clientId! } })
    expect(client.instagramUserId).toBe('6123') // stable dedupe key
    expect(client.instagramHandle).toBe('@jane_doe')
    expect(client.firstName).toBe('jane_doe')
    expect(client.utmSource).toBe('instagram')
    expect(client.email).toBe('')

    const notes = await db.note.findMany({ where: { clientId: r.clientId! } })
    expect(notes.some((n) => n.body.includes('How much for solar?'))).toBe(true)
    expect(notes.some((n) => n.pinned && n.body.includes('Instant Lead Ignition'))).toBe(true)
  })

  it('is idempotent on the event id (redelivery)', async () => {
    const again = await ingestInstagramEvent(orgId, { kind: 'comment', igsid: '6123', username: 'jane_doe', text: 'How much for solar?', eventId: `${run}-c1` })
    expect(again.duplicate).toBe(true)
    expect(again.created).toBe(false)
  })

  it('dedupes a repeat messager to the same client and appends a note', async () => {
    const r = await ingestInstagramEvent(orgId, { kind: 'dm', igsid: '6123', username: 'jane_doe', text: 'Still there?', eventId: `${run}-m2` })
    expect(r.created).toBe(false)
    expect(r.clientId).toBeTruthy()
    const count = await db.client.count({ where: { organizationId: orgId, instagramHandle: '@jane_doe' } })
    expect(count).toBe(1)
    const notes = await db.note.findMany({ where: { clientId: r.clientId! } })
    expect(notes.some((n) => n.body.includes('Still there?'))).toBe(true)
  })
})
