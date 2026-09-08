import { processInboundMessage } from '@/lib/messaging/inbound'
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
 * The empty TwiML reply is deliberate: auto-replying to an inbound text is a
 * decision for a sequence, not for the transport.
 */
export async function POST(request: Request) {
  const auth = await authenticateWebhook(request)
  if (!auth.ok) return new Response(auth.rejection.reason, { status: auth.rejection.status })

  const { params, from } = auth.ctx
  const body = params.Body ?? ''
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
