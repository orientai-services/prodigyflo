import { describe, expect, it } from 'vitest'
import { chatSignature, signedHeaders, verifyChatRequest } from './sign'
import { chatDisplayName, CHAT_TOKEN_TTL_SECONDS, mintChatToken } from './jwt'

/**
 * The chat bridge's pure pieces: the request signature shared with the chat
 * Worker (a fixed vector, so a change on either side fails here) and the SSO
 * token, which must carry no role, staff or super power and live ≤ 12 h.
 */

const KEY = 'test-pf-chat-key-0123456789abcdef0123456789abcdef'
const NOW = Date.UTC(2026, 9, 12, 18, 0, 0)

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
}

describe('chat bridge signature', () => {
  it('matches the vector the Worker computes', () => {
    // Same inputs through the Worker's pfSignature (sunoff-chat src/pfcases.ts) give this value.
    expect(chatSignature(KEY, '1760292000', 'post', '/api/internal/pf/case-ping', '{"leads":[]}')).toBe(WORKER_VECTOR)
  })

  it('accepts a signed request in the window and refuses skew, tampering and a missing key', () => {
    const url = 'https://www.prodigyflo.ai/api/bridge/chat/case-sms'
    const body = '{"pf_lead_id":"x"}'
    const headers = new Headers(signedHeaders(KEY, 'POST', url, body, NOW))
    expect(verifyChatRequest(KEY, { method: 'POST', url, headers, body }, NOW)).toBe('ok')
    expect(verifyChatRequest(KEY, { method: 'POST', url, headers, body: '{"pf_lead_id":"y"}' }, NOW)).toBe('signature')
    expect(verifyChatRequest(KEY, { method: 'POST', url: url + '?x=1', headers, body }, NOW)).toBe('signature')
    expect(verifyChatRequest(KEY, { method: 'POST', url, headers, body }, NOW + 301_000)).toBe('skew')
    expect(verifyChatRequest(KEY, { method: 'POST', url, headers: new Headers(), body }, NOW)).toBe('unsigned')
    expect(verifyChatRequest(null, { method: 'POST', url, headers, body }, NOW)).toBe('not_configured')
    expect(verifyChatRequest('another-key-0123456789abcdef0123456789abcdef', { method: 'POST', url, headers, body }, NOW)).toBe('signature')
  })
})

describe('chat SSO token', () => {
  it('names the linked SunOff user, kid pf, host prodigyflo, no elevation, ≤ 12 h', () => {
    const token = mintChatToken(KEY, { sunoffUserId: 16, pfUserId: 'usr_1', name: 'Gatsby Rep', lang: 'en' }, NOW)
    const [head, body] = token.split('.')
    expect(decode(head)).toEqual({ alg: 'HS256', typ: 'JWT', kid: 'pf' })
    const claims = decode(body)
    expect(claims).toMatchObject({ sub: 'u16', name: 'Gatsby R.', role: 'rep', company_id: null, host: 'prodigyflo', host_ref: 'usr_1', lang: 'en' })
    expect(claims).not.toHaveProperty('staff')
    expect(claims).not.toHaveProperty('super')
    expect(Number(claims.exp) - Number(claims.iat)).toBe(CHAT_TOKEN_TTL_SECONDS)
    expect(CHAT_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(12 * 3600)
    expect(() => mintChatToken(KEY, { sunoffUserId: 0, pfUserId: 'x', name: 'x', lang: 'en' })).toThrow()
  })

  it('never sends an email or a full surname as the display name', () => {
    expect(chatDisplayName('  Mara   Ellis ')).toBe('Mara E.')
    expect(chatDisplayName('')).toBe('ProdigyFlo')
  })
})

const WORKER_VECTOR = 'v1=c3887f1ae124f1eac92c6623e1558b062d14d60f79e3705c27710ee9b4229ab8'
