import { after } from 'next/server'
import { applyRecording, finalizeCall } from '@/lib/telephony/voice-calls'
import { authenticateClientWebhook } from '@/lib/telephony/webhook'

/**
 * A recorded outbound browser call is ready (P0b). Only the RecordingSid is
 * kept (validated); the media URL is never stored. Informational: 204.
 */
export async function POST(request: Request) {
  const auth = await authenticateClientWebhook(request, 'voiceCall')
  if (!auth.ok) return new Response(null, { status: auth.rejection.unknown ? 204 : auth.rejection.status })

  const { params, voiceCallId } = auth.ctx
  const duration = Number.parseInt(params.RecordingDuration ?? '', 10)
  const status = (params.RecordingStatus ?? 'completed').toLowerCase()
  if (voiceCallId && status === 'completed') {
    const vc = await applyRecording(
      { id: voiceCallId },
      { recordingSid: params.RecordingSid, durationSeconds: Number.isFinite(duration) ? duration : null, kind: 'call' },
    )
    if (vc) after(() => finalizeCall(vc.id))
  }
  return new Response(null, { status: 204 })
}
