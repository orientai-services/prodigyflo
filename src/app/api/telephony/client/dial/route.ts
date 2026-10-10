import { after } from 'next/server'
import { db } from '@/lib/db'
import { noteCarrierError } from '@/lib/telephony/account-status'
import { dialFailureSpeech } from '@/lib/telephony/outbound-voice'
import { TWIML_CONTENT_TYPE, emptyTwiml, sayAndHangup } from '@/lib/telephony/twiml'
import { applyDialResult } from '@/lib/telephony/voice-calls'
import { authenticateClientWebhook } from '@/lib/telephony/webhook'

/**
 * The outbound <Dial>'s action (P0b): the callee answered or did not. On a
 * failure the rep HEARS why in plain words — including "one call at a time"
 * for error 10004 while the business profile is pending — then the call ends.
 */
export async function POST(request: Request) {
  const auth = await authenticateClientWebhook(request, 'voiceCall')
  if (!auth.ok) {
    if (auth.rejection.unknown) {
      return new Response(emptyTwiml(), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
    }
    return new Response(null, { status: auth.rejection.status })
  }

  const { params, voiceCallId, accountSid } = auth.ctx
  const dialStatus = params.DialCallStatus ?? ''
  const dialDuration = Number.parseInt(params.DialCallDuration ?? '', 10)
  const errorCode = params.ErrorCode || null
  if (errorCode) after(() => noteCarrierError(accountSid, errorCode))

  const vc = voiceCallId ? await db.voiceCall.findUnique({ where: { id: voiceCallId }, select: { callSid: true } }) : null
  if (vc) {
    await applyDialResult(vc.callSid, {
      dialStatus,
      dialDuration: Number.isFinite(dialDuration) ? dialDuration : null,
      errorCode,
    })
  }

  const speech = dialFailureSpeech(dialStatus, errorCode)
  return new Response(speech ? sayAndHangup(speech) : emptyTwiml(), {
    status: 200,
    headers: { 'Content-Type': TWIML_CONTENT_TYPE },
  })
}
