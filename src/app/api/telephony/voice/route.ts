import { after } from 'next/server'
import { recordInboundCall, teamDialNumbers } from '@/lib/telephony/calls'
import { TWIML_CONTENT_TYPE, rejectTwiml, voiceAnswerTwiml } from '@/lib/telephony/twiml'
import { authenticateWebhook, callbackUrls } from '@/lib/telephony/webhook'

/**
 * A customer just called one of the account's lines.
 *
 * The reply has to be fast — the caller is listening to silence until it
 * arrives — so the only work done inline is deciding who to ring. Writing the
 * call into the CRM happens in after(), because a slow database must never
 * turn into a dropped call.
 */
export async function POST(request: Request) {
  const auth = await authenticateWebhook(request)
  if (!auth.ok) {
    // 403/400 get no TwiML; a 404 does, so a caller on a number we released
    // hears something human instead of a carrier error tone.
    if (auth.rejection.status === 404) {
      return new Response(rejectTwiml(), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
    }
    return new Response(auth.rejection.reason, { status: auth.rejection.status })
  }

  const { number, from, params } = auth.ctx
  const callSid = params.CallSid ?? ''
  const urls = callbackUrls(callSid)

  const teamNumbers = number.routing === 'TEAM' ? await teamDialNumbers(number) : []

  const twiml = voiceAnswerTwiml({
    routing: number.routing,
    forwardTo: number.forwardTo,
    teamNumbers,
    recordCalls: number.recordCalls,
    greeting: number.voicemailGreeting,
    voicemailCallbackUrl: urls.recording,
    actionUrl: urls.dial,
  })

  if (callSid) {
    after(async () => {
      await recordInboundCall({ number, fromE164: from, callSid })
    })
  }

  return new Response(twiml, { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
}
