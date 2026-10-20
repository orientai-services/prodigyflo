import { callerAudioLanguage } from '@/lib/telephony/audio-language'
import { readSecret } from '@/lib/call-center/contact'
import { db } from '@/lib/db'
import { TWIML_CONTENT_TYPE, emptyTwiml, whisperTwiml } from '@/lib/telephony/twiml'
import { authenticateClientWebhook } from '@/lib/telephony/webhook'

/**
 * Played to the callee when they answer a RECORDED outbound call (P0b):
 * "This call may be recorded for quality." We stamp disclosureServedAt when
 * Twilio fetches it — that records the notice was SENT TO THE CALL, not that
 * anyone heard it, and the UI says exactly that.
 */
export async function POST(request: Request) {
  const auth = await authenticateClientWebhook(request, 'voiceCall')
  if (!auth.ok) {
    if (auth.rejection.unknown) {
      return new Response(emptyTwiml(), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
    }
    return new Response(null, { status: auth.rejection.status })
  }
  if (auth.ctx.voiceCallId) {
    await db.voiceCall.updateMany({
      where: { id: auth.ctx.voiceCallId, disclosureServedAt: null },
      data: { disclosureServedAt: new Date() },
    })
  }
  const call=auth.ctx.voiceCallId ? await db.voiceCall.findFirst({where:{id:auth.ctx.voiceCallId,organizationId:auth.ctx.organizationId},select:{remoteSecret:true}}) : null
  const language=await callerAudioLanguage(auth.ctx.organizationId,readSecret(call?.remoteSecret) ?? '')
  return new Response(whisperTwiml(language), { status: 200, headers: { 'Content-Type': TWIML_CONTENT_TYPE } })
}
