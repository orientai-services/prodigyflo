import { after } from 'next/server'
import { noteCarrierError } from '@/lib/telephony/account-status'
import { teamDialTargets } from '@/lib/telephony/calls'
import { parseIdentity } from '@/lib/telephony/access-token'
import { applyCallStatus, applyChildAnswered, finalizeCall, isTerminal } from '@/lib/telephony/voice-calls'
import { authenticateWebhook } from '@/lib/telephony/webhook'

/**
 * Two kinds of status, both informational (204, never TwiML):
 *
 *  - the PARENT leg's own status (the line's StatusCallback): when it ends we
 *    set endedAt and the duration. It never decides the outcome — that comes
 *    from the dial result or the voicemail — except that a call that ended
 *    with neither means the caller hung up while it rang (audit 5a).
 *  - a CHILD leg (?leg=child): who picked up — a browser, a teammate or the
 *    forward number.
 */
export async function POST(request: Request) {
  const auth = await authenticateWebhook(request)
  if (!auth.ok) return new Response(null, { status: auth.rejection.unknown ? 204 : auth.rejection.status })

  const { params, number, accountSid } = auth.ctx
  const query = new URL(request.url).searchParams
  const errorCode = params.ErrorCode || null
  if (errorCode) after(() => noteCarrierError(accountSid, errorCode))

  if (query.get('leg') === 'child') {
    const parentSid = query.get('callSid') || params.ParentCallSid || ''
    const status = (params.CallStatus ?? '').toLowerCase()
    if (parentSid && (status === 'in-progress' || status === 'answered')) {
      const stage = query.get('stage') ?? ''
      let answeredBy = 'forward'
      if (stage === 'browser') {
        const who = parseIdentity(params.To)
        answeredBy = who ? `browser:${who.userId}` : 'browser'
      } else if (stage === 'team') {
        const i = Number.parseInt(query.get('i') ?? '0', 10) || 0
        const team = await teamDialTargets(number)
        answeredBy = team[i] ? `team:${team[i].userId}` : 'team'
      }
      await applyChildAnswered(parentSid, { answeredBy, childCallSid: params.CallSid ?? null })
    }
    return new Response(null, { status: 204 })
  }

  const callSid = params.CallSid ?? ''
  const duration = Number.parseInt(params.CallDuration ?? '', 10)
  if (callSid) {
    const vc = await applyCallStatus(callSid, {
      status: params.CallStatus,
      durationSeconds: Number.isFinite(duration) ? duration : null,
      errorCode,
    })
    if (vc && isTerminal(vc.status)) after(() => finalizeCall(vc.id))
  }

  return new Response(null, { status: 204 })
}
