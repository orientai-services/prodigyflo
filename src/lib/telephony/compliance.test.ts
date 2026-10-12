import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INBOUND_INQUIRY_DAYS,
  PhoneHashKeyMissingError,
  REASONS,
  WARNINGS,
  evaluateOutbound,
  outboundPurpose,
  personOptedOut,
  phoneHash,
  signOverride,
  suppressionBlocks,
  verifyOverride,
  type OutboundFacts,
  type SuppressionFact,
} from './compliance-core'
import type { OutboundBlockCode } from './voice-contract'
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

  it('2 — a suppression for this channel; with no known source it fails closed (not overridable)', () => {
    const d = evaluateOutbound(facts({ suppression: SUPPRESSED_BOTH }), NOON, { override: true })
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

  it('9 — nothing on file is NO_CONSENT; an admin may override a call, never a text', () => {
    expect(evaluateOutbound(facts({ consent: null }), NOON)).toMatchObject({ allowed: false, code: 'NO_CONSENT', canOverride: 'restriction' })
    expect(evaluateOutbound(facts({ consent: null }), NOON, { override: true })).toMatchObject({ allowed: true, waived: ['NO_CONSENT'] })
    const sms = evaluateOutbound(facts({ channel: 'SMS', consent: null }), NOON, { override: true })
    expect(sms).toMatchObject({ allowed: false, code: 'NO_CONSENT', canOverride: null })
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

  it('no zone at all is UNKNOWN_TIMEZONE; an admin may override a call', () => {
    expect(evaluateOutbound(facts({ phone: '+18005550142' }), NOON)).toMatchObject({ allowed: false, code: 'UNKNOWN_TIMEZONE', canOverride: 'restriction' })
    const d = evaluateOutbound(facts({ phone: '+18005550142' }), NOON, { override: true })
    expect(d).toMatchObject({ allowed: true, calleeZone: 'unknown', waived: ['UNKNOWN_TIMEZONE'] })
  })

  it('a manager may widen up to the 21:00 ceiling — for calls only', () => {
    const blocked = evaluateOutbound(facts(vegas), EVENING)
    expect(blocked).toMatchObject({ code: 'OUTSIDE_HOURS', canOverride: 'hours' })
    const overridden = evaluateOutbound(facts(vegas), EVENING, { override: true })
    expect(overridden).toMatchObject({ allowed: true, overridden: true })
    const sms = evaluateOutbound(facts({ ...vegas, channel: 'SMS' }), EVENING, { override: true })
    expect(sms).toMatchObject({ allowed: false, code: 'OUTSIDE_HOURS', canOverride: null })
  })

  it('past the ceiling an admin may still call, warned that it is outside legal hours', () => {
    const blocked = evaluateOutbound(facts(vegas), LATE)
    expect(blocked).toMatchObject({ code: 'OUTSIDE_HOURS', canOverride: 'hours', pastLegalHours: true, warning: WARNINGS.PAST_LEGAL_HOURS })
    expect(evaluateOutbound(facts(vegas), EVENING)).not.toHaveProperty('pastLegalHours')
    expect(evaluateOutbound(facts(vegas), LATE, { override: true })).toMatchObject({ allowed: true, waived: ['OUTSIDE_HOURS'] })
  })

  it('on a marketing Sunday an admin may still call, warned', () => {
    const sunday = new Date('2026-10-11T19:00:00Z')
    const d = evaluateOutbound(facts(vegas), sunday)
    expect(d).toMatchObject({ allowed: false, code: 'OUTSIDE_HOURS', canOverride: 'hours', pastLegalHours: true })
    if (!d.allowed) expect(d.reason).toContain('Sunday')
    expect(evaluateOutbound(facts(vegas), sunday, { override: true }).allowed).toBe(true)
    expect(evaluateOutbound(facts({ ...vegas, channel: 'SMS' }), sunday, { override: true })).toMatchObject({ allowed: false, canOverride: null })
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

describe('admin overrides: the decision table (calls)', () => {
  const vegas = { zoneHints: { e164: '+17025550142' } }
  const at = new Date('2026-10-01T00:00:00Z')
  const callBlock = (callBlockedSource: string): SuppressionFact => ({ smsBlockedAt: null, callBlockedAt: at, removedAt: null, callBlockedSource })
  const stopText: SuppressionFact = { smsBlockedAt: at, smsBlockedSource: 'sms_stop', callBlockedAt: null, removedAt: null }
  const underReview: SuppressionFact = { smsBlockedAt: at, smsBlockedSource: 'sms_stop_review', callBlockedAt: null, removedAt: null }
  const revokedLead = { kind: 'lead' as const, consentAt: at, consentSource: 'lead_form', consentRevokedAt: at, consentFormId: '1', consentNote: null }

  // [label, facts, now, code, canOverride (admin view), override lets it through, reason]
  const table: [string, Partial<OutboundFacts>, Date, OutboundBlockCode, 'hours' | 'restriction' | null, boolean, string?][] = [
    ['invalid number', { phone: '555-0142' }, NOON, 'INVALID_NUMBER', null, false],
    ['manual do-not-call row', { suppression: callBlock('manual') }, NOON, 'SUPPRESSED', 'restriction', true],
    ['call-desk do-not-call row', { suppression: callBlock('call_center') }, NOON, 'SUPPRESSED', 'restriction', true],
    ['imported do-not-call row', { suppression: callBlock('import') }, NOON, 'SUPPRESSED', 'restriction', true],
    ['legacy row (reads as import)', { suppression: { smsBlockedAt: null, callBlockedAt: null, removedAt: null } }, NOON, 'SUPPRESSED', 'restriction', true],
    ['STOP-made call block', { suppression: callBlock('sms_stop') }, NOON, 'SUPPRESSED', null, false, REASONS.PERSON_OPTED_OUT],
    ['manual row + they texted STOP', { suppression: { ...callBlock('manual'), smsBlockedAt: at, smsBlockedSource: 'sms_stop' } }, NOON, 'SUPPRESSED', null, false, REASONS.PERSON_OPTED_OUT],
    ['manual row + opt-out under review', { suppression: { ...callBlock('manual'), smsBlockedAt: at, smsBlockedSource: 'sms_stop_review' } }, NOON, 'SUPPRESSED', null, false, REASONS.OPTOUT_REVIEW],
    ['lead do-not-call', { leadDoNotCall: true }, NOON, 'SUPPRESSED', 'restriction', true],
    ['lead do-not-call + revoked consent', { leadDoNotCall: true, consent: revokedLead }, NOON, 'SUPPRESSED', null, false, REASONS.PERSON_OPTED_OUT],
    ['no consent', { consent: null }, NOON, 'NO_CONSENT', 'restriction', true],
    ['lead consent revoked (STOP)', { consent: revokedLead }, NOON, 'NO_CONSENT', null, false, REASONS.PERSON_OPTED_OUT],
    ['STOP text, no consent', { suppression: stopText, consent: null }, NOON, 'NO_CONSENT', null, false, REASONS.PERSON_OPTED_OUT],
    ['client STOP / revoked TCPA', { smsOptedOut: true, consent: { kind: 'client', consents: [] } }, NOON, 'NO_CONSENT', null, false, REASONS.PERSON_OPTED_OUT],
    ['opt-out under review, no consent', { suppression: underReview, consent: null }, NOON, 'NO_CONSENT', null, false, REASONS.OPTOUT_REVIEW],
    ['unknown time zone', { phone: '+18005550142' }, NOON, 'UNKNOWN_TIMEZONE', 'restriction', true],
    ['outside hours, inside the ceiling', vegas, EVENING, 'OUTSIDE_HOURS', 'hours', true],
    ['outside hours, past the ceiling', vegas, LATE, 'OUTSIDE_HOURS', 'hours', true],
  ]

  it.each(table)('%s', (_label, over, now, code, canOverride, passes, reason) => {
    const without = evaluateOutbound(facts(over), now)
    expect(without).toMatchObject({ allowed: false, code, canOverride })
    if (reason && !without.allowed) expect(without.reason).toBe(reason)
    // Non-overridable blocks never carry a warning; the admin prompt shows one for every other.
    if (!without.allowed) expect(Boolean(without.warning)).toBe(canOverride === 'restriction' || (canOverride === 'hours' && now === LATE))

    const withOverride = evaluateOutbound(facts(over), now, { override: true })
    if (passes) {
      expect(withOverride).toMatchObject({ allowed: true, overridden: true })
      if (withOverride.allowed) expect(withOverride.waived).toContain(code)
    } else {
      expect(withOverride).toMatchObject({ allowed: false, code, canOverride: null })
    }
  })

  it('the do-not-call prompt warns that it is only for people who did NOT ask us to stop', () => {
    expect(evaluateOutbound(facts({ leadDoNotCall: true }), NOON)).toMatchObject({ warning: WARNINGS.DNC })
    expect(evaluateOutbound(facts({ suppression: callBlock('manual') }), NOON)).toMatchObject({ warning: WARNINGS.DNC })
  })

  it('texts are never overridable', () => {
    for (const over of [{ suppression: { ...callBlock('manual'), smsBlockedAt: at, smsBlockedSource: 'manual' } }, { leadDoNotCall: true }, { consent: null }, { phone: '+18005550142' }, vegas]) {
      const now = 'zoneHints' in over ? EVENING : NOON
      const d = evaluateOutbound(facts({ ...over, channel: 'SMS' }), now, { override: true })
      expect(d).toMatchObject({ allowed: false, canOverride: null })
    }
  })

  it('one override steps past stacked blocks and says so in the basis', () => {
    const over = { ...vegas, leadDoNotCall: true, consent: null }
    expect(evaluateOutbound(facts(over), EVENING)).toMatchObject({ code: 'SUPPRESSED', canOverride: 'restriction' })
    const d = evaluateOutbound(facts(over), EVENING, { override: true })
    expect(d).toMatchObject({ allowed: true, waived: ['SUPPRESSED', 'NO_CONSENT', 'OUTSIDE_HOURS'] })
    if (d.allowed) expect(d.basis).toBe('No consent on file; admin override (do-not-call, no consent, hours)')
  })

  it('a waive list steps past only what it names', () => {
    const over = { ...vegas, leadDoNotCall: true, consent: null }
    expect(evaluateOutbound(facts(over), EVENING, { override: { waive: ['SUPPRESSED'] } })).toMatchObject({ allowed: false, code: 'NO_CONSENT' })
    expect(evaluateOutbound(facts(over), EVENING, { override: { waive: ['SUPPRESSED', 'NO_CONSENT', 'OUTSIDE_HOURS'] } }).allowed).toBe(true)
  })

  it('an hours-only override keeps the plain "hours override" basis', () => {
    const d = evaluateOutbound(facts(vegas), EVENING, { override: true })
    if (d.allowed) expect(d.basis).toBe('Consent on file (form 1234, Oct 1, 2026); hours override')
  })

  it('personOptedOut reads every stop signal and nothing else', () => {
    const base = { suppression: null, smsOptedOut: false, consent: null }
    expect(personOptedOut(base)).toBe(false)
    expect(personOptedOut({ ...base, suppression: stopText })).toBe(true)
    expect(personOptedOut({ ...base, suppression: { ...stopText, removedAt: at } })).toBe(false)
    expect(personOptedOut({ ...base, suppression: callBlock('manual') })).toBe(false)
    expect(personOptedOut({ ...base, smsOptedOut: true })).toBe(true)
    expect(personOptedOut({ ...base, consent: revokedLead })).toBe(true)
    expect(personOptedOut({ ...base, consent: { kind: 'client', consents: [{ granted: true, grantedAt: at, revokedAt: at, expiresAt: null }] } })).toBe(true)
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

  it('carries the blocks it waives; an older token waives only its own code', () => {
    const token = signOverride({ ...claims, code: 'SUPPRESSED', waive: ['SUPPRESSED', 'NO_CONSENT'] }, NOON, KEY)!
    const check = verifyOverride(token, { ...claims, code: 'SUPPRESSED' }, NOON, KEY)
    expect(check).toMatchObject({ ok: true, waive: ['SUPPRESSED', 'NO_CONSENT'] })
    expect(verifyOverride(signOverride(claims, NOON, KEY)!, claims, NOON, KEY)).toMatchObject({ ok: true, waive: ['OUTSIDE_HOURS'] })
  })

  it('cannot be minted without TELEPHONY_OVERRIDE_KEY', () => {
    expect(signOverride(claims, NOON, '')).toBeNull()
    expect(verifyOverride('x.y', claims, NOON, '').ok).toBe(false)
  })
})
