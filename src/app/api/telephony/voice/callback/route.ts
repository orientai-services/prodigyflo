import { TWIML_CONTENT_TYPE, callbackConfirmedTwiml, emptyTwiml } from '@/lib/telephony/twiml'
import { transcribeVoicemailFor, voicemailAnswerTwiml } from '@/lib/telephony/inbound-voice'
import { requestCallback } from '@/lib/telephony/voice-calls'
import { authenticateWebhook } from '@/lib/telephony/webhook'

/**
 * The caller pressed a key at "press 1 for a callback" (docs/DIALER_POWER.md
 * Lane C). Twilio only posts here when a key was pressed: silence falls
 * through to the voicemail verbs already in the offer's TwiML.
 *
 *   1             → the call waits on Missed as a callback request; the
 *                   caller hears a confirmation and the call ends
 *   anything else → voicemail, exactly as if they had waited
 *
 * A caller is on the line, so nothing here may leave them in silence. The
 * signature is checked first (same front door as every number webhook; a bad
 * one is a bare 403). After that, any failure while saving the request still
 * answers with voicemail, which keeps their message instead of dropping the
 * call. If the front door itself fails (database down), the caller also gets
 * voicemail: that answer reveals nothing and writes nothing, and the
 * recording callback it leads to is signature-checked on its own.
 */
export async function POST(request: Request) {
  const callSidFromUrl = new URL(request.url).searchParams.get('callSid') ?? ''
  let auth: Awaited<ReturnType<typeof authenticateWebhook>>
  try {
    auth = await authenticateWebhook(request)
  } catch (err) {
    console.error('[telephony] callback offer: lookup failed; sending to voicemail', err instanceof Error ? err.message : err)
    return twiml(voicemailAnswerTwiml({ voicemailGreeting: null, recordCalls: false }, callSidFromUrl, { skipGreeting: true }))
  }
  if (!auth.ok) {
    if (auth.rejection.unknown) return twiml(emptyTwiml())
    return new Response(null, { status: auth.rejection.status })
  }

  const { number, params } = auth.ctx
  const callSid = callSidFromUrl || params.CallSid || ''
  const digits = (params.Digits ?? '').trim()

  if (digits === '1' && callSid) {
    try {
      // The inbound row is written in after(), so on a first-answer offer it can
      // still be landing: wait briefly for it. No saved request, no promise —
      // the caller gets voicemail instead of "we'll call you back".
      let saved = await requestCallback(callSid)
      for (let i = 0; i < 4 && !saved; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        saved = await requestCallback(callSid)
      }
      if (saved && saved.direction === 'INBOUND' && saved.organizationId === number.organizationId && saved.callbackRequested) {
        return twiml(callbackConfirmedTwiml())
      }
      console.error('[telephony] callback request had no inbound call row; sending to voicemail')
    } catch (err) {
      console.error('[telephony] callback request not saved; sending to voicemail', err instanceof Error ? err.message : err)
    }
  }

  const transcribe = await transcribeVoicemailFor(number.organizationId)
  return twiml(voicemailAnswerTwiml(number, callSid, { skipGreeting: true, transcribe }))
}

function twiml(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
}
