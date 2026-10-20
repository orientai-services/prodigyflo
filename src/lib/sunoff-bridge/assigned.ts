import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { contactSecrets } from '@/lib/call-center/contact'
import { facebookFormEventBody } from '@/lib/call-center/meta-route'
import { phoneHashOrNull } from '@/lib/telephony/compliance-core'
import { assignmentSnapshot, sourceMeta, sourceState, sunoffLeadId, SUNOFF_PARTNERS } from './assigned-model'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
const json = (value: unknown) => value as Prisma.InputJsonValue

/** A complete signed snapshot, scoped to two existing partners in ONE existing workspace.
 * No provisioning, notifications, calls, fake Clients, or new consent is performed here.
 * Native lead ids dedupe a Meta lead already received by ProdigyFlo's webhook.
 */
export async function syncAssignedSunoffLeads(body: unknown) {
  const parsed = assignmentSnapshot.safeParse(body)
  if (!parsed.success) return { ok: false as const, status: 400, error: 'bad_snapshot' }
  const snapshot = parsed.data
  if (snapshot.revision > Date.now() + 30_000) return { ok: false as const, status: 400, error: 'future_snapshot' }
  const people = await db.user.findMany({
    where: { email: { in: Object.values(SUNOFF_PARTNERS).map(p => p.email), mode: 'insensitive' }, isActive: true, deletedAt: null },
    select: { id: true, email: true, organizationId: true },
  })
  const users = Object.fromEntries(Object.entries(SUNOFF_PARTNERS).map(([uid, p]) => [uid, people.filter(u => u.email.toLowerCase() === p.email)[0]]))
  if (people.length !== 2 || !users['63'] || !users['169'] || users['63'].organizationId !== users['169'].organizationId)
    return { ok: false as const, status: 409, error: 'partner_workspace_mismatch' }
  const organizationId = users['63'].organizationId
  return db.$transaction(async tx => {
    // Serializes concurrent snapshots and unrelated settings edits to this organization row.
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
    const settings = record(org.settings), previousSync = record(settings.sunoffAssignedLeads)
    if (Number(previousSync.revision ?? 0) >= snapshot.revision) return { ok: true as const, ignored: true, count: snapshot.leads.length }
    const oldRows = await tx.callCenterLead.findMany({ where: { organizationId, pageId: 'sunoff' },
      select: { id: true, leadAttribution: true } })
    const activeIds = new Set<string>()
    let created = 0, updated = 0, removed = 0
    for (const lead of snapshot.leads) {
      const id = sunoffLeadId(organizationId, lead.id), person = users[lead.userId], partner = SUNOFF_PARTNERS[lead.userId]
      activeIds.add(id)
      const prev = await tx.callCenterLead.findUnique({ where: { id } })
      if (prev && prev.organizationId !== organizationId) throw new Error('Source identity conflict')
      const old = sourceMeta(prev?.leadAttribution), state = sourceState(lead)
      const contact = contactSecrets({ phone_number: lead.phone, email: lead.email ?? '' })
      const meta = { ...record(prev?.leadAttribution), sunoff: {
        id: lead.id, active: !lead.closed, userId: lead.userId, repKey: partner.key,
        revision: snapshot.revision, sourceUpdatedAt: lead.updatedAt, state, stage: lead.stage,
        managed: old?.managed ?? !prev, originalPageId: old ? old.originalPageId ?? null : prev?.pageId ?? null,
      } }
      const at = new Date(lead.updatedAt || snapshot.revision)
      const consent = lead.consent
      // Only carry a real, unexpired Meta consent record with its text version.
      const validConsent = consent?.source === 'meta' && !!consent.version && !consent.version.startsWith('pre-') &&
        !consent.revokedAt && (!consent.expiresAt || consent.expiresAt > snapshot.revision)
      const data = {
        pageId: 'sunoff', language: lead.language, lockedBy: person.id, leadAttribution: json(meta),
        phoneLast4: contact.phoneLast4, phoneSecret: contact.phoneSecret ? json(contact.phoneSecret) : undefined,
        emailSecret: contact.emailSecret ? json(contact.emailSecret) : undefined,
        phoneHash: phoneHashOrNull(contact.dialPhone), timeZone: prev?.timeZone ?? null,
        ...(lead.doNotCall ? { doNotCallAt: prev?.doNotCallAt ?? at } : {}),
        ...(validConsent && !prev?.consentAt ? { consentAt: new Date(consent!.at), consentSource: 'lead_form',
          consentFormId: consent!.formId, consentTextVersion: consent!.version } : {}),
        ...(consent?.revokedAt || (consent?.expiresAt && consent.expiresAt <= snapshot.revision) ?
          { consentRevokedAt: prev?.consentRevokedAt ?? new Date(consent.revokedAt || consent.expiresAt!) } : {}),
        ...(!old || old.state !== state ? { status: lead.appointmentAt && !lead.closed ? 'BOOKED' as const : 'WAITING' as const,
          nextAttemptAt: lead.followupAt && !lead.closed ? new Date(lead.followupAt) : null } : {}),
      }
      if (prev) { await tx.callCenterLead.update({ where: { id }, data }); updated++ }
      else {
        await tx.callCenterLead.create({ data: { id, organizationId, source: 'FORM', createdAt: new Date(lead.createdAt || snapshot.revision), ...data } })
        created++
      }
      const formBody = facebookFormEventBody({ leadgenId: lead.id, name: lead.name, zip: lead.address?.match(/\b\d{5}\b/)?.[0] ?? null })
      const form = await tx.callCenterEvent.findFirst({ where: { leadId: id, type: 'FORM' }, orderBy: { createdAt: 'asc' } })
      if (!form) await tx.callCenterEvent.create({ data: { leadId: id, type: 'FORM', body: formBody, createdAt: new Date(lead.createdAt || snapshot.revision) } })
      else if (form.body !== formBody) await tx.callCenterEvent.update({ where: { id: form.id }, data: { body: formBody } })
      if (!old || old.userId !== lead.userId || old.active === false) await tx.callCenterEvent.create({ data: { leadId: id, type: 'LOCK',
        body: JSON.stringify({ action: 'take', userId: person.id, name: partner.name, label: 'SunOff assignment', detail: `Assigned to ${partner.name} from SunOff` }) } })
      const slotId = `sunoff:${organizationId}:${lead.id}:visit`
      if (lead.appointmentAt && !lead.closed) {
        const slot = await tx.callCenterSlot.findUnique({ where: { id: slotId } })
        const startsAt = new Date(lead.appointmentAt), endsAt = new Date(lead.appointmentAt + 90 * 60_000)
        const slotData = { repKey: partner.key, startsAt, endsAt, language: lead.language,
          status: 'HOLD' as const, heldBy: 'sunoff', outcomeAt: null }
        if (!slot) await tx.callCenterSlot.create({ data: { id: slotId, organizationId, leadId: id, ...slotData,
          reminder24RepAt: at, reminder3RepAt: at, reminder24ClientAt: at, reminder3ClientAt: at } })
        else if (slot.startsAt.getTime() !== lead.appointmentAt || slot.repKey !== partner.key || slot.status === 'CANCELLED')
          await tx.callCenterSlot.update({ where: { id: slotId }, data: slotData })
      } else await tx.callCenterSlot.updateMany({ where: { id: slotId, organizationId, status: { in: ['HOLD', 'CONFIRMED'] } },
        data: { status: 'CANCELLED', outcomeAt: at } })
    }
    for (const row of oldRows) {
      const m = sourceMeta(row.leadAttribution)
      if (!m || activeIds.has(row.id) || m.removed === true) continue
      if (m.managed) {
        await tx.callCenterLead.update({ where: { id: row.id }, data: { lockedBy: null,
          nextAttemptAt: null, leadAttribution: json({ ...record(row.leadAttribution), sunoff: { ...m, active: false, removed: true, revision: snapshot.revision } }) } })
      } else {
        const restored = { ...record(row.leadAttribution) }; delete restored.sunoff
        await tx.callCenterLead.update({ where: { id: row.id }, data: { pageId: typeof m.originalPageId === 'string' ? m.originalPageId : null,
          leadAttribution: json(restored) } })
      }
      await tx.callCenterSlot.updateMany({ where: { leadId: row.id, organizationId, heldBy: 'sunoff', status: { in: ['HOLD', 'CONFIRMED'] } },
        data: { status: 'CANCELLED', outcomeAt: new Date(snapshot.revision) } })
      removed++
    }
    await tx.organization.update({ where: { id: organizationId }, data: { settings: json({ ...settings,
      sunoffAssignedLeads: { revision: snapshot.revision, at: new Date().toISOString(), count: snapshot.leads.length } }) } })
    await tx.auditEvent.create({ data: { organizationId, actorLabel: 'SunOff assignment sync', action: 'sunoff.assignments_synced',
      entityType: 'Organization', entityId: organizationId, summary: `SunOff leads: ${created} added, ${updated} refreshed, ${removed} removed` } })
    return { ok: true as const, created, updated, removed, count: snapshot.leads.length }
  }, { timeout: 30_000 })
}
