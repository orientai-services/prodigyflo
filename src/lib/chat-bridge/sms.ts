import 'server-only'
import { db } from '@/lib/db'
import { isMockMode } from '@/lib/messaging'
import { sendLeadText } from '@/lib/call-center/messages'
import { readSmsEvent } from '@/lib/call-center/messages-core'
import { linkedSunoffIdById } from './link'

/**
 * Client-SMS mode of a ProdigyFlo case chat (docs/CYS_BRIDGE.md §B4, §C):
 *
 *   POST /api/bridge/chat/case-sms {pf_lead_id, uid, pf_user_id, body, request_id}  (signed with PF_CHAT_KEY)
 *
 * The chat names the ProdigyFlo user (the token's host_ref) and its SunOff
 * uid; ProdigyFlo checks that this user really links to that uid, then
 * decides everything itself before anything leaves: the user must hold the
 * lead (or be a Super Admin), the lead must have consent that wasn't revoked,
 * must not be on do-not-call, texting must not be the mock provider, and then
 * the one outbound decision runs (quiet hours 9–20 lead time, suppression,
 * STOP) inside sendLeadText, which sends from ProdigyFlo's own subaccount and
 * writes the CallCenterEvent. The chat Worker never holds a carrier credential.
 */

export type CaseSmsInput = { pf_lead_id: string; uid: string; pf_user_id: string; body: string; request_id: string }
export type CaseSmsResult =
  | { status: 200; body: { ok: true; id: string; via: 'sms'; delivery: 'sent' | 'failed'; duplicate?: true } }
  | { status: 400 | 403 | 404 | 409 | 422; body: { ok: false; error: string; message: string } }

const refuse = (status: 400 | 403 | 404 | 409 | 422, error: string, message: string): CaseSmsResult => ({ status, body: { ok: false, error, message } })

export function parseCaseSms(raw: unknown): CaseSmsInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const ok =
    typeof r.pf_lead_id === 'string' && /^[A-Za-z0-9_:.-]{1,120}$/.test(r.pf_lead_id) &&
    typeof r.uid === 'string' && /^u\d{1,12}$/.test(r.uid) &&
    typeof r.pf_user_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.pf_user_id) &&
    typeof r.body === 'string' && r.body.trim().length > 0 && r.body.length <= 1500 &&
    typeof r.request_id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(r.request_id)
  return ok ? { pf_lead_id: r.pf_lead_id as string, uid: r.uid as string, pf_user_id: r.pf_user_id as string, body: (r.body as string).trim(), request_id: r.request_id as string } : null
}

export async function sendCaseSms(input: CaseSmsInput, now = new Date()): Promise<CaseSmsResult> {
  const link = await linkedSunoffIdById(input.pf_user_id)
  if (!link || `u${link.sunoffUserId}` !== input.uid) return refuse(403, 'not_linked', 'Your SunOff account isn’t linked to this ProdigyFlo user.')
  const user = link.user

  // Replays of one request never send twice (the signature window is 5 minutes; the id is remembered for good).
  const prior = await db.auditEvent.findFirst({
    where: { organizationId: user.organizationId, action: 'chat.case_sms_sent', after: { path: ['requestId'], equals: input.request_id } },
    select: { after: true },
  })
  const priorId = (prior?.after as { eventId?: unknown } | null)?.eventId
  if (typeof priorId === 'string') return { status: 200, body: { ok: true, id: priorId, via: 'sms', delivery: 'sent', duplicate: true } }

  const lead = await db.callCenterLead.findFirst({
    where: { id: input.pf_lead_id, organizationId: user.organizationId },
    select: { id: true, lockedBy: true, consentAt: true, consentRevokedAt: true, doNotCallAt: true },
  })
  if (!lead) return refuse(404, 'not_found', 'That lead isn’t in your workspace.')
  if (lead.lockedBy !== user.id && user.role !== 'SUPER_ADMIN') return refuse(403, 'not_holder', 'Only the rep holding this lead can text them.')
  if (lead.doNotCallAt) return refuse(409, 'dnc', 'This lead is on the do-not-call list.')
  if (!lead.consentAt || lead.consentRevokedAt) return refuse(409, 'no_consent', 'This lead hasn’t agreed to texts, or took it back.')
  if (isMockMode('SMS')) return refuse(409, 'sms_off', 'Texting is switched off (test mode). Nothing was sent.')

  const sent = await sendLeadText(user, lead.id, input.body, now)
  if (!sent.ok) return refuse(409, 'blocked', sent.error)
  const row = await db.callCenterEvent.findUnique({ where: { id: sent.message.id }, select: { body: true } })
  const delivery = readSmsEvent(row?.body ?? '')?.status === 'failed' ? 'failed' : 'sent'
  await db.auditEvent
    .create({
      data: {
        organizationId: user.organizationId,
        actorId: user.id,
        actorLabel: `${user.name} (${user.roleName}) via SunOff Chat`,
        action: 'chat.case_sms_sent',
        entityType: 'CallCenterLead',
        entityId: lead.id,
        summary: delivery === 'sent' ? 'Texted from the team chat' : 'Text from the team chat failed',
        after: { requestId: input.request_id, eventId: sent.message.id, delivery },
      },
    })
    .catch(() => undefined)
  return { status: 200, body: { ok: true, id: sent.message.id, via: 'sms', delivery } }
}
