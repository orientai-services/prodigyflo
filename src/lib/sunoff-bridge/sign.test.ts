import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BRIDGE_MAX_SKEW_SECONDS,
  bridgeMessage,
  rememberNonce,
  sha256Hex,
  signBridgeRequest,
  verifyBridgeRequest,
} from './sign'

/** docs/CYS_BRIDGE.md §B3.3: both directions sign; skew, body change and replay are refused. */

const KEY = 'test-only-pf-sunoff-bridge-key-0123456789'
const NOW = new Date('2026-10-12T18:00:00.000Z')
const PATH = '/api/bridge/sunoff/status'
const BODY = JSON.stringify({ pf_lead_id: 'pf:org:lead', status: 'started' })

function signed(body = BODY, at = NOW) {
  const h = signBridgeRequest({ key: KEY, method: 'POST', path: PATH, body, now: at, idempotencyKey: 'h1:rev:1' })
  return { ts: h['x-pf-bridge-ts'], sig: h['x-pf-bridge-sig'], idem: h['idempotency-key'] }
}

describe('sunoff bridge signing', () => {
  it('signs ts + METHOD + path + sha256(body) with HMAC-SHA256 over the key string (what SunOff computes)', () => {
    const { ts, sig, idem } = signed()
    const expected = createHmac('sha256', KEY).update(`${ts}\nPOST\n${PATH}\n${sha256Hex(BODY)}`).digest('hex')
    expect(sig).toBe(`v1=${expected}`)
    expect(bridgeMessage(ts, 'post', PATH, BODY)).toBe(`${ts}\nPOST\n${PATH}\n${sha256Hex(BODY)}`)
    expect(idem).toBe('h1:rev:1')
    expect(ts).toBe(String(NOW.getTime() / 1000))
  })

  it('accepts its own signature', () => {
    const { ts, sig } = signed()
    expect(verifyBridgeRequest({ key: KEY, method: 'POST', path: PATH, body: BODY, ts, sig, now: NOW })).toEqual({ ok: true, ts: Number(ts) })
  })

  it('refuses a changed body, path, method or key', () => {
    const { ts, sig } = signed()
    const base = { key: KEY, method: 'POST', path: PATH, body: BODY, ts, sig, now: NOW }
    expect(verifyBridgeRequest({ ...base, body: BODY.replace('started', 'submitted') })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyBridgeRequest({ ...base, path: '/api/bridge/sunoff/files/x/y' })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyBridgeRequest({ ...base, method: 'GET' })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyBridgeRequest({ ...base, key: `${KEY}-other` })).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyBridgeRequest({ ...base, sig: sig.slice(0, -1) })).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('refuses a timestamp outside ±300 s, and accepts one just inside', () => {
    const old = signed(BODY, new Date(NOW.getTime() - (BRIDGE_MAX_SKEW_SECONDS + 1) * 1000))
    expect(verifyBridgeRequest({ key: KEY, method: 'POST', path: PATH, body: BODY, ...old, now: NOW })).toEqual({ ok: false, reason: 'skew' })
    const future = signed(BODY, new Date(NOW.getTime() + (BRIDGE_MAX_SKEW_SECONDS + 1) * 1000))
    expect(verifyBridgeRequest({ key: KEY, method: 'POST', path: PATH, body: BODY, ...future, now: NOW })).toEqual({ ok: false, reason: 'skew' })
    const edge = signed(BODY, new Date(NOW.getTime() - BRIDGE_MAX_SKEW_SECONDS * 1000))
    expect(verifyBridgeRequest({ key: KEY, method: 'POST', path: PATH, body: BODY, ...edge, now: NOW }).ok).toBe(true)
  })

  it('refuses missing headers and fails closed without a usable key', () => {
    const { ts, sig } = signed()
    expect(verifyBridgeRequest({ key: KEY, method: 'POST', path: PATH, body: BODY, ts: null, sig, now: NOW })).toEqual({ ok: false, reason: 'missing' })
    expect(verifyBridgeRequest({ key: KEY, method: 'POST', path: PATH, body: BODY, ts, sig: '', now: NOW })).toEqual({ ok: false, reason: 'missing' })
    expect(verifyBridgeRequest({ key: KEY, method: 'POST', path: PATH, body: BODY, ts: 'abc', sig, now: NOW })).toEqual({ ok: false, reason: 'missing' })
    expect(verifyBridgeRequest({ key: 'short', method: 'POST', path: PATH, body: BODY, ts, sig, now: NOW })).toEqual({ ok: false, reason: 'not_configured' })
    expect(verifyBridgeRequest({ key: undefined, method: 'POST', path: PATH, body: BODY, ts, sig, now: NOW })).toEqual({ ok: false, reason: 'not_configured' })
  })

  it('remembers an Idempotency-Key for 24 h: a replay is refused, then forgotten', () => {
    const first = rememberNonce({}, 'k1', NOW)
    expect(first).toEqual({ k1: NOW.getTime() / 1000 })
    expect(rememberNonce(first!, 'k1', new Date(NOW.getTime() + 3600_000))).toBeNull()
    const later = rememberNonce(first!, 'k2', new Date(NOW.getTime() + 25 * 3600_000))
    expect(later).toEqual({ k2: NOW.getTime() / 1000 + 25 * 3600 })
    expect(rememberNonce(later!, 'k1', new Date(NOW.getTime() + 25 * 3600_000))).not.toBeNull()
  })
})
