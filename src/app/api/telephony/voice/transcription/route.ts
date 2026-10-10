import { applyTranscript } from '@/lib/telephony/voice-calls'
import { authenticateWebhook } from '@/lib/telephony/webhook'

/**
 * Twilio's transcription of a voicemail (<Record transcribeCallback>). The
 * text is stored once on VoiceCall.transcript (whitespace collapsed, capped at
 * TRANSCRIPT_MAX_CHARS); replays and later transcriptions of the same call
 * change nothing, and a failed transcription stores nothing. Signed like every
 * number webhook: the line is found from `To`, or from our own ?callSid=.
 * Nobody is on the line by now, so the answer is a bare 204.
 */
export async function POST(request: Request) {
  const auth = await authenticateWebhook(request)
  if (!auth.ok) {
    if (auth.rejection.unknown) return new Response(null, { status: 204 })
    return new Response(null, { status: auth.rejection.status })
  }

  const { params } = auth.ctx
  const callSid = new URL(request.url).searchParams.get('callSid') || params.CallSid || ''
  if (callSid) {
    await applyTranscript(callSid, {
      text: params.TranscriptionText,
      status: params.TranscriptionStatus,
      recordingSid: params.RecordingSid ?? null,
    })
  }
  return new Response(null, { status: 204 })
}
