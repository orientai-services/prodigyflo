import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Request signatures between ProdigyFlo and the chat Worker (both directions),
 * matching the Worker's src/pfcases.ts:
 *
 *   x-pf-chat-ts:  <unix seconds>
 *   x-pf-chat-sig: v1=<hex HMAC-SHA256(PF_CHAT_KEY, ts \n METHOD \n path?query \n sha256hex(body))>
 *
 * Skew over 300 s is refused. Pure, so it is unit-tested without a server.
 */

export const SKEW_SECONDS = 300

export function chatSignature(key: string, ts: string, method: string, pathQuery: string, body: string): string {
  const digest = createHash('sha256').update(body, 'utf8').digest('hex')
  return 'v1=' + createHmac('sha256', key).update(`${ts}\n${method.toUpperCase()}\n${pathQuery}\n${digest}`, 'utf8').digest('hex')
}

export function signedHeaders(key: string, method: string, url: string, body = '', now = Date.now()): Record<string, string> {
  const u = new URL(url)
  const ts = String(Math.floor(now / 1000))
  return {
    'x-pf-chat-ts': ts,
    'x-pf-chat-sig': chatSignature(key, ts, method, u.pathname + u.search, body),
    ...(body ? { 'content-type': 'application/json' } : {}),
  }
}

export type VerifyResult = 'ok' | 'not_configured' | 'unsigned' | 'skew' | 'signature'

export function verifyChatRequest(
  key: string | null,
  input: { method: string; url: string; headers: Headers; body: string },
  now = Date.now(),
): VerifyResult {
  if (!key) return 'not_configured'
  const ts = input.headers.get('x-pf-chat-ts') ?? ''
  const sig = input.headers.get('x-pf-chat-sig') ?? ''
  if (!/^\d{9,11}$/.test(ts) || !/^v1=[a-f0-9]{64}$/.test(sig)) return 'unsigned'
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > SKEW_SECONDS) return 'skew'
  const u = new URL(input.url)
  const want = Buffer.from(chatSignature(key, ts, input.method, u.pathname + u.search, input.body))
  const got = Buffer.from(sig)
  return want.length === got.length && timingSafeEqual(want, got) ? 'ok' : 'signature'
}
