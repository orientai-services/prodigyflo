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
import type { OutboundBlockCode, OutboundPurpose, OverrideKind } from './voice-contract'

/**
 * The pure half of the one outbound decision (docs/TELEPHONY_LIVE.md §2.7).
 *
 * No database and no `server-only`, so every precedence row, the consent
 * expiry by source and the override token are unit-tested directly. The
 * loader that gathers these facts lives in compliance.ts.
 *
 * Precedence, first match wins:
 *   1 invalid number          → INVALID_NUMBER   never overridable
 *   2 suppression (channel)   → SUPPRESSED       calls: admin override unless STOP-made
 *   3 SMS opt-out             → OPTED_OUT        never overridable
 *   4 lead do-not-call        → SUPPRESSED       calls: admin override
 *   5 own line / team number  → allow
 *   6 servicing call          → allow (hours still apply)
 *   7 consent on file         → allow (hours still apply)
 *   9 anything else           → NO_CONSENT       calls: admin override
 * Then UNKNOWN_TIMEZONE and OUTSIDE_HOURS (calls: admin override, any hour).
 * Hours (calls and texts) are checked on every allow path except 5.
 *
 * Admin overrides are for CALLS only, for telephony:manage holders, with a
 * typed reason (checkDial). Texts are never overridable. Nobody can override
 * a person's own request to stop (a STOP-made block, revoked consent, a
 * possible opt-out still under review): calling them anyway breaks the TCPA.
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
  /** 'manual' | 'call_center' | 'import' are admin-overridable; 'sms_stop' never is. */
  callBlockedSource?: string | null
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
      /** The blocks an admin override stepped past, in the order they were met. */
      waived: OutboundBlockCode[]
    }
  | {
      allowed: false
      code: OutboundBlockCode
      reason: string
      /** Calls only, and only for telephony:manage holders (checkDial masks it for everyone else). */
      canOverride: OverrideKind | null
      /** Overridable blocks: what the admin must weigh before "Call anyway". */
      warning?: string
      /** OUTSIDE_HOURS only: the next time the window opens (for deferral). */
      retryAt?: Date | null
      /** OUTSIDE_HOURS only: also outside the legal ceiling (or a marketing Sunday / holiday). */
      pastLegalHours?: boolean
      /** SUPPRESSED only: texts are held while an admin reviews a possible opt-out (it may be lifted). */
      held?: boolean
    }

function block(
  code: OutboundBlockCode,
  reason: string,
  extra: { canOverride?: OverrideKind | null; warning?: string; retryAt?: Date | null; pastLegalHours?: boolean; held?: boolean } = {},
): OutboundDecision {
  return {
    allowed: false,
    code,
    reason,
    canOverride: extra.canOverride ?? null,
    ...(extra.canOverride && extra.warning ? { warning: extra.warning } : {}),
    ...(extra.retryAt !== undefined ? { retryAt: extra.retryAt } : {}),
    ...(extra.pastLegalHours ? { pastLegalHours: true } : {}),
    ...(extra.held ? { held: true } : {}),
  }
}

/** A suppression row blocks this channel. A legacy row with both pairs null blocks both until removed. */
export function suppressionBlocks(row: SuppressionFact | null, channel: OutboundChannel): boolean {
  if (!row || row.removedAt) return false
  if (!row.smsBlockedAt && !row.callBlockedAt) return true
  return channel === 'CALL' ? Boolean(row.callBlockedAt) : Boolean(row.smsBlockedAt)
}

/** Call-block sources an admin may step past. A legacy row (both pairs empty) reads as 'import'. */
const OVERRIDABLE_CALL_SOURCES = new Set(['manual', 'call_center', 'import'])

function callBlockSource(row: SuppressionFact): string | null {
  if (!row.smsBlockedAt && !row.callBlockedAt) return 'import'
  return row.callBlockedSource ?? null
}

/**
 * The person themselves asked us to stop: a STOP-made block on either
 * channel, a lead's revoked consent (only STOP or a confirmed opt-out sets
 * it), or a client's STOP / revoked TCPA consent.
 */
export function personOptedOut(facts: Pick<OutboundFacts, 'suppression' | 'smsOptedOut' | 'consent'>): boolean {
  const s = facts.suppression
  if (s && !s.removedAt) {
    if (s.smsBlockedAt && s.smsBlockedSource === 'sms_stop') return true
    if (s.callBlockedAt && s.callBlockedSource === 'sms_stop') return true
  }
  if (facts.smsOptedOut) return true
  const c = facts.consent
  if (c?.kind === 'lead' && c.consentRevokedAt) return true
  if (c?.kind === 'client') {
    const latest = [...c.consents].sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())[0]
    if (latest?.revokedAt) return true
  }
  return false
}

function optOutUnderReview(s: SuppressionFact | null): boolean {
  return Boolean(s && !s.removedAt && s.smsBlockedAt && s.smsBlockedSource === 'sms_stop_review')
}

const WAIVED_LABEL: Partial<Record<OutboundBlockCode, string>> = {
  SUPPRESSED: 'do-not-call',
  NO_CONSENT: 'no consent',
  UNKNOWN_TIMEZONE: 'unknown time zone',
  OUTSIDE_HOURS: 'hours',
}

export function waivedLabel(codes: readonly OutboundBlockCode[]): string {
  return codes.map((c) => WAIVED_LABEL[c] ?? c).join(', ')
}

export const REASONS = {
  INVALID_NUMBER: "That isn't a valid phone number.",
  SUPPRESSED_CALL: 'This number is on the do-not-call list.',
  SUPPRESSED_SMS: 'Texts to this number are blocked (opt-out or do-not-contact list).',
  HELD_SMS: 'Texts to this number are on hold until an admin reviews a possible opt-out.',
  OPTED_OUT: 'They replied STOP. Texts to this number are off.',
  NO_CONSENT: 'No consent on file for this number.',
  UNKNOWN_TIMEZONE: "We don't know their time zone. Press Call and pick where they are, then try again.",
  PERSON_OPTED_OUT: "This person asked us to stop contacting them. It can't be overridden.",
  OPTOUT_REVIEW: "This person may have asked us to stop. An admin must review the possible opt-out on the do-not-call list first. It can't be overridden.",
} as const

export const WARNINGS = {
  DNC: 'Only override if this person did NOT ask us to stop calling.',
  NO_CONSENT: 'Only override if you know they want this call. Calling a marketing lead without consent can break telemarketing law.',
  UNKNOWN_TIMEZONE: "Only override if you know it's a reasonable hour where they are.",
  PAST_LEGAL_HOURS: 'This is outside the legal calling hours (8 am to 9 pm their time, no marketing calls on Sundays or federal holidays). Only call if they asked you to call now.',
} as const

/**
 * `override` is set only after an admin (telephony:manage) asked to call
 * anyway with a reason. `true` steps past every overridable block (checkDial);
 * `{ waive }` only past the listed codes (the TwiML side, from the signed
 * token). It never reaches texts, an invalid number, or a person's own
 * request to stop.
 */
export function evaluateOutbound(
  facts: OutboundFacts,
  now: Date,
  opts: { override?: boolean | { waive: readonly OutboundBlockCode[] } } = {},
): OutboundDecision {
  const e164 = facts.phone ? toE164(facts.phone) : null
  if (!e164) return block('INVALID_NUMBER', REASONS.INVALID_NUMBER)

  const call = facts.channel === 'CALL'
  const waived: OutboundBlockCode[] = []
  const waives = (code: OutboundBlockCode): boolean => {
    if (!call || !opts.override) return false
    return opts.override === true || opts.override.waive.includes(code)
  }
  // The person's own stop request locks the consent and do-not-call overrides.
  const lock = !call
    ? null
    : personOptedOut(facts)
      ? REASONS.PERSON_OPTED_OUT
      : optOutUnderReview(facts.suppression)
        ? REASONS.OPTOUT_REVIEW
        : null
  /** An overridable call block: waived (null, carry on) or returned. */
  const restriction = (
    code: OutboundBlockCode,
    reason: string,
    warning: string,
    extra: { lockable?: boolean; kind?: OverrideKind; retryAt?: Date | null; pastLegalHours?: boolean } = {},
  ): OutboundDecision | null => {
    if (extra.lockable && lock) return block(code, lock)
    if (waives(code)) {
      if (!waived.includes(code)) waived.push(code)
      return null
    }
    return block(code, reason, {
      canOverride: extra.kind ?? 'restriction',
      warning,
      retryAt: extra.retryAt,
      pastLegalHours: extra.pastLegalHours,
    })
  }

  const allowed = (basis: string, zones: string[], local: string): OutboundDecision => ({
    allowed: true,
    basis:
      waived.length === 0
        ? basis
        : waived.length === 1 && waived[0] === 'OUTSIDE_HOURS'
          ? `${basis}; hours override`
          : `${basis}; admin override (${waivedLabel(waived)})`,
    purpose: facts.purpose,
    e164,
    zones,
    calleeLocalTime: local,
    calleeZone: zones.length === 1 ? zones[0] : zones.length ? 'several zones' : 'unknown',
    overridden: waived.length > 0,
    waived: [...waived],
  })

  if (suppressionBlocks(facts.suppression, facts.channel)) {
    if (!call) {
      if (facts.suppression?.smsBlockedSource === 'sms_stop_review') return block('SUPPRESSED', REASONS.HELD_SMS, { held: true })
      return block('SUPPRESSED', REASONS.SUPPRESSED_SMS)
    }
    const source = callBlockSource(facts.suppression!)
    if (source === 'sms_stop') return block('SUPPRESSED', REASONS.PERSON_OPTED_OUT)
    // An unknown source fails closed: not overridable.
    if (!source || !OVERRIDABLE_CALL_SOURCES.has(source)) return block('SUPPRESSED', REASONS.SUPPRESSED_CALL)
    const stop = restriction('SUPPRESSED', REASONS.SUPPRESSED_CALL, WARNINGS.DNC, { lockable: true })
    if (stop) return stop
  }
  if (!call && facts.smsOptedOut) return block('OPTED_OUT', REASONS.OPTED_OUT)
  if (facts.leadDoNotCall) {
    if (!call) return block('SUPPRESSED', REASONS.SUPPRESSED_CALL)
    const stop = restriction('SUPPRESSED', REASONS.SUPPRESSED_CALL, WARNINGS.DNC, { lockable: true })
    if (stop) return stop
  }

  if (facts.ownNumber) {
    const zones = calleeZones({ ...facts.zoneHints, e164 }).zones
    return allowed('Own team number', zones, zones[0] ? localTimeIn(zones[0], now).label : '')
  }

  let basis: string | null = null
  if (call && facts.purpose === 'servicing' && facts.servicingBasis) basis = facts.servicingBasis
  if (!basis) basis = consentBasis(facts.consent, now)
  if (!basis) {
    if (!call) return block('NO_CONSENT', REASONS.NO_CONSENT)
    const stop = restriction('NO_CONSENT', REASONS.NO_CONSENT, WARNINGS.NO_CONSENT, { lockable: true })
    if (stop) return stop
    basis = 'No consent on file'
  }

  // A person who texted us in the last 30 minutes may get a reply at any hour.
  const { zones, states } = calleeZones({ ...facts.zoneHints, e164 })
  if (!call && facts.replyWindowOpen) {
    const local = zones[0] ? localTimeIn(zones[0], now).label : ''
    return allowed(`${basis}; replying within 30 minutes of their text`, zones, local)
  }
  if (zones.length === 0) {
    if (!call) return block('UNKNOWN_TIMEZONE', REASONS.UNKNOWN_TIMEZONE)
    const stop = restriction('UNKNOWN_TIMEZONE', REASONS.UNKNOWN_TIMEZONE, WARNINGS.UNKNOWN_TIMEZONE)
    if (stop) return stop
    // No zone means no hours to check: the override covers the time of day too.
    return allowed(basis, zones, '')
  }

  const account = facts.callWindow ?? DEFAULT_WINDOW
  const inAccount = windowOk(zones, now, account, facts.purpose, states)
  const allow = (): OutboundDecision => allowed(basis!, zones, localTimeIn(zones[0], now).label)
  if (inAccount.ok) return allow()

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

  if (!call) return block('OUTSIDE_HOURS', reason, { retryAt })
  // An admin may call at any hour. Inside the legal ceiling on an ordinary day
  // (the ceiling check runs the same day rules again) it is a plain stretch of
  // the account window; past it, the prompt says so and the audit records it.
  const pastLegalHours = !withinLegalCeiling(zones, now, facts.purpose, states, inAccount.failures)
  const stop = restriction('OUTSIDE_HOURS', reason, pastLegalHours ? WARNINGS.PAST_LEGAL_HOURS : '', {
    kind: 'hours',
    retryAt,
    pastLegalHours,
  })
  return stop ?? allow()
}

/** Outside the account window only by the hour, and inside the federal 8:00–21:00 ceiling (plus state rules). */
export function withinLegalCeiling(
  zones: readonly string[],
  now: Date,
  purpose: OutboundPurpose,
  states: readonly string[],
  failures: readonly { reason: string }[],
): boolean {
  if (!failures.every((f) => f.reason === 'hours')) return false
  return windowOk(zones, now, LEGAL_WINDOW, purpose, states).ok
}

// ── Override tokens ─────────────────────────────────────────────────────────

export type OverrideClaims = {
  orgId: string
  userId: string
  target: string
  lineId: string
  /** The first block the admin saw. */
  code: OutboundBlockCode
  /** Every block the override may step past (checkDial's decision). Defaults to [code]. */
  waive?: OutboundBlockCode[]
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

export type OverrideCheck = { ok: true; nonce: string; waive: OutboundBlockCode[] } | { ok: false; reason: string }

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
  const waive = claims.waive ?? [claims.code]
  if (!Array.isArray(waive) || !waive.every((c) => typeof c === 'string')) return { ok: false, reason: 'Malformed override.' }
  return { ok: true, nonce: claims.nonce, waive }
}
