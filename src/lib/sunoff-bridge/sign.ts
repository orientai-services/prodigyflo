import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Request signing for the ProdigyFlo <-> SunOff hand-off bridge
 * (docs/CYS_BRIDGE.md §B3.3). Both directions sign every request with the
 * shared PF_SUNOFF_BRIDGE_KEY, so the key never travels as a bearer value:
 *
 *   X-PF-Bridge-Ts:  <unix seconds>
 *   X-PF-Bridge-Sig: v1=<hex HMAC_SHA256(key, ts + "\n" + METHOD + "\n" + path + "\n" + sha256hex(body))>
 *
 * The HMAC key is the env value's UTF-8 bytes as written (no base64 decode),
 * so the Python side is `hmac.new(key.encode(), msg.encode(), sha256)`.
 * `path` is the URL path only (no host, no query); GETs sign an empty body.
 * Pure: the key is passed in, so tests never touch the environment.
 */

export const BRIDGE_TS_HEADER = 'x-pf-bridge-ts'
export const BRIDGE_SIG_HEADER = 'x-pf-bridge-sig'
export const BRIDGE_IDEMPOTENCY_HEADER = 'idempotency-key'
/** Requests older or newer than this are refused. */
export const BRIDGE_MAX_SKEW_SECONDS = 300
/** Idempotency keys are remembered this long for replay rejection. */
export const BRIDGE_NONCE_TTL_SECONDS = 24 * 3600
/** A key shorter than this is treated as "not configured" (fail closed). */
export const BRIDGE_MIN_KEY_LENGTH = 32

export type BridgeVerify =
  | { ok: true; ts: number }
  | { ok: false; reason: 'not_configured' | 'missing' | 'skew' | 'bad_signature' }

export function sha256Hex(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

export function bridgeMessage(ts: number | string, method: string, path: string, body: string | Uint8Array): string {
  return `${ts}\n${method.toUpperCase()}\n${path}\n${sha256Hex(body)}`
}

export function bridgeSignature(key: string, ts: number | string, method: string, path: string, body: string | Uint8Array): string {
  return `v1=${createHmac('sha256', key).update(bridgeMessage(ts, method, path, body)).digest('hex')}`
}

export function usableKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && key.length >= BRIDGE_MIN_KEY_LENGTH
}

/** Headers for an outbound request (lowercase names; fetch accepts either). */
export function signBridgeRequest(input: {
  key: string
  method: string
  path: string
  body: string
  now?: Date
  idempotencyKey?: string
}): Record<string, string> {
  const ts = Math.floor((input.now ?? new Date()).getTime() / 1000)
  return {
    [BRIDGE_TS_HEADER]: String(ts),
    [BRIDGE_SIG_HEADER]: bridgeSignature(input.key, ts, input.method, input.path, input.body),
    ...(input.idempotencyKey ? { [BRIDGE_IDEMPOTENCY_HEADER]: input.idempotencyKey } : {}),
  }
}

/** Timing-safe check of an inbound request. Replay of an Idempotency-Key is the caller's job (it owns the store). */
export function verifyBridgeRequest(input: {
  key: string | null | undefined
  method: string
  path: string
  body: string | Uint8Array
  ts: string | null | undefined
  sig: string | null | undefined
  now?: Date
}): BridgeVerify {
  if (!usableKey(input.key)) return { ok: false, reason: 'not_configured' }
  if (!input.ts || !input.sig || !/^\d{9,11}$/.test(input.ts)) return { ok: false, reason: 'missing' }
  const ts = Number(input.ts)
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000)
  if (Math.abs(now - ts) > BRIDGE_MAX_SKEW_SECONDS) return { ok: false, reason: 'skew' }
  const expected = Buffer.from(bridgeSignature(input.key, input.ts, input.method, input.path, input.body))
  const given = Buffer.from(input.sig.trim())
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' }
  return { ok: true, ts }
}

/**
 * Replay guard over a { key: unixSeconds } map. Returns the pruned map with
 * this key added, or null when the key was already seen inside the TTL.
 */
export function rememberNonce(
  seen: Record<string, number>,
  key: string,
  now: Date = new Date(),
): Record<string, number> | null {
  const t = Math.floor(now.getTime() / 1000)
  const kept = Object.fromEntries(Object.entries(seen).filter(([, at]) => typeof at === 'number' && t - at < BRIDGE_NONCE_TTL_SECONDS))
  if (key in kept) return null
  kept[key] = t
  return kept
}
