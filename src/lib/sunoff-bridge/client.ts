import 'server-only'
import { signBridgeRequest, usableKey } from './sign'

/**
 * The only code that calls SunOff (docs/CYS_BRIDGE.md §B3). Server-only: the
 * URL and key come from the environment here and nowhere else.
 *
 *   SUNOFF_BRIDGE_URL     base URL, default https://sunoff.app
 *   PF_SUNOFF_BRIDGE_KEY  shared HMAC key (≥ 32 chars), see sign.ts
 *
 * SunOff answers `{ ok: true, ... }` on success and
 * `{ ok: false, error: <code>, message: <text> }` otherwise (the same shape as
 * its dialer bridge). A network failure, a timeout or a 5xx is "down"; a 4xx
 * is a refusal with SunOff's own code and message.
 */

export const SUNOFF_TIMEOUT_MS = 10_000
export const HANDOFF_PATH = '/api/internal/pf-handoff'
export const PROVISION_PATH = '/api/internal/pf-provision'

export function sunoffBaseUrl(): string {
  return (process.env.SUNOFF_BRIDGE_URL || 'https://sunoff.app').replace(/\/+$/, '')
}

export function bridgeKey(): string | null {
  const key = process.env.PF_SUNOFF_BRIDGE_KEY ?? ''
  return usableKey(key) ? key : null
}

export type SunoffCall<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; down: true; status: number | null; error: string; message: string }
  | { ok: false; down: false; status: number; error: string; message: string }

/** Signed POST of a JSON body. Never throws. */
export async function postToSunoff<T = Record<string, unknown>>(
  path: string,
  body: unknown,
  opts: { idempotencyKey: string; fetchImpl?: typeof fetch; now?: Date },
): Promise<SunoffCall<T>> {
  const key = bridgeKey()
  if (!key) return { ok: false, down: true, status: null, error: 'not_configured', message: 'The SunOff bridge key is not set.' }
  const text = JSON.stringify(body)
  const headers = {
    'content-type': 'application/json',
    ...signBridgeRequest({ key, method: 'POST', path, body: text, now: opts.now, idempotencyKey: opts.idempotencyKey }),
  }
  let res: Response
  try {
    res = await (opts.fetchImpl ?? fetch)(`${sunoffBaseUrl()}${path}`, {
      method: 'POST',
      headers,
      body: text,
      signal: AbortSignal.timeout(SUNOFF_TIMEOUT_MS),
      cache: 'no-store',
      redirect: 'error',
    })
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { ok: false, down: true, status: null, error: timeout ? 'timeout' : 'network', message: timeout ? 'SunOff did not answer in time.' : 'SunOff could not be reached.' }
  }
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = await res.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
  } catch {
    // A non-JSON answer (proxy error page) is treated by status below.
  }
  const error = typeof data.error === 'string' ? data.error.slice(0, 80) : ''
  const message = typeof data.message === 'string' ? data.message.slice(0, 300) : ''
  if (res.status >= 500) return { ok: false, down: true, status: res.status, error: error || `http_${res.status}`, message: message || 'SunOff had an error.' }
  if (!res.ok || data.ok !== true) {
    return { ok: false, down: false, status: res.status, error: error || `http_${res.status}`, message: message || 'SunOff refused the request.' }
  }
  return { ok: true, status: res.status, data: data as T }
}
