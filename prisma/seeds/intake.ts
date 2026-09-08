import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'

type SeedCtx = {
  organizationId: string
  users: { id: string; email: string; role: string }[]
  clientIds: string[]
}

/**
 * Demo webhook secret (synthetic, printed in the seed output): callers sign
 * with HMAC-SHA256 keyed by sha256_hex of this string.
 */
export const DEMO_INTAKE_SECRET = 'ik_demo_webhook_secret_prodigyflo'

const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex')

export async function seedIntake(db: PrismaClient, ctx: SeedCtx) {
  const { organizationId } = ctx
  const owner =
    ctx.users.find((u) => u.role === 'CLOSER') ?? ctx.users.find((u) => u.role === 'SALES_MANAGER') ?? null

  const leadSource = await db.leadSource.upsert({
    where: { organizationId_key: { organizationId, key: 'inbound-intake' } },
    update: {},
    create: { organizationId, key: 'inbound-intake', name: 'Inbound intake', channel: 'web' },
  })

  const webForm = await db.intakeSource.upsert({
    where: { organizationId_slug: { organizationId, slug: 'website-lead-form' } },
    update: {},
    create: {
      organizationId,
      kind: 'WEB_FORM',
      name: 'Website lead form',
      slug: 'website-lead-form',
      secretHash: sha256(DEMO_INTAKE_SECRET),
      fieldMapping: {
        firstName: 'first_name',
        lastName: 'last_name',
        email: 'email',
        phone: 'phone',
        utmSource: 'utm.source',
        utmCampaign: 'utm.campaign',
        note: 'message',
      },
      dedupeKeys: ['email', 'phone'],
      defaultOwnerId: owner?.id ?? null,
      defaultLeadSourceId: leadSource.id,
    },
  })

  const sheet = await db.intakeSource.upsert({
    where: { organizationId_slug: { organizationId, slug: 'facebook-leads-sheet' } },
    update: {},
    create: {
      organizationId,
      kind: 'GOOGLE_SHEET',
      name: 'Facebook leads sheet',
      slug: 'facebook-leads-sheet',
      secretHash: sha256(`${DEMO_INTAKE_SECRET}-sheet`),
      fieldMapping: {
        firstName: 'first_name',
        lastName: 'last_name',
        email: 'email',
        phone: 'phone',
        utmSource: 'utm_source',
        utmCampaign: 'utm_campaign',
        note: 'notes',
      },
      dedupeKeys: ['email', 'phone'],
      defaultOwnerId: owner?.id ?? null,
      defaultLeadSourceId: leadSource.id,
      sheetId: 'mock-sheet-demo',
      sheetTab: 'Leads',
    },
  })

  const submissions = [
    {
      sourceId: webForm.id,
      externalId: 'evt_demo_0001',
      status: 'APPLIED' as const,
      rawPayload: {
        event_id: 'evt_demo_0001',
        first_name: 'Rosa',
        last_name: 'Delgado',
        email: 'rosa.delgado@example.test',
        phone: '702-555-0102',
        utm: { source: 'google', campaign: 'brand-search' },
      },
      mappedPayload: {
        firstName: 'Rosa',
        lastName: 'Delgado',
        email: 'rosa.delgado@example.test',
        phone: '702-555-0102',
        utmSource: 'google',
        utmCampaign: 'brand-search',
      },
      clientId: ctx.clientIds[0] ?? null,
      createdClient: Boolean(ctx.clientIds[0]),
      processedAt: new Date('2026-08-20T17:05:00Z'),
    },
    {
      sourceId: webForm.id,
      externalId: 'evt_demo_0002',
      status: 'DUPLICATE' as const,
      rawPayload: {
        event_id: 'evt_demo_0002',
        first_name: 'Rosa',
        last_name: 'Delgado',
        email: 'rosa.delgado@example.test',
        phone: '702-555-0102',
      },
      mappedPayload: {
        firstName: 'Rosa',
        lastName: 'Delgado',
        email: 'rosa.delgado@example.test',
        phone: '702-555-0102',
      },
      clientId: ctx.clientIds[0] ?? null,
      matchedOn: 'email',
      processedAt: new Date('2026-08-21T09:30:00Z'),
    },
    {
      sourceId: webForm.id,
      externalId: 'evt_demo_0003',
      status: 'NEEDS_MAPPING' as const,
      rawPayload: {
        event_id: 'evt_demo_0003',
        nombre: 'Julio',
        apellido: 'Reyes',
        correo: 'julio.reyes@example.test',
        telefono: '702-555-0177',
      },
      mappedPayload: {},
      unmappedKeys: ['event_id', 'nombre', 'apellido', 'correo', 'telefono'],
      error: 'Missing required fields: firstName, lastName, email or phone. Map the incoming keys that carry them, then retry.',
      processedAt: new Date('2026-08-22T14:12:00Z'),
    },
    {
      sourceId: sheet.id,
      externalId: 'row:99',
      status: 'FAILED' as const,
      rawPayload: { first_name: 'Test', last_name: 'Row', email: 'bad-row@example.test' },
      mappedPayload: { firstName: 'Test', lastName: 'Row', email: 'bad-row@example.test' },
      error: 'Simulated ingest failure for demo purposes.',
      attemptCount: 2,
      processedAt: new Date('2026-08-22T16:40:00Z'),
    },
  ]

  for (const s of submissions) {
    await db.intakeSubmission.upsert({
      where: { sourceId_externalId: { sourceId: s.sourceId, externalId: s.externalId } },
      update: {},
      create: { organizationId, ...s },
    })
  }
}
