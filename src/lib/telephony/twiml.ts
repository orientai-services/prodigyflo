import type { CallRouting } from '@prisma/client'

/**
 * TwiML — the XML answer the carrier asks for the instant a customer's call
 * connects. Pure string building on purpose: what a caller hears is a
 * behaviour worth testing, and testing it should not need a phone.
 *
 * Inbound shapes, one per routing mode:
 *
 *   browser stage  (when anyone is signed in and ready) ring up to five
 *                  browsers at once, then fall into the line's routing
 *   FORWARD        greet, ring one number, fall through to voicemail
 *   TEAM           greet, ring ONE teammate; the dial action rings the next
 *                  one in turn (one <Dial> per teammate, chained through
 *                  ?stage=team&i=n), then voicemail. Sequential on purpose:
 *                  ringing everyone at once double-books the team and, while
 *                  the account allows one call at a time, fails outright.
 *   VOICEMAIL_ONLY greet and record
 *
 * Every shape ends at voicemail, because a business line that rings out into
 * silence loses the lead. Recording is opt-in per number (recordCalls) and the
 * greeting says so when it is on — one-party-consent is not the rule
 * everywhere, and the announcement is what makes the recording safe to keep.
 *
 * Outbound (browser calls): one <Dial> with an honest callerId, and — only
 * when outbound recording is on — a whisper that sends the recording notice to
 * the callee on answer.
 */

export const DEFAULT_GREETING = 'Thanks for calling. Please hold while we connect you.'
export const DEFAULT_VOICEMAIL_PROMPT =
  'Sorry we missed you. Leave your name, number, and a short message after the tone, and we will call you right back.'
export const RECORDING_NOTICE = 'This call may be recorded for quality.'
export const CALLBACK_PROMPT = 'To have us call you back, press 1. Or stay on the line to leave a message.'
export const CALLBACK_CONFIRMED = 'Thank you. We will call you back as soon as we can. Goodbye.'
/** Seconds the callback offer waits for a key before falling through to voicemail. */
export const CALLBACK_GATHER_SECONDS = 5

/** Seconds each leg rings before moving on. */
export const RING_SECONDS = 20
/** Longest voicemail we keep. */
export const VOICEMAIL_MAX_SECONDS = 120
/** Browsers rung at once on an inbound call. */
export const MAX_BROWSER_LEGS = 5
/** Seconds an outbound browser call rings the callee. */
export const OUTBOUND_RING_SECONDS = 30

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function say(text: string): string {
  return `<Say voice="Polly.Joanna">${escapeXml(text)}</Say>`
}

function document(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`
}

function attrs(pairs: [string, string | number | null | undefined | false][]): string {
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== false && v !== '')
    .map(([k, v]) => `${k}="${escapeXml(String(v))}"`)
    .join(' ')
}

export type VoiceRouteConfig = {
  routing: CallRouting
  /** FORWARD: the single number to ring. */
  forwardTo?: string | null
  /** TEAM: E.164 numbers of the teammates to ring, in dial order. Only the first is rung here. */
  teamNumbers?: string[]
  recordCalls: boolean
  greeting?: string | null
  /** Absolute URL the recorded voicemail is posted back to. */
  voicemailCallbackUrl: string
  /** Absolute URL that Twilio posts the dial outcome to. */
  actionUrl: string
  /** Absolute URL for the recording of an answered call (kind=call). */
  callRecordingUrl?: string
  /** Absolute URL for the answered child leg's status (who picked up). */
  childStatusUrl?: string
  /** Skip the spoken greeting (it was already said in an earlier stage). */
  skipGreeting?: boolean
  /** Signed transcription callback for the voicemail; absent → no transcription. */
  transcribeCallbackUrl?: string | null
}

export function greetingFor(config: Pick<VoiceRouteConfig, 'greeting' | 'recordCalls' | 'skipGreeting'>): string {
  if (config.skipGreeting) return ''
  const greeting = config.greeting?.trim() || DEFAULT_GREETING
  const notice = config.recordCalls ? ` ${RECORDING_NOTICE}` : ''
  return say(`${greeting}${notice}`)
}

function dialOpen(config: {
  actionUrl: string
  recordCalls: boolean
  callRecordingUrl?: string
  timeout?: number
}): string {
  return `<Dial ${attrs([
    ['timeout', config.timeout ?? RING_SECONDS],
    ['action', config.actionUrl],
    ['method', 'POST'],
    ['answerOnBridge', 'true'],
    ['record', config.recordCalls ? 'record-from-answer-dual' : null],
    ['recordingStatusCallback', config.recordCalls ? config.callRecordingUrl ?? null : null],
    ['recordingStatusCallbackMethod', config.recordCalls && config.callRecordingUrl ? 'POST' : null],
  ])}>`
}

function numberNoun(e164: string, childStatusUrl?: string): string {
  const a = childStatusUrl
    ? ` ${attrs([
        ['statusCallback', childStatusUrl],
        ['statusCallbackEvent', 'answered completed'],
        ['statusCallbackMethod', 'POST'],
      ])}`
    : ''
  return `<Number${a}>${escapeXml(e164)}</Number>`
}

/**
 * The answer for an incoming call's routing stage. `actionUrl` receives the
 * result of the dial so an unanswered call continues (to the next teammate, or
 * voicemail) rather than hanging up — a <Dial> that nobody picks up falls
 * through only when the dial itself completes, which is what action= gives us.
 */
export function voiceAnswerTwiml(config: VoiceRouteConfig): string {
  if (config.routing === 'VOICEMAIL_ONLY') {
    return document(greetingFor(config) + voicemailBody(config))
  }

  const target =
    config.routing === 'FORWARD'
      ? config.forwardTo || null
      : (config.teamNumbers ?? []).filter(Boolean)[0] ?? null

  // A misconfigured line still answers: voicemail beats a dead tone.
  if (!target) {
    return document(greetingFor(config) + voicemailBody(config))
  }

  return document(`${greetingFor(config)}${dialOpen(config)}${numberNoun(target, config.childStatusUrl)}</Dial>`)
}

/** One TEAM step: ring teammate `number` (already chosen by index), no greeting. */
export function teamStepTwiml(config: {
  number: string
  actionUrl: string
  recordCalls: boolean
  callRecordingUrl?: string
  childStatusUrl?: string
}): string {
  return document(`${dialOpen(config)}${numberNoun(config.number, config.childStatusUrl)}</Dial>`)
}

export type BrowserLeg = {
  identity: string
  params: Record<string, string>
}

/**
 * The browser stage of an inbound call: up to five signed-in browsers ring at
 * once (exactly one while the account is limited to one call at a time). Each
 * leg carries <Parameter>s the incoming banner shows.
 */
export function browserDialTwiml(config: {
  legs: BrowserLeg[]
  actionUrl: string
  recordCalls: boolean
  greeting?: string | null
  callRecordingUrl?: string
  childStatusUrl?: string
  /** One call at a time: ring only the first browser. */
  limited?: boolean
}): string {
  const legs = config.legs.slice(0, config.limited ? 1 : MAX_BROWSER_LEGS)
  const clients = legs
    .map((leg) => {
      const status = config.childStatusUrl
        ? ` ${attrs([
            ['statusCallback', config.childStatusUrl],
            ['statusCallbackEvent', 'answered completed'],
            ['statusCallbackMethod', 'POST'],
          ])}`
        : ''
      const params = Object.entries(leg.params)
        // `value` is required even when empty (Twilio warns 12200 otherwise), so it bypasses attrs().
        .map(([name, value]) => `<Parameter ${attrs([['name', name]])} value="${escapeXml(String(value ?? ''))}"/>`)
        .join('')
      return `<Client${status}><Identity>${escapeXml(leg.identity)}</Identity>${params}</Client>`
    })
    .join('')
  return document(
    `${greetingFor({ greeting: config.greeting, recordCalls: config.recordCalls })}${dialOpen(config)}${clients}</Dial>`,
  )
}

/** Greeting (when still due) then voicemail — the end of every chain. */
export function voicemailTwiml(config: {
  voicemailCallbackUrl: string
  greeting?: string | null
  recordCalls?: boolean
  skipGreeting?: boolean
  /** Signed transcription callback; absent → no transcription (as before). */
  transcribeCallbackUrl?: string | null
}): string {
  return document(
    greetingFor({ greeting: config.greeting, recordCalls: Boolean(config.recordCalls), skipGreeting: config.skipGreeting }) +
      voicemailBody(config),
  )
}

/**
 * The end of a ring chain nobody answered: offer a callback, then voicemail.
 *
 * The <Gather> has no actionOnEmptyResult, so a timeout (or no key at all)
 * falls straight through to the voicemail verbs that follow it in THIS
 * document — the caller who stays on the line gets exactly today's voicemail
 * without another round trip to us. Only a pressed key posts to the action
 * route, which answers 1 with a confirmation and anything else with
 * voicemail. After a ring chain there is no greeting or recording notice here:
 * both were already said when the call was first answered. When the offer IS
 * the first answer, the caller passes them in as `lead`.
 */
export function callbackOfferTwiml(config: {
  gatherActionUrl: string
  voicemailCallbackUrl: string
  transcribeCallbackUrl?: string | null
  /** Greeting + recording notice when the offer is the call's first answer (voicemail-only line, after hours). */
  lead?: string
}): string {
  const gather = `<Gather ${attrs([
    ['input', 'dtmf'],
    ['numDigits', 1],
    ['timeout', CALLBACK_GATHER_SECONDS],
    ['action', config.gatherActionUrl],
    ['method', 'POST'],
  ])}>${say(CALLBACK_PROMPT)}</Gather>`
  return document((config.lead ?? '') + gather + voicemailBody(config))
}

/** The caller pressed 1: confirm and hang up. */
export function callbackConfirmedTwiml(): string {
  return document(say(CALLBACK_CONFIRMED) + '<Hangup/>')
}

/**
 * `action` and `recordingStatusCallback` both point at the recording route
 * (kind=voicemail); it is idempotent on the RecordingSid, so the two posts
 * store one voicemail. With a transcription URL, Twilio transcribes the
 * message (English, recordings up to two minutes) and posts the text there.
 */
function voicemailBody(config: Pick<VoiceRouteConfig, 'voicemailCallbackUrl'> & { transcribeCallbackUrl?: string | null }): string {
  const transcribe = Boolean(config.transcribeCallbackUrl)
  return (
    say(DEFAULT_VOICEMAIL_PROMPT) +
    `<Record ${attrs([
      ['maxLength', VOICEMAIL_MAX_SECONDS],
      ['playBeep', 'true'],
      ['transcribe', transcribe ? 'true' : 'false'],
      ['transcribeCallback', transcribe ? config.transcribeCallbackUrl : null],
      ['action', config.voicemailCallbackUrl],
      ['method', 'POST'],
      ['recordingStatusCallback', config.voicemailCallbackUrl],
      ['recordingStatusCallbackMethod', 'POST'],
    ])} />` +
    say('We did not get a message. Goodbye.') +
    '<Hangup/>'
  )
}

/** The follow-up answer after a dial that nobody picked up. */
export function noAnswerTwiml(config: Pick<VoiceRouteConfig, 'voicemailCallbackUrl' | 'actionUrl' | 'routing' | 'recordCalls'>): string {
  return document(voicemailBody(config))
}

/**
 * An outbound browser call (P0b). The callerId is a line of the same account
 * that can take callbacks; the callee's number was resolved on the server.
 */
export function outboundDialTwiml(config: {
  callerId: string
  callee: string
  actionUrl: string
  statusUrl: string
  record: boolean
  recordingStatusUrl: string
  whisperUrl: string
}): string {
  const dial = `<Dial ${attrs([
    ['callerId', config.callerId],
    ['answerOnBridge', 'true'],
    ['timeout', OUTBOUND_RING_SECONDS],
    ['action', config.actionUrl],
    ['method', 'POST'],
    ['record', config.record ? 'record-from-answer-dual' : null],
    ['recordingStatusCallback', config.record ? config.recordingStatusUrl : null],
    ['recordingStatusCallbackMethod', config.record ? 'POST' : null],
  ])}>`
  const number = `<Number ${attrs([
    ['url', config.record ? config.whisperUrl : null],
    ['statusCallback', config.statusUrl],
    ['statusCallbackEvent', 'initiated ringing answered completed'],
    ['statusCallbackMethod', 'POST'],
  ])}>${escapeXml(config.callee)}</Number>`
  return document(`${dial}${number}</Dial>`)
}

/** Played to the callee on answer, before they are bridged. */
export function whisperTwiml(): string {
  return document(say(RECORDING_NOTICE))
}

/** Say the plain reason, then hang up. Every refusal on a call ends this way. */
export function sayAndHangup(reason: string): string {
  return document(say(reason) + '<Hangup/>')
}

/** A polite dead end — used when a number posts to us that we no longer own. */
export function rejectTwiml(message = 'This number is no longer in service. Goodbye.'): string {
  return document(say(message) + '<Hangup/>')
}

/** An empty, valid answer. Twilio needs a 200 with TwiML, never a bare 200. */
export function emptyTwiml(): string {
  return document('')
}

export const TWIML_CONTENT_TYPE = 'text/xml; charset=utf-8'
