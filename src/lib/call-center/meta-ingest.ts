import 'server-only'
import { db } from '@/lib/db'
import { ingestMetaLead } from '@/lib/meta'
import type { MetaLead } from '@/lib/meta/provider'
import { leadArea, storedAttribution, withWebhookIds } from '@/lib/meta/attribution'
import { phoneHashOrNull } from '@/lib/telephony/compliance-core'
import { readTelephonySettings } from '@/lib/telephony/settings'
import { contactSecrets } from './contact'
import {
  callCenterLeadId,
  callCenterMetaRoute,
  callCenterPersonName,
  callCenterZip,
  facebookFormEventBody,
} from './meta-route'

export type RecordedMetaLead = {
  duplicate: boolean
  status: string
  createdClient: boolean
  clientId: string | null
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002')
}

/**
 * What makes a Facebook lead dialable under the calling rules
 * (docs/TELEPHONY_LIVE.md §2.13): the number's hash (dedupe with inbound
 * callers, the do-not-call list), and consent — but ONLY when this exact form
 * is on the account's consentForms list (the owner's statement that its text
 * carries the consent language) and the webhook was not a preview fixture.
 * Adding a form later never stamps leads that already came in.
 */
async function dialingFields(
  organizationId: string,
  dialPhone: string | null,
  formId: string | null,
  fixture: boolean,
): Promise<{
  phoneHash?: string
  consentAt?: Date
  consentSource?: string
  consentTextVersion?: string
  consentFormId?: string
}> {
  const out: Awaited<ReturnType<typeof dialingFields>> = {}
  const hash = phoneHashOrNull(dialPhone)
  if (hash) out.phoneHash = hash
  if (fixture || !formId) return out
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } })
  const version = readTelephonySettings(org?.settings).consentForms[formId]
  if (!version) return out
  return { ...out, consentAt: new Date(), consentSource: 'lead_form', consentTextVersion: version, consentFormId: formId }
}

/**
 * One English-page Facebook lead becomes one Call Center row plus one
 * "Facebook form" event. Phone and email are stored only as encrypted secrets.
 * A second delivery of the same leadgen id returns the existing row.
 */
export async function ingestCallCenterMetaLead(input: {
  organizationId: string
  lead: MetaLead
  pageId: string | null
  formId?: string | null
  adExternalId?: string
  adSetExternalId?: string
  /** The webhook ran in preview fixture mode: never record consent for it. */
  fixture?: boolean
}): Promise<{ duplicate: boolean; leadId: string }> {
  const id = callCenterLeadId(input.organizationId, input.lead.leadgenId)
  const existing = await db.callCenterLead.findUnique({ where: { id }, select: { id: true } })
  if (existing) return { duplicate: true, leadId: existing.id }

  const contact = contactSecrets(input.lead.fields)
  const area = leadArea(input.lead.fields)
  const attribution = storedAttribution({
    leadgenId: input.lead.leadgenId,
    attribution: withWebhookIds(input.lead.attribution, {
      adId: input.adExternalId,
      adsetId: input.adSetExternalId,
      formId: input.formId,
    }),
    pageId: input.pageId,
    area,
  })
  const dialing = await dialingFields(input.organizationId, contact.dialPhone, attribution.formId, Boolean(input.fixture))
  const body = facebookFormEventBody({
    leadgenId: input.lead.leadgenId,
    name: callCenterPersonName(input.lead.fields),
    zip: callCenterZip(input.lead.fields),
  })

  try {
    await db.$transaction(async (tx) => {
      await tx.callCenterLead.create({
        data: {
          id,
          organizationId: input.organizationId,
          pageId: input.pageId,
          source: 'FORM',
          language: 'EN',
          status: 'WAITING',
          phoneLast4: contact.phoneLast4,
          phoneSecret: contact.phoneSecret ?? undefined,
          emailSecret: contact.emailSecret ?? undefined,
          leadAttribution: attribution,
          outOfArea: area.outOfArea,
          ...dialing,
        },
      })
      await tx.callCenterEvent.create({
        data: { leadId: id, type: 'FORM', body },
      })
    })
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const raced = await db.callCenterLead.findUnique({ where: { id }, select: { id: true } })
    if (raced) return { duplicate: true, leadId: raced.id }
    throw err
  }

  return { duplicate: false, leadId: id }
}

/**
 * Webhook dispatch. English Page / English form never becomes a Client and
 * never asks for ignition. Every other signed lead keeps the existing path.
 */
export async function recordMetaWebhookLead(input: {
  organizationId: string
  lead: MetaLead
  pageId?: string | null
  formId?: string | null
  adExternalId?: string
  adSetExternalId?: string
  fixture?: boolean
}): Promise<RecordedMetaLead> {
  if (callCenterMetaRoute({ pageId: input.pageId, formId: input.formId }) === 'call-center') {
    const saved = await ingestCallCenterMetaLead({
      organizationId: input.organizationId,
      lead: input.lead,
      pageId: input.pageId?.trim() || null,
      formId: input.formId ?? null,
      adExternalId: input.adExternalId,
      adSetExternalId: input.adSetExternalId,
      fixture: input.fixture,
    })
    return {
      duplicate: saved.duplicate,
      status: 'CALL_CENTER',
      createdClient: false,
      clientId: null,
    }
  }

  const result = await ingestMetaLead(input.organizationId, input.lead, {
    adExternalId: input.adExternalId,
    adSetExternalId: input.adSetExternalId,
    formExternalId: input.formId ?? undefined,
    pageId: input.pageId ?? null,
  })
  const createdClient = !result.duplicate && result.submission.createdClient && Boolean(result.submission.clientId)
  return {
    duplicate: result.duplicate,
    status: result.submission.status,
    createdClient,
    clientId: createdClient ? result.submission.clientId : null,
  }
}
