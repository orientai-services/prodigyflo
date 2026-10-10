import { after } from 'next/server'
import { db } from '@/lib/db'
import { noteCarrierError } from '@/lib/telephony/account-status'
import { applyCallStatus, finalizeCall, isTerminal } from '@/lib/telephony/voice-calls'
import { authenticateClientWebhook } from '@/lib/telephony/webhook'

/**
 * Status for an outbound browser call (P0b). Two senders:
 *
 *  - ?vc=<id>    the callee leg (<Number statusCallback>): answered time,
 *                the child CallSid, carrier errors
 *  - ?parent=1   the TwiML App's own Status Callback for the browser leg: the
 *                ROOT call's end. It finalizes the row even if the child's
 *                callback is lost, so a dropped callback can't hold the
 *                account's single call slot for hours.
 *
 * Informational: 204.
 */
export async function POST(request: Request) {
  const parent = new URL(request.url).searchParams.get('parent') === '1'
  const auth = await authenticateClientWebhook(request, parent ? 'parent' : 'voiceCall')
  if (!auth.ok) return new Response(null, { status: auth.rejection.unknown ? 204 : auth.rejection.status })

  const { params, voiceCallId, accountSid } = auth.ctx
  const errorCode = params.ErrorCode || null
  if (errorCode) after(() => noteCarrierError(accountSid, errorCode))
  if (!voiceCallId) return new Response(null, { status: 204 })

  const vc = await db.voiceCall.findUnique({ where: { id: voiceCallId } })
  if (!vc) return new Response(null, { status: 204 })
  const status = (params.CallStatus ?? '').toLowerCase()
  const duration = Number.parseInt(params.CallDuration ?? '', 10)

  if (parent) {
    const row = await applyCallStatus(vc.callSid, {
      status,
      durationSeconds: Number.isFinite(duration) ? duration : null,
      errorCode,
    })
    if (row && isTerminal(row.status)) after(() => finalizeCall(row.id))
    return new Response(null, { status: 204 })
  }

  // The callee leg.
  if (status === 'in-progress' || status === 'answered') {
    await db.voiceCall.update({
      where: { id: vc.id },
      data: { answeredAt: vc.answeredAt ?? new Date(), childCallSid: vc.childCallSid ?? params.CallSid ?? null, status: vc.status === 'initiated' || vc.status === 'ringing' ? 'in-progress' : undefined },
    })
  } else if (status === 'ringing' && vc.status === 'initiated') {
    await db.voiceCall.update({ where: { id: vc.id }, data: { status: 'ringing', childCallSid: vc.childCallSid ?? params.CallSid ?? null } })
  }
  if (errorCode && !vc.errorCode) await db.voiceCall.update({ where: { id: vc.id }, data: { errorCode } })
  return new Response(null, { status: 204 })
}
