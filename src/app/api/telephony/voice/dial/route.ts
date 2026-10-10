import { after } from 'next/server'
import { noteCarrierError } from '@/lib/telephony/account-status'
import { answeredByFor, nextInboundStage } from '@/lib/telephony/inbound-voice'
import { TWIML_CONTENT_TYPE, emptyTwiml } from '@/lib/telephony/twiml'
import { applyDialResult, dialAnswered } from '@/lib/telephony/voice-calls'
import { authenticateWebhook } from '@/lib/telephony/webhook'

/**
 * The result of one <Dial> stage — whoever we rang either picked up or did not.
 *
 * Answered: record who and for how long, and hang up cleanly when they finish.
 * Not answered: move to the next stage (browser → the line's routing; the next
 * teammate in turn; then voicemail) instead of dropping the caller, which is
 * the entire reason every Dial carries an action URL. The recording link is
 * never taken from here — only the RecordingSid, through the recording route.
 */
export async function POST(request: Request) {
  const auth = await authenticateWebhook(request)
  if (!auth.ok) {
    if (auth.rejection.unknown) {
      return new Response(emptyTwiml(), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
    }
    return new Response(null, { status: auth.rejection.status })
  }

  const { number, params, accountSid } = auth.ctx
  const query = new URL(request.url).searchParams
  const callSid = query.get('callSid') || params.CallSid || ''
  const stage = query.get('stage') || 'forward'
  const i = Number.parseInt(query.get('i') ?? '0', 10) || 0
  const dialStatus = params.DialCallStatus ?? ''
  const dialDuration = Number.parseInt(params.DialCallDuration ?? '', 10)
  const errorCode = params.ErrorCode || null

  if (errorCode) after(() => noteCarrierError(accountSid, errorCode))

  if (dialAnswered(dialStatus)) {
    if (callSid) {
      await applyDialResult(callSid, {
        dialStatus,
        dialDuration: Number.isFinite(dialDuration) ? dialDuration : null,
        answeredBy: await answeredByFor(number, stage, i),
        errorCode,
      })
    }
    return new Response(emptyTwiml(), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
  }

  if (callSid) await applyDialResult(callSid, { dialStatus: dialStatus || 'no-answer', errorCode })
  const next = await nextInboundStage({ ...auth.ctx, params: { ...params, CallSid: callSid } }, { stage, i })
  return new Response(next.twiml, { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
}
