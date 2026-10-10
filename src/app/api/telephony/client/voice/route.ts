import { COULD_NOT_PLACE, placeBrowserCall } from '@/lib/telephony/outbound-voice'
import { isPreflightRequest, preflightTwiml } from '@/lib/telephony/quality'
import { TWIML_CONTENT_TYPE, sayAndHangup } from '@/lib/telephony/twiml'
import { authenticateClientWebhook } from '@/lib/telephony/webhook'

/**
 * The TwiML App's Voice URL (P0b): a browser in this app asked Twilio to place
 * a call. Signature, AccountSid and ApplicationSid are checked first; every
 * decision about the call is made on the server (see outbound-voice.ts). A
 * refusal is spoken to the rep in plain words, then the call hangs up.
 *
 * "Test connection" (Device.runPreflight) connects with no custom params. It
 * passes the same signature/account/app checks as a real call, and then gets
 * a few seconds of silence and a hang-up: no <Dial>, so a test can never reach
 * the phone network, and no VoiceCall row is written.
 */
export async function POST(request: Request) {
  const auth = await authenticateClientWebhook(request, 'identity')
  if (!auth.ok) {
    if (auth.rejection.unknown) {
      return new Response(sayAndHangup(COULD_NOT_PLACE), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
    }
    return new Response(null, { status: auth.rejection.status })
  }
  if (auth.ctx.userId && isPreflightRequest(auth.ctx.params)) {
    return new Response(preflightTwiml(), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
  }
  const twiml = await placeBrowserCall(auth.ctx)
  return new Response(twiml, { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
}
