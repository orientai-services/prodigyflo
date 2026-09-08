import { updateCallOutcome } from '@/lib/telephony/calls'
import { TWIML_CONTENT_TYPE, emptyTwiml } from '@/lib/telephony/twiml'
import { authenticateWebhook } from '@/lib/telephony/webhook'

/**
 * A voicemail was left. The recording itself stays at the carrier — we keep
 * only its URL on the Call row, so nothing sensitive is copied onto this
 * server and the recording follows the carrier's own retention.
 */
export async function POST(request: Request) {
  const auth = await authenticateWebhook(request)
  if (!auth.ok) return new Response(auth.rejection.reason, { status: auth.rejection.status })

  const { params } = auth.ctx
  const callSid = new URL(request.url).searchParams.get('callSid') || params.CallSid || ''
  const duration = Number.parseInt(params.RecordingDuration ?? '', 10)

  if (callSid && params.RecordingUrl) {
    await updateCallOutcome({
      callSid,
      recordingRef: params.RecordingUrl,
      recordingDurationSeconds: Number.isFinite(duration) ? duration : null,
      voicemailLeft: true,
    })
  }

  return new Response(emptyTwiml(), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
}
