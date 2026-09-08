import { describe, it, expect } from 'vitest'
import { generateIntakeSecret, hashIntakeSecret, verifyToken, verifySignature, signRawBody } from '@/lib/intake/hmac'

describe('token-header auth (GoHighLevel method)', () => {
  it('accepts the correct static token and rejects wrong/absent ones', () => {
    const token = generateIntakeSecret()
    const hash = hashIntakeSecret(token)
    expect(verifyToken(hash, token)).toBe(true)               // GHL sends the exact token
    expect(verifyToken(hash, token + 'x')).toBe(false)        // tampered
    expect(verifyToken(hash, '')).toBe(false)                 // empty
    expect(verifyToken(hash, null)).toBe(false)               // missing header
    expect(verifyToken(null, token)).toBe(false)              // source has no secret
    expect(verifyToken(hash, ' ' + token + ' ')).toBe(true)   // trims whitespace
  })
  it('token and signature modes are independent', () => {
    const token = generateIntakeSecret()
    const hash = hashIntakeSecret(token)
    const body = '{"contact_id":"x"}'
    // a valid HMAC signature is NOT a valid token and vice-versa
    expect(verifyToken(hash, signRawBody(hash, body))).toBe(false)
    expect(verifySignature(hash, body, token)).toBe(false)
    expect(verifySignature(hash, body, signRawBody(hash, body))).toBe(true)
  })
})
