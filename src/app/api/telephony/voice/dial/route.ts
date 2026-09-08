import { updateCallOutcome } from '@/lib/telephony/calls'
import { TWIML_CONTENT_TYPE, emptyTwiml, noAnswerTwiml } from '@/lib/telephony/twiml'
import { authenticateWebhook, callbackUrls } from '@/lib/telephony/webhook'

/**
 * The result of the <Dial> — whoever we rang either picked up or did not.
 *
 * Answered: record the outcome and hang up cleanly when they finish.
 * Unanswered/busy/failed: send the caller to voicemail instead of dropping
 * them, which is the entire reason the Dial carries an action URL.
 */
export async function POST(request: Request) {
  const auth = await authenticateWebhook(request)
  if (!auth.ok) return new Response(auth.rejection.reason, { status: auth.rejection.status })

  const { number, params } = auth.ctx
  const callSid = new URL(request.url).searchParams.get('callSid') || params.CallSid || ''
  const dialStatus = params.DialCallStatus ?? ''
  const dialDuration = Number.parseInt(params.DialCallDuration ?? '', 10)

  if (callSid) {
    await updateCallOutcome({
      callSid,
      status: dialStatus,
      durationSeconds: Number.isFinite(dialDuration) ? dialDuration : null,
      recordingRef: params.RecordingUrl || null,
    })
  }

  const answered = dialStatus.toLowerCase() === 'completed' || dialStatus.toLowerCase() === 'answered'
  const body = answered
    ? emptyTwiml()
    : noAnswerTwiml({
        routing: number.routing,
        recordCalls: number.recordCalls,
        voicemailCallbackUrl: callbackUrls(callSid).recording,
        actionUrl: callbackUrls(callSid).dial,
      })

  return new Response(body, { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
}
