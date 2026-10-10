import { describe, expect, it } from 'vitest'
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose'
import fixture from '../../../tests/fixtures/twilio-access-token.json'
import { mintVoiceToken, parseIdentity, voiceIdentity, VOICE_TOKEN_TTL_SECONDS } from './access-token'

/**
 * Our jose-minted Voice token must carry exactly the claims twilio-node's own
 * AccessToken + VoiceGrant produce. The fixture was minted OFFLINE by
 * twilio-node (scripts/dev/make-access-token-fixture.mjs) with a fake key and
 * a fixed clock; we mint with the same inputs and compare field by field.
 */

const input = fixture.input

async function mint() {
  return mintVoiceToken({
    accountSid: input.accountSid,
    apiKeySid: input.apiKeySid,
    apiKeySecret: input.apiKeySecret,
    appSid: input.appSid,
    identity: input.identity,
    ttl: input.ttl,
    now: new Date(input.nowSeconds * 1000),
  })
}

describe('Voice access token', () => {
  it('header matches twilio-node: HS256, JWT, cty twilio-fpa;v=1', async () => {
    const { token } = await mint()
    const header = decodeProtectedHeader(token)
    expect(header.alg).toBe(fixture.header.alg)
    expect(header.typ).toBe(fixture.header.typ)
    expect(header.cty).toBe(fixture.header.cty)
  })

  it('payload matches twilio-node field by field', async () => {
    const { token } = await mint()
    const p = decodeJwt(token) as Record<string, unknown> & { grants: typeof fixture.payload.grants }
    expect(p.iss).toBe(fixture.payload.iss)
    expect(p.sub).toBe(fixture.payload.sub)
    expect(p.jti).toBe(fixture.payload.jti)
    expect(p.iat).toBe(fixture.payload.iat)
    expect(p.exp).toBe(fixture.payload.exp)
    expect(p.grants.identity).toBe(fixture.payload.grants.identity)
    expect(p.grants.voice.outgoing.application_sid).toBe(fixture.payload.grants.voice.outgoing.application_sid)
    expect(p.grants.voice.incoming.allow).toBe(fixture.payload.grants.voice.incoming.allow)
    expect(p).toEqual(fixture.payload)
  })

  it('lives an hour and the signature verifies with the secret', async () => {
    const { token, expiresAt } = await mint()
    expect(VOICE_TOKEN_TTL_SECONDS).toBe(3600)
    expect(expiresAt.getTime() / 1000).toBe(input.nowSeconds + 3600)
    const { payload } = await jwtVerify(token, new TextEncoder().encode(input.apiKeySecret), {
      currentDate: new Date((input.nowSeconds + 60) * 1000),
    })
    expect(payload.iss).toBe(input.apiKeySid)
    await expect(
      jwtVerify(token, new TextEncoder().encode('wrong-secret'), { currentDate: new Date((input.nowSeconds + 60) * 1000) }),
    ).rejects.toThrow()
  })
})

describe('voice identity', () => {
  it('binds the browser to one organization and round-trips', () => {
    const id = voiceIdentity('cmorgabc123', 'cmuserxyz789')
    expect(id).toBe('pf_cmorgabc123_cmuserxyz789')
    expect(parseIdentity(id)).toEqual({ organizationId: 'cmorgabc123', userId: 'cmuserxyz789' })
    expect(parseIdentity(`client:${id}`)).toEqual({ organizationId: 'cmorgabc123', userId: 'cmuserxyz789' })
    expect(id.length).toBeLessThan(121)
  })

  it('refuses anything that is not a pf_ identity', () => {
    expect(parseIdentity('client:someone_else')).toBeNull()
    expect(parseIdentity('+17025550142')).toBeNull()
    expect(parseIdentity('pf_a_b_c')).toBeNull()
    expect(() => voiceIdentity('org_1', 'user')).toThrow()
  })
})
