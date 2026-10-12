/**
 * The Call Center's phone status pill (top right of the desk): one light for
 * "can this browser make and take calls right now".
 *
 *   green  Phone ready, or a call in progress
 *   amber  Connecting… while the phone starts or reconnects by itself
 *   red    Phone off: browser calling isn't set up, there is no line to call
 *          from, or the phone service dropped and hasn't come back
 *
 * The reason is the plain-English line the pill's sheet shows. It replaces
 * the desk's old header note and preview banner.
 */

export type PhoneTone = 'green' | 'amber' | 'red'

export type PhoneStatus = {
  tone: PhoneTone
  label: string
  /** One plain-English sentence for the sheet, or null when there is nothing to explain. */
  reason: string | null
}

/** What the pill reads from `useVoice()`; null when the voice provider is absent. */
export type PhoneStatusInput = {
  mode: 'twilio' | 'mock'
  lines: number
  leader: boolean
  registered: boolean
  status: 'idle' | 'connecting' | 'ringing' | 'in-call'
  /** A phone-level problem (not one call's): the service dropped, the session expired. */
  issue: string | null
}

export const PHONE_OFF_REASON = "Calling from the browser isn't set up for this account."

export function phoneStatus(voice: PhoneStatusInput | null, voiceNote?: string | null): PhoneStatus {
  if (!voice) return { tone: 'red', label: 'Phone off', reason: voiceNote?.trim() || PHONE_OFF_REASON }
  if (voice.status === 'in-call') return { tone: 'green', label: 'On a call', reason: null }
  if (voice.status !== 'idle') return { tone: 'green', label: 'Calling…', reason: null }
  // A phone that dropped says so first: it is the problem happening right now.
  if (voice.leader && !voice.registered && voice.issue) return { tone: 'red', label: 'Phone off', reason: voice.issue }
  if (voice.lines === 0) {
    return { tone: 'red', label: 'Phone off', reason: 'This account has no phone line to call from yet.' }
  }
  const test = voice.mode === 'mock' ? 'Test mode. No real calls are placed.' : null
  // Another tab of this app holds the phone and rings; this one calls through the same account.
  if (!voice.leader) {
    return { tone: 'green', label: 'Phone ready', reason: test ?? 'Calls ring in your other tab of this app.' }
  }
  if (voice.registered) return { tone: 'green', label: 'Phone ready', reason: test }
  return { tone: 'amber', label: 'Connecting…', reason: 'Starting the phone. This takes a few seconds.' }
}

/** The access token was refused or ran out: a fresh one fixes it without a reload. */
export const TOKEN_ERROR_CODES: ReadonlySet<number> = new Set([20101, 20104, 31204, 31205])

export const LOST_SERVICE = 'Lost the connection to the phone service. It reconnects by itself when the internet is back.'

/**
 * A Device error that belongs to no call, in plain words for the pill. The
 * SDK raises these when its signalling socket drops (Wi-Fi blip, laptop
 * sleep, network change) and then reconnects on its own, so they are a
 * status, not an alert: the pill shows them until the phone registers again.
 */
export function phoneIssueFrom(err: unknown): string {
  const e = err as { code?: number; name?: string } | null
  const code = typeof e?.code === 'number' ? e.code : null
  if (e?.name === 'NotAllowedError' || code === 31401 || code === 31402 || code === 31208) {
    return 'Allow the microphone to make and take calls.'
  }
  if (code !== null && TOKEN_ERROR_CODES.has(code)) return 'Your phone session expired. Reload the page.'
  if (code === 31000 || code === 31003 || code === 31005 || code === 31009 || (code !== null && code >= 53000 && code < 54000)) {
    return LOST_SERVICE
  }
  return code ? `The phone stopped working (code ${code}). Reload the page.` : 'The phone stopped working. Reload the page.'
}
