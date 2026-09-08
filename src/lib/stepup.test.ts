import { describe, expect, it } from 'vitest'
import { signStepUpGrant, verifyStepUpGrant, type StepUpGrant } from '@/lib/stepup'

// Pure token tests — the secret and clock are injected, so nothing here reads
// process.env or the real time.
const SECRET = 'test-stepup-secret'
const NOW = 1_900_000_000

function grant(overrides: Partial<StepUpGrant> = {}): StepUpGrant {
  return { uid: 'user_1', scope: 'vault', exp: NOW + 600, ...overrides }
}

describe('signStepUpGrant / verifyStepUpGrant', () => {
  it('round-trips a valid grant', () => {
    const token = signStepUpGrant(grant(), SECRET)
    expect(verifyStepUpGrant(token, { now: NOW, secretOverride: SECRET })).toEqual(grant())
  })

  it('accepts both scopes and nothing else', () => {
    const deploy = signStepUpGrant(grant({ scope: 'deploy' }), SECRET)
    expect(verifyStepUpGrant(deploy, { now: NOW, secretOverride: SECRET })?.scope).toBe('deploy')

    const body = Buffer.from(JSON.stringify(grant({ scope: 'root' as never }))).toString('base64url')
    const forged = signStepUpGrant(grant(), SECRET).replace(/^[^.]+/, body)
    expect(verifyStepUpGrant(forged, { now: NOW, secretOverride: SECRET })).toBeNull()
  })

  it('rejects an expired grant', () => {
    const token = signStepUpGrant(grant({ exp: NOW - 1 }), SECRET)
    expect(verifyStepUpGrant(token, { now: NOW, secretOverride: SECRET })).toBeNull()
  })

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = signStepUpGrant(grant(), SECRET)
    const [, sig] = token.split('.')
    const forgedBody = Buffer.from(JSON.stringify(grant({ uid: 'user_2' }))).toString('base64url')
    expect(verifyStepUpGrant(`${forgedBody}.${sig}`, { now: NOW, secretOverride: SECRET })).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    const token = signStepUpGrant(grant(), 'some-other-secret')
    expect(verifyStepUpGrant(token, { now: NOW, secretOverride: SECRET })).toBeNull()
  })

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'nodot', 'a.b.c', 'not-base64!.sig', `${Buffer.from('"str"').toString('base64url')}.x`]) {
      expect(verifyStepUpGrant(bad, { now: NOW, secretOverride: SECRET })).toBeNull()
    }
  })
})
