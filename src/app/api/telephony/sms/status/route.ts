import { applyLeadSmsStatus } from '@/lib/call-center/messages'
import { applySmsStatus } from '@/lib/telephony/sms-status'
import { authenticateSmsStatusWebhook } from '@/lib/telephony/webhook'

/**
 * Twilio's delivery report for a text we sent. This is where "Accepted by
 * carrier" becomes "Delivered" — or "Blocked: texting registration pending"
 * (30034) while A2P is not approved. Informational: 204, never TwiML.
 */
export async function POST(request: Request) {
  const auth = await authenticateSmsStatusWebhook(request)
  if (!auth.ok) return new Response(null, { status: auth.rejection.unknown ? 204 : auth.rejection.status })

  const { params, communicationId, organizationId } = auth.ctx
  if (communicationId) {
    await applySmsStatus(communicationId, {
      status: params.MessageStatus || params.SmsStatus,
      errorCode: params.ErrorCode || null,
    })
  } else {
    // A text to a Call Center lead lives on its Messages thread, not in Communication.
    await applyLeadSmsStatus(organizationId, params.MessageSid || params.SmsSid || '', {
      status: params.MessageStatus || params.SmsStatus,
      errorCode: params.ErrorCode || null,
    })
  }
  return new Response(null, { status: 204 })
}
