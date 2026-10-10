import type { TelephonyCredentials } from './provider'

/**
 * Fetching a call recording for playback (docs/TELEPHONY_LIVE.md §2.6).
 *
 * Only the RecordingSid is stored; the media URL is REBUILT here from the
 * call's own account SID, never taken from a stored URL or the browser:
 *
 *   https://api.twilio.com/2010-04-01/Accounts/<VoiceCall.accountSid>/Recordings/<RE…>.mp3
 *
 * plus ?RequestedChannels=1 (a mono mix — a dual-channel file sounds one-sided
 * on one earbud). Checks before any fetch: the SID matches ^RE[0-9a-f]{32}$,
 * and the credentials are for the SAME account as the call. Redirects are
 * followed by hand (at most two hops), only to https hosts on the allowlist,
 * and WITHOUT the Authorization header. The body is passed through as a
 * stream with the Range headers, so iOS Safari gets its 206 and nothing large
 * is buffered on Vercel.
 *
 * TODO(live check §9 step 12e): record the exact redirect host and narrow the
 * allowlist to it; confirm whether Twilio honours Range on the mono mix.
 */

export const RECORDING_SID_RE = /^RE[0-9a-f]{32}$/
const ACCOUNT_SID_RE = /^AC[0-9a-zA-Z]{32}$/

const ALLOWED_SUFFIXES = ['.twilio.com', '.twiliocdn.com', '.amazonaws.com']
export const MAX_REDIRECTS = 2
export const FETCH_TIMEOUT_MS = 20_000

export function mediaHostAllowed(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return ALLOWED_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)
}

export type MediaRequest = { url: string; headers: Record<string, string> }

export function recordingMediaRequest(
  call: { accountSid: string; recordingSid: string | null },
  creds: TelephonyCredentials | null,
  opts: { mono: boolean; range?: string | null },
): { ok: true; request: MediaRequest } | { ok: false; reason: 'bad_sid' | 'account_mismatch' | 'no_credentials' } {
  if (!call.recordingSid || !RECORDING_SID_RE.test(call.recordingSid)) return { ok: false, reason: 'bad_sid' }
  if (!creds) return { ok: false, reason: 'no_credentials' }
  if (creds.accountSid !== call.accountSid || !ACCOUNT_SID_RE.test(call.accountSid)) return { ok: false, reason: 'account_mismatch' }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${call.accountSid}/Recordings/${call.recordingSid}.mp3${opts.mono ? '?RequestedChannels=1' : ''}`
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`,
  }
  if (opts.range && /^bytes=\d*-\d*(,\s*\d*-\d*)*$/.test(opts.range.trim())) headers.Range = opts.range.trim()
  return { ok: true, request: { url, headers } }
}

export type MediaResult =
  | { ok: true; status: number; headers: Headers; body: ReadableStream<Uint8Array> | null }
  | { ok: false; status: number; reason: string }

/**
 * Fetch with manual redirects. Auth goes ONLY to api.twilio.com on the first
 * hop; every redirect hop is a fresh request with no Authorization header.
 */
export async function fetchRecordingMedia(
  request: MediaRequest,
  opts: { method?: 'GET' | 'HEAD'; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<MediaResult> {
  const doFetch = opts.fetchImpl ?? fetch
  const method = opts.method ?? 'GET'
  const signal = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS)
  const range = request.headers.Range
  let url = request.url
  let headers: Record<string, string> = { ...request.headers }
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const res = await doFetch(url, { method, headers, redirect: 'manual', signal })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) return { ok: false, status: 502, reason: 'Redirect without a location.' }
        const next = new URL(location, url).toString()
        if (!mediaHostAllowed(next)) return { ok: false, status: 502, reason: 'Redirect to a host that is not allowed.' }
        if (hop === MAX_REDIRECTS) return { ok: false, status: 502, reason: 'Too many redirects.' }
        url = next
        headers = range ? { Range: range } : {}
        continue
      }
      if (res.status === 200 || res.status === 206) return { ok: true, status: res.status, headers: res.headers, body: res.body }
      if (res.status === 404) return { ok: false, status: 404, reason: 'Recording not found at the carrier.' }
      if (res.status === 416) return { ok: false, status: 416, reason: 'Range not satisfiable.' }
      return { ok: false, status: 502, reason: `Carrier answered ${res.status}.` }
    }
    return { ok: false, status: 502, reason: 'Too many redirects.' }
  } catch {
    return { ok: false, status: 504, reason: 'The carrier did not answer in time.' }
  }
}
