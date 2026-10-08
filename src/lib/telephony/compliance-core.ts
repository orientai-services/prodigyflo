import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { toE164 } from './provider'
import {
  DEFAULT_WINDOW,
  LEGAL_WINDOW,
  calleeZones,
  deferUntil,
  hourLabel,
  localTimeIn,
  windowOk,
  type CallWindow,
  type ZoneHints,
} from './timezones'
import type { OutboundBlockCode, OutboundPurpose } from './voice-contract'

/**
 * The pure half of the one outbound decision (docs/TELEPHONY_LIVE.md §2.7).
 *
 * No database and no `server-only`, so every precedence row, the consent
 * expiry by source and the override token are unit-tested directly. The
 * loader that gathers these facts lives in compliance.ts.
 *
 * Precedence, first match wins:
 *   1 invalid number          → INVALID_NUMBER
 *   2 suppression (channel)   → SUPPRESSED      never overridable
 *   3 SMS opt-out             → OPTED_OUT
 *   4 lead do-not-call        → SUPPRESSED
 *   5 own line / team number  → allow
 *   6 servicing call          → allow (hours still apply)
 *   7 consent on file         → allow (hours still apply)
 *   9 anything else           → NO_CONSENT      never overridable
 * Hours (calls and texts) are checked on every allow path except 5.
 */

export type OutboundChannel = 'CALL' | 'SMS'

// ── Number hashing ──────────────────────────────────────────────────────────

export class PhoneHashKeyMissingError extends Error {
  constructor() {
    super('PHONE_HASH_KEY is not set.')
    this.name = 'PhoneHashKeyMissingError'
  }
}

/**
 * HMAC-SHA256 of the E.164 form, keyed by PHONE_HASH_KEY (never VAULT_KEY).
 *
 * Do not rotate PHONE_HASH_KEY. Suppression rows store no number, by design, so
 * a new key would silently unblock every opt-out. If it ever leaks, the hashes
 * reveal nothing without a guess of the number.
 */
export function phoneHash(phone: string, key: string | undefined = process.env.PHONE_HASH_KEY): string {
  if (!key) throw new PhoneHashKeyMissingError()
  const e164 = toE164(phone)
  if (!e164) throw new Error('phoneHash needs a valid phone number.')
  return createHmac('sha256', key).update(e164, 'utf8').digest('hex')
}

/** phoneHash, or null when the key is missing or the number won't normalize. */
export function phoneHashOrNull(phone: string | null | undefined): string | null {
  if (!phone || !process.env.PHONE_HASH_KEY) return null
  try {
    return phoneHash(phone)
  } catch {
    return null
  }
}

export function last4Of(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? digits.slice(-4) : null
}

export function maskedLast4(phone: string | null | undefined): string {
  const l4 = last4Of(phone)
  return l4 ? `•••-•••-${l4}` : '•••'
}

// ── Purpose ─────────────────────────────────────────────────────────────────

export type PurposeFacts = {
  deletedAt: Date | null
  status: 'ACTIVE' | 'ON_HOLD' | 'DISQUALIFIED' | 'CLOSED_WON' | 'CLOSED_LOST'
  stageCategory: string
  stageName: string
  stageEnteredAt: Date
}

const EBR_MS = 548 * 86_400_000 // 18 months

function shortDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/**
 * Servicing = an active customer whose case is under way, or a closed-won
 * customer within the 18-month purchase window. Everything else — every lead,
 * intake / qualification / sales stages, lost or disqualified — is marketing.
 * The stage mapping is this plan's reading; the owner confirms it with counsel.
 */
export function outboundPurpose(client: PurposeFacts, now: Date): { purpose: OutboundPurpose; basis: string | null } {
  if (client.deletedAt) return { purpose: 'marketing', basis: null }
  const caseUnderWay =
    (client.status === 'ACTIVE' || client.status === 'ON_HOLD') &&
    (client.stageCategory === 'FULFILLMENT' || client.stageCategory === 'SUBMISSION')
  const recentWin = client.status === 'CLOSED_WON' && now.getTime() - client.stageEnteredAt.getTime() <= EBR_MS
  if (caseUnderWay || recentWin) {
    return {
      purpose: 'servicing',
      basis: `Active client (stage ${client.stageName}, since ${shortDate(client.stageEnteredAt)})`,
    }
  }
  return { purpose: 'marketing', basis: null }
}

// ── Consent facts ───────────────────────────────────────────────────────────

export type ClientConsentFact = {
  kind: 'client'
  /** TCPA_CONTACT rows only. */
  consents: { granted: boolean; grantedAt: Date; revokedAt: Date | null; expiresAt: Date | null; textVersion?: string | null }[]
}

export type LeadConsentFact = {
  kind: 'lead'
  consentAt: Date | null
  consentSource: string | null
  consentRevokedAt: Date | null
  consentFormId: string | null
  consentNote: string | null
}

export const INBOUND_INQUIRY_DAYS = 90

/**
 * Twilio's StirVerstat values that vouch for the caller ID: full (A) or
 * partial (B) attestation by the originating carrier. Anything else — C,
 * failed, or no value at all — can't open a number to outbound contact.
 */
export function inquiryAttested(stirVerstat: string | null | undefined): boolean {
  return stirVerstat === 'TN-Validation-Passed-A' || stirVerstat === 'TN-Validation-Passed-B'
}

/** The basis line for consent that is on file and live, or null. */
export function consentBasis(fact: ClientConsentFact | LeadConsentFact | null, now: Date): string | null {
  if (!fact) return null
  if (fact.kind === 'client') {
    const latest = [...fact.consents].sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())[0]
    if (!latest || !latest.granted || latest.revokedAt) return null
    if (latest.expiresAt && latest.expiresAt.getTime() < now.getTime()) return null
    return `Consent on file (signed ${shortDate(latest.grantedAt)})`
  }
  if (!fact.consentAt || fact.consentRevokedAt) return null
  switch (fact.consentSource) {
    case 'lead_form':
      return `Consent on file (form ${fact.consentFormId ?? 'on file'}, ${shortDate(fact.consentAt)})`
    case 'manual':
      return `Consent recorded by staff (${shortDate(fact.consentAt)})`
    case 'inbound_inquiry': {
      const expires = fact.consentAt.getTime() + INBOUND_INQUIRY_DAYS * 86_400_000
      if (now.getTime() > expires) return null
      return `They contacted us (${shortDate(fact.consentAt)})`
    }
    default:
      return null
  }
}

// ── The decision ─────────────────────────────────────────────────────────────

export type SuppressionFact = {
  smsBlockedAt: Date | null
  callBlockedAt: Date | null
  removedAt: Date | null
  /** 'sms_stop_review' = a possible opt-out held for an admin, not a decided one. */
  smsBlockedSource?: string | null
}

export type OutboundFacts = {
  channel: OutboundChannel
  purpose: OutboundPurpose
  /** Raw number; normalized here. */
  phone: string | null
  suppression: SuppressionFact | null
  /** SMS: latest inbound text was a STOP, or TCPA consent revoked. */
  smsOptedOut: boolean
  leadDoNotCall: boolean
  /** The org's own PhoneNumber, or the manager-kept team number list. Never User.phone. */
  ownNumber: boolean
  /** Set when purpose is servicing. */
  servicingBasis: string | null
  consent: ClientConsentFact | LeadConsentFact | null
  zoneHints: ZoneHints
  callWindow: CallWindow
  /** SMS: the person texted this account within the last 30 minutes, and a person (not automation) is replying. */
  replyWindowOpen: boolean
}

export type OutboundDecision =
  | {
      allowed: true
      basis: string
      purpose: OutboundPurpose
      e164: string
      zones: string[]
      calleeLocalTime: string
      calleeZone: string
      overridden: boolean
    }
  | {
      allowed: false
      code: OutboundBlockCode
      reason: string
      canOverride: 'hours' | null
      /** OUTSIDE_HOURS only: the next time the window opens (for deferral). */
      retryAt?: Date | null
      /** SUPPRESSED only: texts are held while an admin reviews a possible opt-out (it may be lifted). */
      held?: boolean
    }

function block(
  code: OutboundBlockCode,
  reason: string,
  extra: { canOverride?: 'hours' | null; retryAt?: Date | null; held?: boolean } = {},
): OutboundDecision {
  return {
    allowed: false,
    code,
    reason,
    canOverride: extra.canOverride ?? null,
    ...(extra.retryAt !== undefined ? { retryAt: extra.retryAt } : {}),
    ...(extra.held ? { held: true } : {}),
  }
}

/** A suppression row blocks this channel. A legacy row with both pairs null blocks both until removed. */
export function suppressionBlocks(row: SuppressionFact | null, channel: OutboundChannel): boolean {
  if (!row || row.removedAt) return false
  if (!row.smsBlockedAt && !row.callBlockedAt) return true
  return channel === 'CALL' ? Boolean(row.callBlockedAt) : Boolean(row.smsBlockedAt)
}

export const REASONS = {
  INVALID_NUMBER: "That isn't a valid phone number.",
  SUPPRESSED_CALL: 'This number is on the do-not-call list.',
  SUPPRESSED_SMS: 'Texts to this number are blocked (opt-out or do-not-contact list).',
  HELD_SMS: 'Texts to this number are on hold until an admin reviews a possible opt-out.',
  OPTED_OUT: 'They replied STOP. Texts to this number are off.',
  NO_CONSENT: 'No consent on file for this number.',
  UNKNOWN_TIMEZONE: "We don't know their time zone. Press Call and pick where they are, then try again.",
} as const

/**
 * `override` is set only after a manager asked for an hours override; it lets
 * the decision widen the account window up to the legal ceiling, never past
 * it, never on a marketing Sunday or holiday, never for texts.
 */
export function evaluateOutbound(facts: OutboundFacts, now: Date, opts: { override?: boolean } = {}): OutboundDecision {
  const e164 = facts.phone ? toE164(facts.phone) : null
  if (!e164) return block('INVALID_NUMBER', REASONS.INVALID_NUMBER)

  if (suppressionBlocks(facts.suppression, facts.channel)) {
    if (facts.channel === 'SMS' && facts.suppression?.smsBlockedSource === 'sms_stop_review') {
      return block('SUPPRESSED', REASONS.HELD_SMS, { held: true })
    }
    return block('SUPPRESSED', facts.channel === 'CALL' ? REASONS.SUPPRESSED_CALL : REASONS.SUPPRESSED_SMS)
  }
  if (facts.channel === 'SMS' && facts.smsOptedOut) return block('OPTED_OUT', REASONS.OPTED_OUT)
  if (facts.leadDoNotCall) return block('SUPPRESSED', REASONS.SUPPRESSED_CALL)

  if (facts.ownNumber) {
    const zones = calleeZones({ ...facts.zoneHints, e164 }).zones
    const local = zones[0] ? localTimeIn(zones[0], now).label : ''
    return {
      allowed: true,
      basis: 'Own team number',
      purpose: facts.purpose,
      e164,
      zones,
      calleeLocalTime: local,
      calleeZone: zones.length === 1 ? zones[0] : zones.length ? 'several zones' : 'unknown',
      overridden: false,
    }
  }

  let basis: string | null = null
  if (facts.channel === 'CALL' && facts.purpose === 'servicing' && facts.servicingBasis) basis = facts.servicingBasis
  if (!basis) basis = consentBasis(facts.consent, now)
  if (!basis) return block('NO_CONSENT', REASONS.NO_CONSENT)

  // A person who texted us in the last 30 minutes may get a reply at any hour.
  const { zones, states } = calleeZones({ ...facts.zoneHints, e164 })
  if (facts.channel === 'SMS' && facts.replyWindowOpen) {
    const local = zones[0] ? localTimeIn(zones[0], now).label : ''
    return {
      allowed: true,
      basis: `${basis}; replying within 30 minutes of their text`,
      purpose: facts.purpose,
      e164,
      zones,
      calleeLocalTime: local,
      calleeZone: zones.length === 1 ? zones[0] : zones.length ? 'several zones' : 'unknown',
      overridden: false,
    }
  }
  if (zones.length === 0) return block('UNKNOWN_TIMEZONE', REASONS.UNKNOWN_TIMEZONE)

  const account = facts.callWindow ?? DEFAULT_WINDOW
  const inAccount = windowOk(zones, now, account, facts.purpose, states)
  const allow = (overridden: boolean): OutboundDecision => {
    const first = localTimeIn(zones[0], now)
    return {
      allowed: true,
      basis: overridden ? `${basis}; hours override` : basis!,
      purpose: facts.purpose,
      e164,
      zones,
      calleeLocalTime: first.label,
      calleeZone: zones.length === 1 ? zones[0] : 'several zones',
      overridden,
    }
  }
  if (inAccount.ok) return allow(false)

  const fail = inAccount.failures[0]
  const what = facts.channel === 'CALL' ? 'Calls' : 'Texts'
  const retryAt = deferUntil(now, zones, account, facts.purpose, states)
  let reason: string
  if (fail.reason === 'sunday') {
    reason = `It's Sunday for them. Marketing ${what.toLowerCase()} skip Sundays.`
  } else if (fail.reason === 'holiday') {
    reason = `It's ${fail.holiday ?? 'a federal holiday'} for them. Marketing ${what.toLowerCase()} skip federal holidays.`
  } else if (fail.reason === 'state_day') {
    reason = `Their state doesn't allow these ${what.toLowerCase()} today.`
  } else {
    const opens = retryAt ? localTimeIn(fail.zone, retryAt).label : hourLabel(account.start)
    reason = `It's ${fail.local.label} for them. ${what} can go out after ${opens} their time.`
  }

  // Only calls can be overridden, only inside the legal ceiling, only on an
  // ordinary day: the ceiling check runs the same day rules again.
  let canOverride: 'hours' | null = null
  if (facts.channel === 'CALL' && inAccount.failures.every((f) => f.reason === 'hours')) {
    const inCeiling = windowOk(zones, now, LEGAL_WINDOW, facts.purpose, states)
    if (inCeiling.ok) canOverride = 'hours'
  }
  if (canOverride && opts.override) return allow(true)
  return block('OUTSIDE_HOURS', reason, { canOverride, retryAt })
}

// ── Hours-override tokens ───────────────────────────────────────────────────

export type OverrideClaims = {
  orgId: string
  userId: string
  target: string
  lineId: string
  code: OutboundBlockCode
  /** Expiry, ms since epoch. */
  exp: number
  nonce: string
}

export const OVERRIDE_TTL_MS = 2 * 60_000

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url')
}

/** HMAC-SHA256 keyed by TELEPHONY_OVERRIDE_KEY over the claims. Null when the key is missing. */
export function signOverride(
  claims: Omit<OverrideClaims, 'exp' | 'nonce'> & { exp?: number; nonce?: string },
  now: Date,
  key: string | undefined = process.env.TELEPHONY_OVERRIDE_KEY,
): string | null {
  if (!key) return null
  const full: OverrideClaims = {
    ...claims,
    exp: claims.exp ?? now.getTime() + OVERRIDE_TTL_MS,
    nonce: claims.nonce ?? randomBytes(16).toString('hex'),
  }
  const body = b64url(JSON.stringify(full))
  const sig = b64url(createHmac('sha256', key).update(body).digest())
  return `${body}.${sig}`
}

export type OverrideCheck = { ok: true; nonce: string } | { ok: false; reason: string }

/** Every field must match what the webhook is about to do. The nonce is single-use (VoiceCall.overrideNonce @unique). */
export function verifyOverride(
  token: string | null | undefined,
  expect: { orgId: string; userId: string; target: string; lineId: string; code: OutboundBlockCode },
  now: Date,
  key: string | undefined = process.env.TELEPHONY_OVERRIDE_KEY,
): OverrideCheck {
  if (!token || !key) return { ok: false, reason: 'No override.' }
  const [body, sig] = token.split('.')
  if (!body || !sig) return { ok: false, reason: 'Malformed override.' }
  const expected = createHmac('sha256', key).update(body).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, reason: 'Bad override signature.' }
  let claims: OverrideClaims
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OverrideClaims
  } catch {
    return { ok: false, reason: 'Malformed override.' }
  }
  if (typeof claims.exp !== 'number' || claims.exp < now.getTime()) return { ok: false, reason: 'Override expired.' }
  for (const field of ['orgId', 'userId', 'target', 'lineId', 'code'] as const) {
    if (claims[field] !== expect[field]) return { ok: false, reason: `Override does not match (${field}).` }
  }
  if (typeof claims.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(claims.nonce)) return { ok: false, reason: 'Malformed override.' }
  return { ok: true, nonce: claims.nonce }
}
