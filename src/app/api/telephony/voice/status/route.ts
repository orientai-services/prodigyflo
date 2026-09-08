import { updateCallOutcome } from '@/lib/telephony/calls'
import { authenticateWebhook } from '@/lib/telephony/webhook'

/**
 * The carrier's final word on a call: how it ended and how long it lasted.
 * Purely informational — it answers 204 and never returns TwiML, because by
 * the time it fires the call is already over.
 */
export async function POST(request: Request) {
  const auth = await authenticateWebhook(request)
  if (!auth.ok) return new Response(auth.rejection.reason, { status: auth.rejection.status })

  const { params } = auth.ctx
  const callSid = params.CallSid ?? ''
  const duration = Number.parseInt(params.CallDuration ?? '', 10)

  if (callSid) {
    await updateCallOutcome({
      callSid,
      status: params.CallStatus,
      durationSeconds: Number.isFinite(duration) ? duration : null,
    })
  }

  return new Response(null, { status: 204 })
}
