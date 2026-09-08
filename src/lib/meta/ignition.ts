import 'server-only'
import { db } from '@/lib/db'

/**
 * Instant Lead Ignition.
 *
 * The moment a Meta lead becomes a CRM client, drop a pinned, ready-to-send
 * bilingual first touch onto the record so a rep can make contact inside the
 * speed-to-lead window — Meta form leads decay within minutes, and a sub-5-min
 * first touch is the single biggest lever on contact and set rates.
 *
 * Deliberately NON-DECISIONAL and additive: it drafts, it never sends; it never
 * assigns ownership, changes stage, or qualifies anyone (assignment stays
 * human-in-the-loop by design). Every failure is swallowed — ignition must never
 * jeopardise an already-created lead.
 */

const COMPANY = 'Solar Contract Services'

type Draft = { en: string; es: string }

/** Personalised first-touch copy in both languages — copy-paste ready. */
export function firstTouch(firstName: string, campaign: string | null): Draft {
  const name = firstName.trim() || 'there'
  const nameEs = firstName.trim() || 'buenas'
  const ctx = campaign ? ` about ${campaign}` : ''
  const ctxEs = campaign ? ` sobre ${campaign}` : ''
  return {
    en: `Hi ${name}, this is ${COMPANY} following up on your request${ctx}. Thanks for reaching out — when's a good time for a quick 5-minute call today?`,
    es: `Hola ${nameEs}, le habla ${COMPANY} dando seguimiento a su solicitud${ctxEs}. ¡Gracias por contactarnos! ¿Cuándo tiene 5 minutos hoy para una llamada rápida?`,
  }
}

/**
 * Ignite a freshly-created Meta lead. Best-effort: returns quietly on any
 * missing data and lets the caller swallow throws.
 */
export async function igniteLead(organizationId: string, clientId: string, leadgenId: string): Promise<void> {
  const client = await db.client.findFirst({
    where: { id: clientId, organizationId },
    select: {
      firstName: true,
      phone: true,
      email: true,
      preferredLanguage: true,
      createdAt: true,
      campaign: { select: { name: true } },
    },
  })
  if (!client) return

  const campaign = client.campaign?.name ?? null
  const draft = firstTouch(client.firstName, campaign)
  const es = (client.preferredLanguage || 'en').toLowerCase().startsWith('es')
  const primary = es ? draft.es : draft.en
  const secondary = es ? draft.en : draft.es
  const secondaryLabel = es ? 'English' : 'Español'

  const contact = [client.phone, client.email].filter(Boolean).join(' · ') || '—'
  const body = [
    '⚡ Instant Lead Ignition — new Meta lead',
    '',
    `Speed to lead wins: aim to make contact within 5 minutes. This lead came in from Facebook / Instagram${campaign ? ` (${campaign})` : ''}.`,
    '',
    'Ready-to-send first touch:',
    primary,
    '',
    `${secondaryLabel}:`,
    secondary,
    '',
    `Contact: ${contact}`,
  ].join('\n')

  await db.note.create({
    data: { clientId, authorId: null, body, isInternal: true, pinned: true },
  })

  const ignitionMs = Date.now() - new Date(client.createdAt).getTime()
  await db.auditEvent.create({
    data: {
      organizationId,
      actorId: null,
      actorLabel: 'Meta Lead Ads',
      action: 'meta.lead_ignited',
      entityType: 'Client',
      entityId: clientId,
      summary: `Instant first-touch drafted for Meta lead ${leadgenId} (${es ? 'ES' : 'EN'})`,
      after: { leadgenId, campaign, ignitionMs, language: es ? 'es' : 'en' },
    },
  })
}
