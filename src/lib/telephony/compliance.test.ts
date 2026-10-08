import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INBOUND_INQUIRY_DAYS,
  PhoneHashKeyMissingError,
  evaluateOutbound,
  outboundPurpose,
  phoneHash,
  signOverride,
  suppressionBlocks,
  verifyOverride,
  type OutboundFacts,
} from './compliance-core'
import { DEFAULT_WINDOW } from './timezones'

/**
 * The one outbound decision (docs/TELEPHONY_LIVE.md §2.7), pure. Every row of
 * the precedence table in order, consent expiry by source, the purpose rule,
 * and the hours-override token.
 */

// Wednesday 2026-10-07, 11:00 am Pacific.
const NOON = new Date('2026-10-07T18:00:00Z')
// Same Wednesday, 8:40 pm Pacific (inside the 21:00 ceiling, outside the 20:00 window).
const EVENING = new Date('2026-10-08T03:40:00Z')
// Same night, 9:40 pm Pacific (past the ceiling).
const LATE = new Date('2026-10-08T04:40:00Z')

const day = 86_400_000

function facts(over: Partial<OutboundFacts> = {}): OutboundFacts {
  return {
    channel: 'CALL',
    purpose: 'marketing',
    phone: '(702) 555-0142',
    suppression: null,
    smsOptedOut: false,
    leadDoNotCall: false,
    ownNumber: false,
    servicingBasis: null,
    consent: { kind: 'lead', consentAt: new Date('2026-10-01T00:00:00Z'), consentSource: 'lead_form', consentRevokedAt: null, consentFormId: '1234', consentNote: null },
    zoneHints: {},
    callWindow: DEFAULT_WINDOW,
    replyWindowOpen: false,
    ...over,
  }
}

const SUPPRESSED_BOTH = { smsBlockedAt: new Date(), callBlockedAt: new Date(), removedAt: null }

describe('precedence, first match wins', () => {
  it('1 — an invalid number', () => {
    expect(evaluateOutbound(facts({ phone: '555-0142' }), NOON)).toMatchObject({ allowed: false, code: 'INVALID_NUMBER' })
    expect(evaluateOutbound(facts({ phone: null }), NOON)).toMatchObject({ allowed: false, code: 'INVALID_NUMBER' })
  })

  it('2 — a suppression for this channel, never overridable', () => {
    const d = evaluateOutbound(facts({ suppression: SUPPRESSED_BOTH }), NOON)
    expect(d).toMatchObject({ allowed: false, code: 'SUPPRESSED', canOverride: null })
  })

  it('2 — a per-channel row blocks only its channel', () => {
    const smsOnly = { smsBlockedAt: new Date(), callBlockedAt: null, removedAt: null }
    expect(evaluateOutbound(facts({ suppression: smsOnly }), NOON).allowed).toBe(true)
    expect(evaluateOutbound(facts({ channel: 'SMS', suppression: smsOnly }), NOON)).toMatchObject({ code: 'SUPPRESSED' })
  })

  it('2 — a legacy row (both pairs empty, not removed) blocks both; a removed row blocks nothing', () => {
    const legacy = { smsBlockedAt: null, callBlockedAt: null, removedAt: null }
    expect(suppressionBlocks(legacy, 'CALL')).toBe(true)
    expect(suppressionBlocks(legacy, 'SMS')).toBe(true)
    expect(suppressionBlocks({ ...legacy, removedAt: new Date() }, 'CALL')).toBe(false)
  })

  it('3 — SMS opt-out', () => {
    expect(evaluateOutbound(facts({ channel: 'SMS', smsOptedOut: true }), NOON)).toMatchObject({ code: 'OPTED_OUT' })
    // Opt-out is about texts; a call is not affected by it.
    expect(evaluateOutbound(facts({ smsOptedOut: true }), NOON).allowed).toBe(true)
  })

  it('4 — the lead is marked do-not-call', () => {
    expect(evaluateOutbound(facts({ leadDoNotCall: true }), NOON)).toMatchObject({ code: 'SUPPRESSED' })
  })

  it('5 — our own line or a manager-kept team number is always callable', () => {
    const d = evaluateOutbound(facts({ ownNumber: true, consent: null }), LATE)
    expect(d).toMatchObject({ allowed: true, basis: 'Own team number' })
  })

  it('6 — a servicing call needs no consent', () => {
    const d = evaluateOutbound(facts({ purpose: 'servicing', servicingBasis: 'Active client (stage Install, since Oct 1, 2026)', consent: { kind: 'client', consents: [] } }), NOON)
    expect(d).toMatchObject({ allowed: true, basis: 'Active client (stage Install, since Oct 1, 2026)' })
  })

  it('6 — servicing does not reach texts (SMS keeps its own consent gate)', () => {
    const d = evaluateOutbound(
      facts({ channel: 'SMS', purpose: 'servicing', servicingBasis: 'Active client', consent: { kind: 'client', consents: [] } }),
      NOON,
    )
    expect(d).toMatchObject({ allowed: false, code: 'NO_CONSENT' })
  })

  it('7 — consent on file allows, naming the source', () => {
    const d = evaluateOutbound(facts(), NOON)
    expect(d).toMatchObject({ allowed: true })
    if (d.allowed) expect(d.basis).toContain('form 1234')
  })

  it('9 — nothing on file is NO_CONSENT, never overridable', () => {
    const d = evaluateOutbound(facts({ consent: null }), EVENING, { override: true })
    expect(d).toMatchObject({ allowed: false, code: 'NO_CONSENT', canOverride: null })
  })

  it('an opt-out beats consent AND a servicing purpose', () => {
    const d = evaluateOutbound(
      facts({ purpose: 'servicing', servicingBasis: 'Active client', suppression: SUPPRESSED_BOTH }),
      NOON,
    )
    expect(d).toMatchObject({ allowed: false, code: 'SUPPRESSED' })
  })

  it('a suppressed servicing client is not callable', () => {
    const d = evaluateOutbound(
      facts({ purpose: 'servicing', servicingBasis: 'Active client', suppression: { smsBlockedAt: null, callBlockedAt: new Date(), removedAt: null } }),
      NOON,
    )
    expect(d).toMatchObject({ allowed: false, code: 'SUPPRESSED' })
  })
})

describe('consent by source', () => {
  const lead = (source: string, at: Date, revoked: Date | null = null) =>
    facts({ consent: { kind: 'lead', consentAt: at, consentSource: source, consentRevokedAt: revoked, consentFormId: null, consentNote: 'Signed form in the Vault' } })

  it('inbound_inquiry lasts 90 days: day 89 allowed, day 91 blocked', () => {
    expect(INBOUND_INQUIRY_DAYS).toBe(90)
    expect(evaluateOutbound(lead('inbound_inquiry', new Date(NOON.getTime() - 89 * day)), NOON).allowed).toBe(true)
    expect(evaluateOutbound(lead('inbound_inquiry', new Date(NOON.getTime() - 91 * day)), NOON)).toMatchObject({ code: 'NO_CONSENT' })
  })

  it('lead_form and manual have no expiry', () => {
    const old = new Date(NOON.getTime() - 900 * day)
    expect(evaluateOutbound(lead('lead_form', old), NOON).allowed).toBe(true)
    expect(evaluateOutbound(lead('manual', old), NOON).allowed).toBe(true)
  })

  it('revoked consent (a STOP) is no consent', () => {
    expect(evaluateOutbound(lead('lead_form', new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z')), NOON)).toMatchObject({
      code: 'NO_CONSENT',
    })
  })

  it('an unknown source is no consent', () => {
    expect(evaluateOutbound(lead('rep_said_so', new Date('2026-10-01T00:00:00Z')), NOON)).toMatchObject({ code: 'NO_CONSENT' })
  })

  it('a client needs a live TCPA consent: granted, not revoked, not expired', () => {
    const at = new Date('2026-09-01T00:00:00Z')
    const client = (c: object) => facts({ consent: { kind: 'client', consents: [{ granted: true, grantedAt: at, revokedAt: null, expiresAt: null, ...c }] } })
    expect(evaluateOutbound(client({}), NOON).allowed).toBe(true)
    expect(evaluateOutbound(client({ revokedAt: new Date('2026-09-02T00:00:00Z') }), NOON)).toMatchObject({ code: 'NO_CONSENT' })
    expect(evaluateOutbound(client({ granted: false }), NOON)).toMatchObject({ code: 'NO_CONSENT' })
    expect(evaluateOutbound(client({ expiresAt: new Date('2026-09-30T00:00:00Z') }), NOON)).toMatchObject({ code: 'NO_CONSENT' })
  })
})

describe('purpose', () => {
  const base = { deletedAt: null, status: 'ACTIVE' as const, stageName: 'Install', stageEnteredAt: new Date('2026-09-01T00:00:00Z') }

  it('a case under way (fulfillment / submission) is servicing', () => {
    expect(outboundPurpose({ ...base, stageCategory: 'FULFILLMENT' }, NOON).purpose).toBe('servicing')
    expect(outboundPurpose({ ...base, status: 'ON_HOLD', stageCategory: 'SUBMISSION' }, NOON).purpose).toBe('servicing')
  })

  it('intake, qualification and sales stages are marketing (Meta leads land there)', () => {
    for (const stageCategory of ['INTAKE', 'QUALIFICATION', 'SALES']) {
      expect(outboundPurpose({ ...base, stageCategory }, NOON).purpose).toBe('marketing')
    }
  })

  it('closed-won is servicing for 18 months, then marketing; lost and deleted are marketing', () => {
    const won = { ...base, status: 'CLOSED_WON' as const, stageCategory: 'TERMINAL' }
    expect(outboundPurpose({ ...won, stageEnteredAt: new Date(NOON.getTime() - 500 * day) }, NOON).purpose).toBe('servicing')
    expect(outboundPurpose({ ...won, stageEnteredAt: new Date(NOON.getTime() - 600 * day) }, NOON).purpose).toBe('marketing')
    expect(outboundPurpose({ ...base, status: 'CLOSED_LOST', stageCategory: 'TERMINAL' }, NOON).purpose).toBe('marketing')
    expect(outboundPurpose({ ...base, stageCategory: 'FULFILLMENT', deletedAt: new Date() }, NOON).purpose).toBe('marketing')
  })
})

describe('hours', () => {
  const vegas = { zoneHints: { e164: '+17025550142' } }

  it('outside the window is OUTSIDE_HOURS with a plain reason and a retry time', () => {
    const d = evaluateOutbound(facts(vegas), EVENING)
    expect(d).toMatchObject({ allowed: false, code: 'OUTSIDE_HOURS' })
    if (!d.allowed) {
      expect(d.reason).toBe("It's 8:40 pm for them. Calls can go out after 8:00 am their time.")
      expect(d.retryAt?.toISOString()).toBe('2026-10-08T15:00:00.000Z')
    }
  })

  it('no zone at all is UNKNOWN_TIMEZONE, never overridable', () => {
    const d = evaluateOutbound(facts({ phone: '+18005550142' }), NOON, { override: true })
    expect(d).toMatchObject({ allowed: false, code: 'UNKNOWN_TIMEZONE', canOverride: null })
  })

  it('a manager may widen up to the 21:00 ceiling — for calls only', () => {
    const blocked = evaluateOutbound(facts(vegas), EVENING)
    expect(blocked).toMatchObject({ code: 'OUTSIDE_HOURS', canOverride: 'hours' })
    const overridden = evaluateOutbound(facts(vegas), EVENING, { override: true })
    expect(overridden).toMatchObject({ allowed: true, overridden: true })
    const sms = evaluateOutbound(facts({ ...vegas, channel: 'SMS' }), EVENING, { override: true })
    expect(sms).toMatchObject({ allowed: false, code: 'OUTSIDE_HOURS', canOverride: null })
  })

  it('no override past the ceiling', () => {
    const d = evaluateOutbound(facts(vegas), LATE, { override: true })
    expect(d).toMatchObject({ allowed: false, code: 'OUTSIDE_HOURS', canOverride: null })
  })

  it('no override on a marketing Sunday', () => {
    const sunday = new Date('2026-10-11T19:00:00Z')
    const d = evaluateOutbound(facts(vegas), sunday, { override: true })
    expect(d).toMatchObject({ allowed: false, code: 'OUTSIDE_HOURS', canOverride: null })
    if (!d.allowed) expect(d.reason).toContain('Sunday')
  })

  it('a text may reply within 30 minutes of their message at any hour', () => {
    const d = evaluateOutbound(facts({ ...vegas, channel: 'SMS', replyWindowOpen: true }), LATE)
    expect(d.allowed).toBe(true)
  })

  it('the area code and a stated state must BOTH be in the window', () => {
    // 6:30 pm Pacific: fine in Vegas, 9:30 pm in New York.
    const at = new Date('2026-10-08T01:30:00Z')
    expect(evaluateOutbound(facts(vegas), at).allowed).toBe(true)
    expect(evaluateOutbound(facts({ zoneHints: { e164: '+17025550142', states: ['NY'] } }), at)).toMatchObject({ code: 'OUTSIDE_HOURS' })
  })
})

describe('phone hashing', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('hashes the E.164 form, so every spelling of one number matches', () => {
    vi.stubEnv('PHONE_HASH_KEY', 'k1')
    expect(phoneHash('7025550142')).toBe(phoneHash('+1 (702) 555-0142'))
    expect(phoneHash('17025550142')).toBe(phoneHash('+17025550142'))
  })

  it('does not depend on VAULT_KEY — rotating the vault never empties the list', () => {
    vi.stubEnv('PHONE_HASH_KEY', 'k1')
    vi.stubEnv('VAULT_KEY', 'vault-a')
    const before = phoneHash('+17025550142')
    vi.stubEnv('VAULT_KEY', 'vault-b')
    expect(phoneHash('+17025550142')).toBe(before)
  })

  it('refuses without a key (callers fail closed)', () => {
    vi.stubEnv('PHONE_HASH_KEY', '')
    expect(() => phoneHash('+17025550142')).toThrow(PhoneHashKeyMissingError)
  })
})

describe('the hours-override token', () => {
  const claims = { orgId: 'org1', userId: 'u1', target: 'lead:L1', lineId: 'pn1', code: 'OUTSIDE_HOURS' as const }
  const KEY = 'override-key'

  it('verifies when every field matches, and returns its nonce', () => {
    const token = signOverride(claims, NOON, KEY)!
    const check = verifyOverride(token, claims, NOON, KEY)
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.nonce).toMatch(/^[0-9a-f]{32}$/)
  })

  it('expires after two minutes', () => {
    const token = signOverride(claims, NOON, KEY)!
    expect(verifyOverride(token, claims, new Date(NOON.getTime() + 121_000), KEY).ok).toBe(false)
  })

  it.each([
    ['wrong user', { userId: 'u2' }],
    ['wrong org', { orgId: 'org2' }],
    ['wrong target', { target: 'lead:L2' }],
    ['wrong line', { lineId: 'pn2' }],
    ['wrong code', { code: 'NO_CONSENT' as const }],
  ])('is refused for a %s', (_label, change) => {
    const token = signOverride(claims, NOON, KEY)!
    expect(verifyOverride(token, { ...claims, ...change }, NOON, KEY).ok).toBe(false)
  })

  it('is refused with a tampered body or another key', () => {
    const token = signOverride(claims, NOON, KEY)!
    const [, sig] = token.split('.')
    const forged = `${Buffer.from(JSON.stringify({ ...claims, userId: 'u9', exp: NOON.getTime() + 60_000, nonce: 'a'.repeat(32) })).toString('base64url')}.${sig}`
    expect(verifyOverride(forged, { ...claims, userId: 'u9' }, NOON, KEY).ok).toBe(false)
    expect(verifyOverride(token, claims, NOON, 'other-key').ok).toBe(false)
  })

  it('cannot be minted without TELEPHONY_OVERRIDE_KEY', () => {
    expect(signOverride(claims, NOON, '')).toBeNull()
    expect(verifyOverride('x.y', claims, NOON, '').ok).toBe(false)
  })
})
