import { SignJWT } from 'jose'

/**
 * Twilio Voice access tokens for the browser (P0b), minted with `jose` — no
 * `twilio` package on the server. Pure: the clock is an argument, so the token
 * is compared field by field with one minted offline by twilio-node's own
 * AccessToken + VoiceGrant (tests/fixtures/twilio-access-token.json, made by
 * scripts/dev/make-access-token-fixture.mjs).
 *
 * The claim set is pinned (docs/TELEPHONY_LIVE.md §2.3):
 *   header  { alg: HS256, typ: JWT, cty: 'twilio-fpa;v=1' }
 *   payload { jti: '<keySid>-<iat>', iss: keySid, sub: accountSid, iat, exp,
 *             grants: { identity, voice: { incoming: { allow: true },
 *                                          outgoing: { application_sid } } } }
 *
 * The token is never logged or stored.
 */

export const VOICE_TOKEN_TTL_SECONDS = 3600

export type MintVoiceTokenInput = {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  appSid: string
  identity: string
  ttl?: number
  now: Date
}

export async function mintVoiceToken(input: MintVoiceTokenInput): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(input.now.getTime() / 1000)
  const ttl = input.ttl ?? VOICE_TOKEN_TTL_SECONDS
  const exp = iat + ttl
  const token = await new SignJWT({
    jti: `${input.apiKeySid}-${iat}`,
    grants: {
      identity: input.identity,
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: input.appSid },
      },
    },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' })
    .setIssuer(input.apiKeySid)
    .setSubject(input.accountSid)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(input.apiKeySecret))
  return { token, expiresAt: new Date(exp * 1000) }
}

/**
 * pf_<orgId>_<userId>. cuid ids are letters and digits only, so the
 * underscores split it unambiguously, and it stays far under Twilio's
 * 121-character identity limit. It binds a browser to ONE organization.
 */
export function voiceIdentity(organizationId: string, userId: string): string {
  if (!/^[A-Za-z0-9]+$/.test(organizationId) || !/^[A-Za-z0-9]+$/.test(userId)) {
    throw new Error('Voice identities need letter-and-digit ids.')
  }
  return `pf_${organizationId}_${userId}`
}

/** 'client:pf_<org>_<user>' (or the bare identity) → its parts, else null. */
export function parseIdentity(raw: string | null | undefined): { organizationId: string; userId: string } | null {
  const m = /^(?:client:)?pf_([A-Za-z0-9]+)_([A-Za-z0-9]+)$/.exec((raw ?? '').trim())
  return m ? { organizationId: m[1], userId: m[2] } : null
}
