import 'server-only'
import type { VoiceCall } from '@prisma/client'
import { db } from '@/lib/db'
import { decryptSecret, type EncryptedSecret } from '@/lib/crypto'
import { loadActor } from '@/lib/automation/actor'
import { can } from '@/lib/rbac'
import { maskPhone } from '@/lib/messaging/send'
import { voiceLimited } from './account-status'
import { decideOutbound, verifyOverride } from './compliance'
import { resolveCallerLine } from './lines'
import { telephonySettingsFor } from './settings'
import { parseTargetKey, resolveDialTarget, targetKey } from './targets'
import { outboundDialTwiml, sayAndHangup } from './twiml'
import { activeLegs, lockAccount, remoteParty } from './voice-calls'
import { voiceBrowserEnabled, FLAG_OFF } from './voice-config'
import { clientCallbackUrls, type ClientWebhookContext } from './webhook'

/**
 * The TwiML App's Voice URL (P0b, §2.3): a signed-in browser asked to place a
 * call. The browser sent only custom params — target, line, override — and
 * the server resolves everything else inside the caller's own org:
 *
 *   identity → user (active, in that org, communications:send)
 *   target   → the callee's number (scope-checked; never from the browser)
 *   line     → an honest caller ID that takes callbacks
 *   decideOutbound → consent, do-not-call, hours (override token verified,
 *                    its nonce single-use through VoiceCall.overrideNonce)
 *   then, under the account's advisory lock, the one-call-at-a-time count and
 *   the ledger insert — so two reps dialling at once can't both pass.
 *
 * Idempotent on CallSid: a replayed webhook gets the same TwiML, never a 500.
 */

export const COULD_NOT_PLACE = "We couldn't place this call."
export const LIMITED_BUSY =
  'Another call is in progress. Until Twilio approves the business profile, the account can place one call at a time.'

function dialFor(vc: Pick<VoiceCall, 'id' | 'lineE164' | 'remoteSecret' | 'recordingExpected'>, known?: string): string | null {
  let callee: string | null = known ?? null
  try {
    if (!callee) callee = vc.remoteSecret ? decryptSecret(vc.remoteSecret as unknown as EncryptedSecret) : null
  } catch {
    callee = null
  }
  if (!callee || !vc.lineE164) return null
  const urls = clientCallbackUrls(vc.id)
  return outboundDialTwiml({
    callerId: vc.lineE164,
    callee,
    actionUrl: urls.dial,
    statusUrl: urls.status,
    record: vc.recordingExpected === true,
    recordingStatusUrl: urls.recording,
    whisperUrl: urls.whisper,
  })
}

/** P2002, and which unique it hit. Driver adapters put the field in different places, so read them all. */
function isUniqueViolation(err: unknown): { target: string } | null {
  if (!err || typeof err !== 'object' || (err as { code?: string }).code !== 'P2002') return null
  const e = err as { meta?: unknown; message?: unknown }
  let meta = ''
  try {
    meta = JSON.stringify(e.meta ?? {})
  } catch {
    meta = ''
  }
  return { target: `${meta} ${typeof e.message === 'string' ? e.message : ''}` }
}

export async function placeBrowserCall(ctx: ClientWebhookContext, now = new Date()): Promise<string> {
  if (!voiceBrowserEnabled()) return sayAndHangup(FLAG_OFF)
  const callSid = ctx.params.CallSid ?? ''
  if (!callSid || !ctx.userId) return sayAndHangup(COULD_NOT_PLACE)

  const replay = await db.voiceCall.findUnique({ where: { callSid } })
  if (replay) return dialFor(replay) ?? sayAndHangup(COULD_NOT_PLACE)

  const actor = await loadActor(ctx.userId)
  if (!actor || actor.organizationId !== ctx.organizationId || !can(actor, 'communications:send')) {
    return sayAndHangup(COULD_NOT_PLACE)
  }

  const target = parseTargetKey(ctx.params.target)
  if (!target) return sayAndHangup(COULD_NOT_PLACE)
  const resolved = await resolveDialTarget(actor, target, now)
  if (!resolved.ok) return sayAndHangup(resolved.reason)
  const t = resolved.target

  const line = await resolveCallerLine(actor, ctx.params.line || null)
  if (!line.ok) return sayAndHangup(line.reason)

  const input = {
    organizationId: actor.organizationId,
    channel: 'CALL' as const,
    purpose: t.purpose,
    phone: t.phone,
    servicingBasis: t.servicingBasis,
    clientId: t.clientId,
    leadId: t.leadId,
    zoneHints: t.zoneHints,
  }
  let decision = await decideOutbound(input, { actor, now })
  let overrideNonce: string | null = null
  if (!decision.allowed && decision.code === 'OUTSIDE_HOURS' && decision.canOverride === 'hours' && ctx.params.override && can(actor, 'telephony:manage')) {
    const check = verifyOverride(
      ctx.params.override,
      { orgId: actor.organizationId, userId: actor.id, target: targetKey(target), lineId: line.line.id, code: 'OUTSIDE_HOURS' },
      now,
    )
    if (check.ok) {
      decision = await decideOutbound(input, { actor, now, override: true })
      if (decision.allowed) overrideNonce = check.nonce
    }
  }
  if (!decision.allowed) return sayAndHangup(decision.reason)

  const settings = await telephonySettingsFor(actor.organizationId)
  const limited = await voiceLimited(ctx.accountSid, now)
  const remote = remoteParty(decision.e164)

  try {
    const outcome = await db.$transaction(async (tx) => {
      await lockAccount(tx, ctx.accountSid)
      if (limited && (await activeLegs(tx, ctx.accountSid, now, callSid)) >= 1) return { busy: true as const }

      let communicationId: string | null = null
      if (t.clientId) {
        const comm = await tx.communication.create({
          data: {
            clientId: t.clientId,
            userId: actor.id,
            channel: 'CALL',
            direction: 'OUTBOUND',
            status: 'SENT',
            body: `Call from ${line.line.label}.`,
            externalRef: callSid,
            occurredAt: now,
            call: { create: { toMasked: maskPhone(decision.e164), fromMasked: maskPhone(line.line.e164), outcome: 'NO_ANSWER' } },
          },
          select: { id: true },
        })
        communicationId = comm.id
        await tx.client.update({ where: { id: t.clientId }, data: { lastActivityAt: now } })
      }
      const vc = await tx.voiceCall.create({
        data: {
          organizationId: actor.organizationId,
          callSid,
          accountSid: ctx.accountSid,
          direction: 'OUTBOUND',
          purpose: decision.purpose,
          stage: 'bridged',
          status: 'initiated',
          phoneNumberId: line.line.id,
          lineE164: line.line.e164,
          ...remote,
          clientId: t.clientId,
          communicationId,
          callCenterLeadId: t.leadId,
          userId: actor.id,
          basis: decision.basis.slice(0, 300),
          overrideNonce,
          recordingExpected: settings.recordOutbound || null,
          startedAt: now,
        },
      })
      return { busy: false as const, vc }
    })
    if (outcome.busy) return sayAndHangup(LIMITED_BUSY)
    return dialFor(outcome.vc, decision.e164) ?? sayAndHangup(COULD_NOT_PLACE)
  } catch (err) {
    const dupe = isUniqueViolation(err)
    if (dupe && dupe.target.includes('overrideNonce')) return sayAndHangup('That override was already used. Ask again.')
    if (dupe) {
      const raced = await db.voiceCall.findUnique({ where: { callSid } })
      if (raced) return dialFor(raced) ?? sayAndHangup(COULD_NOT_PLACE)
    }
    throw err
  }
}

/** Spoken to the rep when an outbound dial didn't connect. Plain words, 10004 explained. */
export function dialFailureSpeech(dialStatus: string, errorCode: string | null): string | null {
  const s = dialStatus.toLowerCase()
  if (s === 'completed' || s === 'answered') return null
  if (errorCode === '10004') {
    return 'This call could not start. Twilio allows one call at a time on this account until the business profile is approved. Try again when the other call ends.'
  }
  if (s === 'busy') return 'The line is busy.'
  if (s === 'no-answer') return 'No answer.'
  if (s === 'canceled') return 'The call was cancelled.'
  return "The call didn't go through."
}

