import 'server-only'
import { db } from '@/lib/db'
import { isPlatformAccount } from './index'
import { matchCallerToClient, teamDialTargets, type InboundNumber } from './calls'
import { phoneHashOrNull, maskedLast4 } from './compliance-core'
import { voiceLimited } from './account-status'
import { ringsBrowsers } from './lines'
import { presentUsersFor } from './presence'
import { telephonySettingsFor, withinBusinessHours } from './settings'
import {
  browserDialTwiml,
  callbackOfferTwiml,
  teamStepTwiml,
  voiceAnswerTwiml,
  voicemailTwiml,
  type BrowserLeg,
  greetingFor,
} from './twiml'
import { activeLegs, startInboundCall, withAccountLock } from './voice-calls'
import { voiceBrowserEnabled } from './voice-config'
import { callbackUrls, type WebhookContext } from './webhook'

/**
 * What an inbound call does, stage by stage (docs/TELEPHONY_LIVE.md §2.5):
 *
 *   outside business hours        → voicemail
 *   voice-limited, another leg up → voicemail (the account can't hold two)
 *   browsers ready (P0b)          → ring up to 5 (1 while limited)   stage=browser
 *   FORWARD                       → ring one number                  stage=forward
 *   TEAM                          → ring teammate 0, then 1, …       stage=team&i=n
 *   otherwise / end of every chain → voicemail
 *
 * When a ringing stage (browser, forward, team) ends unanswered and the next
 * stage is voicemail, the caller is first offered "press 1 for a callback"
 * (docs/DIALER_POWER.md Lane C). Silence or any other key is today's
 * voicemail. Voicemails are transcribed unless the account turned it off.
 *
 * The first answer is decided here; each later one by the dial route through
 * nextStage(). While the account is voice-limited the inbound row is written
 * INLINE under the account's advisory lock, because the next caller's stage
 * decision depends on this one being counted.
 */

export type Stage =
  | { kind: 'browser'; legs: BrowserLeg[] }
  | { kind: 'forward'; to: string }
  | { kind: 'team'; i: number; to: string; userId: string }
  | { kind: 'voicemail' }

type StageCtx = { number: InboundNumber; from: string; callSid: string; accountSid: string; platform: boolean }

async function browserStage(ctx: StageCtx, limited: boolean): Promise<Stage | null> {
  if (!voiceBrowserEnabled() || !ctx.platform || !ringsBrowsers(ctx.number)) return null
  const client = await matchCallerToClient(ctx.number.organizationId, ctx.from)
  const present = await presentUsersFor(ctx.number, client?.ownerId ?? null)
  if (present.length === 0) return null

  const hash = phoneHashOrNull(ctx.from)
  const lead =
    !client && hash
      ? await db.callCenterLead.findFirst({
          where: { organizationId: ctx.number.organizationId, phoneHash: hash },
          select: { id: true },
        })
      : null
  const params = {
    pfCallId: ctx.callSid,
    pfCaller: client ? `${client.firstName} ${client.lastName}`.trim() : maskedLast4(ctx.from),
    pfLine: ctx.number.friendlyName,
    pfTarget: client ? `client:${client.id}` : lead ? `lead:${lead.id}` : '',
  }
  const legs = present.slice(0, limited ? 1 : present.length).map((p) => ({ identity: p.identity, params }))
  return { kind: 'browser', legs }
}

/** The line's own routing, from the start (no browser stage). */
async function routingStage(number: InboundNumber, fromTeamIndex = 0): Promise<Stage> {
  if (number.routing === 'FORWARD' && number.forwardTo) return { kind: 'forward', to: number.forwardTo }
  if (number.routing === 'TEAM') {
    const team = await teamDialTargets(number)
    const next = team[fromTeamIndex]
    if (next) return { kind: 'team', i: fromTeamIndex, to: next.e164, userId: next.userId }
  }
  return { kind: 'voicemail' }
}

export function stageName(stage: Stage): string {
  return stage.kind
}

type TwimlOpts = {
  skipGreeting: boolean
  limited: boolean
  /** Ask Twilio to transcribe the voicemail (settings.telephony.transcribeVoicemail). */
  transcribe?: boolean
  /** A ringing stage just failed: offer press-1-for-a-callback before voicemail. */
  offerCallback?: boolean
}

/** The voicemail answer for a line, with or without the greeting and callback offer. */
export function voicemailAnswerTwiml(
  number: Pick<InboundNumber, 'voicemailGreeting' | 'recordCalls'>,
  callSid: string,
  opts: { skipGreeting: boolean; transcribe?: boolean; offerCallback?: boolean },
): string {
  const base = callbackUrls(callSid)
  const transcribeCallbackUrl = opts.transcribe && callSid ? base.transcription : null
  if (opts.offerCallback && callSid) {
    const lead = opts.skipGreeting
      ? ''
      : greetingFor({ greeting: number.voicemailGreeting, recordCalls: number.recordCalls, skipGreeting: false })
    return callbackOfferTwiml({ gatherActionUrl: base.callback, voicemailCallbackUrl: base.voicemail, transcribeCallbackUrl, lead })
  }
  return voicemailTwiml({
    voicemailCallbackUrl: base.voicemail,
    greeting: number.voicemailGreeting,
    recordCalls: number.recordCalls,
    skipGreeting: opts.skipGreeting,
    transcribeCallbackUrl,
  })
}

/** Transcription on unless the account turned it off; a failed read keeps the default. */
export async function transcribeVoicemailFor(organizationId: string): Promise<boolean> {
  try {
    return (await telephonySettingsFor(organizationId)).transcribeVoicemail
  } catch {
    return true
  }
}

function twimlFor(stage: Stage, ctx: StageCtx, opts: TwimlOpts): string {
  const { number, callSid } = ctx
  const greeting = number.voicemailGreeting
  const transcribeCallbackUrl = opts.transcribe && callSid ? callbackUrls(callSid).transcription : null
  if (stage.kind === 'voicemail') {
    return voicemailAnswerTwiml(number, callSid, opts)
  }
  if (stage.kind === 'browser') {
    const urls = callbackUrls(callSid, { stage: 'browser' })
    return browserDialTwiml({
      legs: stage.legs,
      actionUrl: urls.dial,
      recordCalls: number.recordCalls,
      greeting,
      callRecordingUrl: urls.callRecording,
      childStatusUrl: urls.childStatus,
      limited: opts.limited,
    })
  }
  if (stage.kind === 'forward') {
    const urls = callbackUrls(callSid, { stage: 'forward' })
    return voiceAnswerTwiml({
      routing: 'FORWARD',
      forwardTo: stage.to,
      recordCalls: number.recordCalls,
      greeting,
      voicemailCallbackUrl: urls.voicemail,
      actionUrl: urls.dial,
      callRecordingUrl: urls.callRecording,
      childStatusUrl: urls.childStatus,
      skipGreeting: opts.skipGreeting,
      transcribeCallbackUrl,
    })
  }
  const urls = callbackUrls(callSid, { stage: 'team', i: stage.i })
  if (opts.skipGreeting) {
    return teamStepTwiml({
      number: stage.to,
      actionUrl: urls.dial,
      recordCalls: number.recordCalls,
      callRecordingUrl: urls.callRecording,
      childStatusUrl: urls.childStatus,
    })
  }
  return voiceAnswerTwiml({
    routing: 'TEAM',
    teamNumbers: [stage.to],
    recordCalls: number.recordCalls,
    greeting,
    voicemailCallbackUrl: urls.voicemail,
    actionUrl: urls.dial,
    callRecordingUrl: urls.callRecording,
    childStatusUrl: urls.childStatus,
    transcribeCallbackUrl,
  })
}

export type InboundAnswer = {
  twiml: string
  stage: string
  /** True when the VoiceCall row was already written inline (voice-limited path). */
  rowWritten: boolean
}

/** The first answer to a ringing call. */
export async function answerInboundCall(ctx: WebhookContext, now = new Date()): Promise<InboundAnswer> {
  const callSid = ctx.params.CallSid ?? ''
  const sctx: StageCtx = {
    number: ctx.number,
    from: ctx.from,
    callSid,
    accountSid: ctx.accountSid,
    platform: isPlatformAccount(ctx.creds),
  }

  const settings = await telephonySettingsFor(ctx.number.organizationId)
  if (!withinBusinessHours(settings.businessHours, settings.timezone, now)) {
    return {
      // After hours: still offer the callback, so the request waits in Missed for the morning.
      twiml: twimlFor({ kind: 'voicemail' }, sctx, { skipGreeting: false, limited: false, transcribe: settings.transcribeVoicemail, offerCallback: true }),
      stage: 'voicemail',
      rowWritten: false,
    }
  }

  const limited = await voiceLimited(ctx.accountSid, now)
  let stage: Stage = (await browserStage(sctx, limited)) ?? (await routingStage(ctx.number))

  let rowWritten = false
  if (limited && callSid) {
    // Count and insert under one lock: two calls arriving together can't both
    // take the account's single leg.
    stage = await withAccountLock(ctx.accountSid, async (tx) => {
      const busy = stage.kind !== 'voicemail' && (await activeLegs(tx, ctx.accountSid, now, callSid)) >= 1
      const decided: Stage = busy ? { kind: 'voicemail' } : stage
      await startInboundCall(
        {
          organizationId: ctx.number.organizationId,
          accountSid: ctx.accountSid,
          callSid,
          phoneNumberId: ctx.number.id,
          lineE164: ctx.number.e164,
          from: ctx.from,
          stage: stageName(decided),
          recordingExpected: ctx.number.recordCalls,
          stirVerstat: ctx.params.StirVerstat ?? null,
        },
        tx,
      )
      return decided
    })
    rowWritten = true
  }

  return {
    // A voicemail-only line (or nobody to ring) offers the callback up front.
    twiml: twimlFor(stage, sctx, { skipGreeting: false, limited, transcribe: settings.transcribeVoicemail, offerCallback: stage.kind === 'voicemail' }),
    stage: stageName(stage),
    rowWritten,
  }
}

/**
 * After a <Dial> stage nobody answered: the next stage. browser → the line's
 * routing; forward → voicemail; team i → teammate i+1, then voicemail. While
 * limited, a ringing stage is only started when no other leg is up.
 */
export async function nextInboundStage(
  ctx: WebhookContext,
  current: { stage: string; i: number },
  now = new Date(),
): Promise<InboundAnswer> {
  const callSid = ctx.params.CallSid ?? ''
  const sctx: StageCtx = {
    number: ctx.number,
    from: ctx.from,
    callSid,
    accountSid: ctx.accountSid,
    platform: isPlatformAccount(ctx.creds),
  }
  let next: Stage
  if (current.stage === 'browser') next = await routingStage(ctx.number)
  else if (current.stage === 'team') next = await routingStage(ctx.number, current.i + 1)
  else next = { kind: 'voicemail' }
  // TEAM continues only within TEAM: a FORWARD line has no "next forward".
  if (current.stage === 'team' && next.kind === 'forward') next = { kind: 'voicemail' }

  const limited = next.kind !== 'voicemail' && (await voiceLimited(ctx.accountSid, now))
  if (limited && callSid) {
    const busy = await withAccountLock(ctx.accountSid, async (tx) => {
      const legs = await activeLegs(tx, ctx.accountSid, now, callSid)
      const isBusy = legs >= 1
      await tx.voiceCall.updateMany({ where: { callSid }, data: { stage: isBusy ? 'voicemail' : stageName(next) } })
      return isBusy
    })
    if (busy) next = { kind: 'voicemail' }
  } else if (callSid) {
    await db.voiceCall.updateMany({ where: { callSid }, data: { stage: stageName(next) } })
  }

  // Something rang and nobody took it: offer the callback before voicemail.
  const rang = current.stage === 'browser' || current.stage === 'forward' || current.stage === 'team'
  const transcribe = await transcribeVoicemailFor(ctx.number.organizationId)
  return {
    twiml: twimlFor(next, sctx, { skipGreeting: true, limited, transcribe, offerCallback: rang && next.kind === 'voicemail' }),
    stage: stageName(next),
    rowWritten: true,
  }
}

/** answeredBy for a dial stage that was answered. */
export async function answeredByFor(number: InboundNumber, stage: string, i: number): Promise<string | null> {
  if (stage === 'forward') return 'forward'
  if (stage === 'team') {
    const team = await teamDialTargets(number)
    return team[i] ? `team:${team[i].userId}` : 'team'
  }
  return null
}
