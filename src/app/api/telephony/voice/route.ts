import { after } from 'next/server'
import { recordInboundCall } from '@/lib/telephony/calls'
import { answerInboundCall } from '@/lib/telephony/inbound-voice'
import { TWIML_CONTENT_TYPE, rejectTwiml } from '@/lib/telephony/twiml'
import { authenticateWebhook } from '@/lib/telephony/webhook'

/**
 * A customer just called one of the account's lines.
 *
 * The reply has to be fast — the caller is listening to silence until it
 * arrives — so the only work done inline is deciding who to ring (business
 * hours → voice limit → browsers → the line's routing). Writing the call into
 * the CRM happens in after(), because a slow database must never turn into a
 * dropped call. The one exception is the voice-limited case: there the ledger
 * row is written inline under the account lock (see inbound-voice.ts).
 */
export async function POST(request: Request) {
  const auth = await authenticateWebhook(request)
  if (!auth.ok) {
    // Only a request signed with the platform token reaches the "unknown" answer:
    // a caller on a number we released hears something human, while an unsigned
    // probe gets a bare 403 whether or not the line exists.
    if (auth.rejection.unknown) {
      return new Response(rejectTwiml(), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
    }
    return new Response(null, { status: auth.rejection.status })
  }

  const { number, from, params, accountSid } = auth.ctx
  const callSid = params.CallSid ?? ''
  const answer = await answerInboundCall(auth.ctx)

  if (callSid) {
    after(async () => {
      try {
        await recordInboundCall({ number, fromE164: from, callSid, accountSid, stage: answer.stage, stirVerstat: params.StirVerstat ?? null })
      } catch (err) {
        console.error('[telephony] inbound call not recorded', err instanceof Error ? err.message : err)
      }
    })
  }

  return new Response(answer.twiml, { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
}
