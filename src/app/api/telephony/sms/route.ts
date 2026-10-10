import { processInboundMessage, recordUnroutedOptOut } from '@/lib/messaging/inbound'
import { toE164 } from '@/lib/telephony/provider'
import { TWIML_CONTENT_TYPE, emptyTwiml } from '@/lib/telephony/twiml'
import { authenticateWebhook } from '@/lib/telephony/webhook'

/**
 * Inbound SMS straight from Twilio.
 *
 * The existing /api/inbound/sms endpoint stays as-is — it is the HMAC-signed
 * generic path any provider or a curl can use. This one speaks Twilio's own
 * form-encoded dialect and its own signature, then hands the message to the
 * SAME processInboundMessage: one place decides client matching, idempotency,
 * the STOP/TCPA revocation and the unmatched-message notification, so texting
 * behaviour cannot drift between the two doors.
 *
 * A picture with no words used to be dropped; it is now kept as
 * "[Media message]" (the media itself is P1).
 *
 * The empty TwiML reply is deliberate: auto-replying to an inbound text is a
 * decision for a sequence, not for the transport — and STOP is answered by
 * Twilio's own keyword handling, never by us.
 */
const MEDIA_ONLY_BODY = '[Media message]'

export async function POST(request: Request) {
  const auth = await authenticateWebhook(request)
  if (!auth.ok) {
    if (auth.rejection.unknown) {
      // Signed, but to a number we have no line for: only an opt-out is kept.
      const p = auth.rejection.params ?? {}
      const sender = toE164(p.From ?? '') ?? p.From ?? ''
      if (sender && p.Body?.trim()) {
        await recordUnroutedOptOut({ from: sender, to: p.To ?? null, body: p.Body, external_id: p.MessageSid || p.SmsSid || '' })
      }
      return new Response(emptyTwiml(), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
    }
    return new Response(null, { status: auth.rejection.status })
  }

  const { params, from } = auth.ctx
  const numMedia = Number.parseInt(params.NumMedia ?? '0', 10) || 0
  const body = (params.Body ?? '').trim() ? params.Body! : numMedia > 0 ? MEDIA_ONLY_BODY : ''
  const messageSid = params.MessageSid || params.SmsMessageSid || params.SmsSid || ''

  if (from && body && messageSid) {
    await processInboundMessage('SMS', {
      from,
      to: auth.ctx.to,
      body,
      external_id: messageSid,
    })
  }

  return new Response(emptyTwiml(), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
}
