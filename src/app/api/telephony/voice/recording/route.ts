import { after } from 'next/server'
import { TWIML_CONTENT_TYPE, emptyTwiml } from '@/lib/telephony/twiml'
import { applyRecording, finalizeCall } from '@/lib/telephony/voice-calls'
import { authenticateWebhook } from '@/lib/telephony/webhook'

/**
 * A recording is ready: a voicemail (kind=voicemail, from <Record>) or an
 * answered call that was recorded (kind=call, from <Dial record>). Both the
 * <Record> action and its recordingStatusCallback land here; the write is
 * idempotent on the RecordingSid.
 *
 * Only the SID is stored. Twilio's RecordingUrl is never written anywhere —
 * the recording stays at the carrier, behind media auth, and plays only for
 * signed-in staff through /api/voice/recordings/<id>.
 */
export async function POST(request: Request) {
  const auth = await authenticateWebhook(request)
  if (!auth.ok) {
    if (auth.rejection.unknown) {
      return new Response(emptyTwiml(), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
    }
    return new Response(null, { status: auth.rejection.status })
  }

  const { params } = auth.ctx
  const query = new URL(request.url).searchParams
  const callSid = query.get('callSid') || params.CallSid || ''
  const kind = query.get('kind') === 'call' ? 'call' : 'voicemail'
  const duration = Number.parseInt(params.RecordingDuration ?? '', 10)
  const status = (params.RecordingStatus ?? 'completed').toLowerCase()

  // A <Record> that heard nothing still posts; an empty or failed recording is no voicemail.
  const usable = status === 'completed' && !(Number.isFinite(duration) && duration <= 0)
  if (callSid && usable) {
    const vc = await applyRecording(
      { callSid },
      { recordingSid: params.RecordingSid, durationSeconds: Number.isFinite(duration) ? duration : null, kind },
    )
    if (vc) after(() => finalizeCall(vc.id))
  }

  return new Response(emptyTwiml(), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
}
