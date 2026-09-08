import type { CallRouting } from '@prisma/client'

/**
 * TwiML — the XML answer the carrier asks for the instant a customer's call
 * connects. Pure string building on purpose: what a caller hears is a
 * behaviour worth testing, and testing it should not need a phone.
 *
 * Three shapes, one per routing mode:
 *
 *   FORWARD        greet, ring one number, fall through to voicemail
 *   TEAM           greet, ring each teammate in turn, fall through to voicemail
 *   VOICEMAIL_ONLY greet and record
 *
 * Every shape ends at voicemail, because a business line that rings out into
 * silence loses the lead. Recording is opt-in per number (recordCalls) and the
 * greeting says so when it is on — one-party-consent is not the rule
 * everywhere, and the announcement is what makes the recording safe to keep.
 */

export const DEFAULT_GREETING = 'Thanks for calling. Please hold while we connect you.'
export const DEFAULT_VOICEMAIL_PROMPT =
  'Sorry we missed you. Leave your name, number, and a short message after the tone, and we will call you right back.'
export const RECORDING_NOTICE = 'This call may be recorded for quality.'

/** Seconds each leg rings before moving on. */
export const RING_SECONDS = 20
/** Longest voicemail we keep. */
export const VOICEMAIL_MAX_SECONDS = 120

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

export type VoiceRouteConfig = {
  routing: CallRouting
  /** FORWARD: the single number to ring. */
  forwardTo?: string | null
  /** TEAM: E.164 numbers of the teammates to ring, in dial order. */
  teamNumbers?: string[]
  recordCalls: boolean
  greeting?: string | null
  /** Absolute URL the recorded voicemail is posted back to. */
  voicemailCallbackUrl: string
  /** Absolute URL that Twilio posts the dial outcome to. */
  actionUrl: string
}

/**
 * The answer for an incoming call. `actionUrl` receives the result of the dial
 * so an unanswered call continues into voicemail rather than hanging up — a
 * <Dial> that nobody picks up falls through to the next verb only when the
 * dial itself completes, which is exactly what action= gives us.
 */
export function voiceAnswerTwiml(config: VoiceRouteConfig): string {
  const greeting = config.greeting?.trim() || DEFAULT_GREETING
  const notice = config.recordCalls ? ` ${RECORDING_NOTICE}` : ''

  if (config.routing === 'VOICEMAIL_ONLY') {
    return document(say(`${greeting}${notice}`) + voicemailBody(config))
  }

  const targets =
    config.routing === 'FORWARD'
      ? [config.forwardTo].filter((n): n is string => Boolean(n))
      : (config.teamNumbers ?? []).filter(Boolean)

  // A misconfigured line still answers: voicemail beats a dead tone.
  if (targets.length === 0) {
    return document(say(`${greeting}${notice}`) + voicemailBody(config))
  }

  const dialAttrs = [
    `timeout="${RING_SECONDS}"`,
    `action="${escapeXml(config.actionUrl)}"`,
    'method="POST"',
    'answerOnBridge="true"',
    config.recordCalls ? 'record="record-from-answer-dual"' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const numbers = targets.map((n) => `<Number>${escapeXml(n)}</Number>`).join('')
  return document(`${say(`${greeting}${notice}`)}<Dial ${dialAttrs}>${numbers}</Dial>`)
}

function voicemailBody(config: VoiceRouteConfig): string {
  return (
    say(DEFAULT_VOICEMAIL_PROMPT) +
    `<Record maxLength="${VOICEMAIL_MAX_SECONDS}" playBeep="true" transcribe="false" ` +
    `action="${escapeXml(config.voicemailCallbackUrl)}" method="POST" recordingStatusCallback="${escapeXml(config.voicemailCallbackUrl)}" />` +
    say('We did not get a message. Goodbye.') +
    '<Hangup/>'
  )
}

/** The follow-up answer after a dial that nobody picked up. */
export function noAnswerTwiml(config: Pick<VoiceRouteConfig, 'voicemailCallbackUrl' | 'actionUrl' | 'routing' | 'recordCalls'>): string {
  return document(
    say(DEFAULT_VOICEMAIL_PROMPT) +
      `<Record maxLength="${VOICEMAIL_MAX_SECONDS}" playBeep="true" transcribe="false" ` +
      `action="${escapeXml(config.voicemailCallbackUrl)}" method="POST" recordingStatusCallback="${escapeXml(config.voicemailCallbackUrl)}" />` +
      '<Hangup/>',
  )
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
