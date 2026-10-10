import 'server-only'
import { db } from '@/lib/db'
import { appOrigin, platformCredentials, telephonyCredentialsDetailed } from './index'
import { resolveInboundNumber, resolveInboundNumberById, type InboundNumber } from './calls'
import {
  allowUnsignedWebhooks,
  candidateWebhookUrls,
  formToParams,
  TWILIO_SIGNATURE_HEADER,
  validateTwilioSignatureAny,
  webhookHostAllowlist,
} from './signature'
import { toE164, type TelephonyCredentials } from './provider'
import { parseIdentity } from './access-token'

/**
 * The shared front door for every carrier webhook.
 *
 * Each route needs the same things before it may act: the posted form, the
 * resource the traffic is about (the line, or the call), and proof that Twilio
 * — not a stranger with the URL — sent it. Doing that in one place is what
 * keeps the individual routes short enough to read in one screen.
 *
 * Order matters (docs/TELEPHONY_LIVE.md §2.2):
 *
 *  1. Find the resource. Untrusted until step 2 — the lookup only picks WHICH
 *     auth token to check with (the account that owns the line or call).
 *  2. Verify X-Twilio-Signature against every URL Twilio may have signed
 *     (APP_URL's origin, then an allowlisted forwarded host). Unknown resource
 *     → check with the PLATFORM token instead. A bad or missing signature is a
 *     bare 403 whether or not the line exists, so line existence never leaks
 *     to an unauthenticated probe.
 *  3. AccountSid in the form must be the resolved account's.
 *
 * Only a request that verified gets the "unknown resource" answer.
 *
 * TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS=true skips the signature, but only in local
 * development with the mock carrier (allowUnsignedWebhooks). In production it
 * is ignored and a warning names the variable once per cold start.
 */

export type WebhookContext = {
  params: Record<string, string>
  number: InboundNumber
  /** The number that was dialled / texted, E.164. */
  to: string
  /** The caller / sender, E.164 where parseable, raw otherwise. */
  from: string
  /** Account the line is on ('mock' when developing unsigned without credentials). */
  accountSid: string
  creds: TelephonyCredentials | null
}

export type WebhookRejection = {
  status: number
  reason: string
  /** Signed, but the resource is not ours: answer the route's "unknown" shape. */
  unknown?: boolean
  /** With `unknown` only: the verified form, for routes that must still act (an opt-out). */
  params?: Record<string, string>
}

let warnedUnsigned = false

function unsignedAllowed(): boolean {
  if (allowUnsignedWebhooks()) return true
  if (process.env.TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS === 'true' && !warnedUnsigned) {
    warnedUnsigned = true
    console.warn('[telephony] TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS is set but ignored outside local mock development.')
  }
  return false
}

async function readForm(request: Request): Promise<Record<string, string> | null> {
  try {
    return formToParams(await request.formData())
  } catch {
    return null
  }
}

function signatureValid(request: Request, params: Record<string, string>, creds: TelephonyCredentials | null): boolean {
  if (!creds) return false
  return validateTwilioSignatureAny({
    authToken: creds.authToken,
    urls: candidateWebhookUrls(request, appOrigin(), webhookHostAllowlist()),
    params,
    header: request.headers.get(TWILIO_SIGNATURE_HEADER),
  })
}

const FORBIDDEN: WebhookRejection = { status: 403, reason: 'Forbidden.' }

/**
 * Verify a request whose resource could not be found: platform token only.
 * Signed → the caller's "unknown" answer; anything else → 403.
 */
function unknownResource(request: Request, params: Record<string, string>): WebhookRejection {
  if (unsignedAllowed()) return { status: 404, reason: 'Not in service here.', unknown: true, params }
  return signatureValid(request, params, platformCredentials())
    ? { status: 404, reason: 'Not in service here.', unknown: true, params }
    : FORBIDDEN
}

/**
 * The account a line's traffic is signed by. A line recorded on the platform
 * subaccount (providerAccountSid is written by purchase and sync, never by a
 * tenant) is checked with the platform's own token, even when its org also
 * has vault credentials; otherwise the org's credentials decide.
 */
export async function lineCredentials(
  number: Pick<InboundNumber, 'organizationId' | 'providerAccountSid'>,
): Promise<TelephonyCredentials | null> {
  const platform = platformCredentials()
  if (platform && number.providerAccountSid === platform.accountSid) return platform
  return (await telephonyCredentialsDetailed(number.organizationId)).creds
}

function accountMatches(params: Record<string, string>, creds: TelephonyCredentials | null): boolean {
  if (!creds) return true // unsigned local development only
  return params.AccountSid === creds.accountSid
}

/** Number webhooks: voice, voice/dial, voice/recording, voice/status, sms. Found by `To`. */
export async function authenticateWebhook(
  request: Request,
): Promise<{ ok: true; ctx: WebhookContext } | { ok: false; rejection: WebhookRejection }> {
  const params = await readForm(request)
  if (!params) return { ok: false, rejection: { status: 400, reason: 'Body must be form-encoded.' } }

  let to = toE164(params.To ?? '') ?? params.To ?? ''
  let number = to ? await resolveInboundNumber(to) : null
  if (!number) {
    // Child-leg status callbacks (To = the person we rang) and async recording
    // callbacks (no To at all) don't name our line. Our own URLs carry the
    // parent ?callSid=, which finds the call and through it the line — still
    // untrusted until the signature below checks out.
    const parent = new URL(request.url).searchParams.get('callSid')
    const vc = parent
      ? await db.voiceCall.findUnique({ where: { callSid: parent }, select: { phoneNumberId: true } })
      : null
    number = vc?.phoneNumberId ? await resolveInboundNumberById(vc.phoneNumberId) : null
    if (number) to = number.e164
  }
  if (!number) return { ok: false, rejection: unknownResource(request, params) }

  const creds = await lineCredentials(number)
  if (!unsignedAllowed()) {
    if (!signatureValid(request, params, creds)) return { ok: false, rejection: FORBIDDEN }
    if (!accountMatches(params, creds)) return { ok: false, rejection: FORBIDDEN }
  }

  return {
    ok: true,
    ctx: {
      params,
      number,
      to,
      from: toE164(params.From ?? '') ?? params.From ?? '',
      accountSid: creds?.accountSid ?? params.AccountSid ?? 'mock',
      creds,
    },
  }
}

// ── Browser-call webhooks (P0b) ──────────────────────────────────────────────

export type ClientWebhookContext = {
  params: Record<string, string>
  organizationId: string
  accountSid: string
  creds: TelephonyCredentials | null
  /** For by: 'identity' — the user the browser is signed in as. */
  userId?: string
  /** For by: 'voiceCall' / 'parent' — the ledger row. */
  voiceCallId?: string
}

/**
 * Browser-call webhooks. `by` says how the account is found:
 *   identity  From = client:pf_<org>_<user>  (client/voice; platform account only)
 *   voiceCall ?vc=<VoiceCall id>             (client/dial, status, recording, whisper)
 *   parent    CallSid → VoiceCall, else the platform (client/status?parent=1)
 */
export async function authenticateClientWebhook(
  request: Request,
  by: 'identity' | 'voiceCall' | 'parent',
): Promise<{ ok: true; ctx: ClientWebhookContext } | { ok: false; rejection: WebhookRejection }> {
  const params = await readForm(request)
  if (!params) return { ok: false, rejection: { status: 400, reason: 'Body must be form-encoded.' } }

  let organizationId: string | null = null
  let voiceCallId: string | undefined
  let userId: string | undefined
  let creds: TelephonyCredentials | null = null
  let expectedAccount: string | null = null

  if (by === 'identity') {
    const who = parseIdentity(params.From)
    if (who) {
      const org = await db.organization.findFirst({ where: { id: who.organizationId, deletedAt: null }, select: { id: true } })
      if (org) {
        organizationId = org.id
        userId = who.userId
        const detailed = await telephonyCredentialsDetailed(org.id)
        // Browser calling rides the platform subaccount only (§2.1).
        creds = detailed.creds && detailed.source === 'platform' ? detailed.creds : null
        if (!creds) return { ok: false, rejection: unsignedAllowed() ? { status: 404, reason: 'Not set up.', unknown: true } : FORBIDDEN }
      }
    }
  } else {
    const vcId = by === 'voiceCall' ? new URL(request.url).searchParams.get('vc') : null
    const row = vcId
      ? await db.voiceCall.findUnique({ where: { id: vcId }, select: { id: true, organizationId: true, accountSid: true } })
      : params.CallSid
        ? await db.voiceCall.findUnique({ where: { callSid: params.CallSid }, select: { id: true, organizationId: true, accountSid: true } })
        : null
    if (row) {
      organizationId = row.organizationId
      voiceCallId = row.id
      expectedAccount = row.accountSid
      const detailed = await telephonyCredentialsDetailed(row.organizationId)
      creds = detailed.creds && detailed.creds.accountSid === row.accountSid ? detailed.creds : null
      if (!creds && row.accountSid === platformCredentials()?.accountSid) creds = platformCredentials()
    } else if (by === 'parent' && !unsignedAllowed()) {
      // The TwiML App's own status callback for a call we never recorded.
      return { ok: false, rejection: unknownResource(request, params) }
    }
  }

  if (!organizationId) return { ok: false, rejection: unknownResource(request, params) }

  if (!unsignedAllowed()) {
    if (!signatureValid(request, params, creds)) return { ok: false, rejection: FORBIDDEN }
    if (!accountMatches(params, creds)) return { ok: false, rejection: FORBIDDEN }
    if (expectedAccount && creds && creds.accountSid !== expectedAccount) return { ok: false, rejection: FORBIDDEN }
    if (by === 'identity') {
      const appSid = process.env.TWILIO_TWIML_APP_SID?.trim()
      if (!appSid || params.ApplicationSid !== appSid) return { ok: false, rejection: FORBIDDEN }
    }
  }

  return {
    ok: true,
    ctx: {
      params,
      organizationId,
      accountSid: creds?.accountSid ?? expectedAccount ?? params.AccountSid ?? 'mock',
      creds,
      ...(userId ? { userId } : {}),
      ...(voiceCallId ? { voiceCallId } : {}),
    },
  }
}

// ── SMS status callbacks ─────────────────────────────────────────────────────

export type SmsStatusContext = {
  params: Record<string, string>
  organizationId: string
  accountSid: string
  /** The Communication this status is about, when we sent it. */
  communicationId: string | null
}

/** MessageSid → Communication → client's org; else From → our line; else the platform. */
export async function authenticateSmsStatusWebhook(
  request: Request,
): Promise<{ ok: true; ctx: SmsStatusContext } | { ok: false; rejection: WebhookRejection }> {
  const params = await readForm(request)
  if (!params) return { ok: false, rejection: { status: 400, reason: 'Body must be form-encoded.' } }

  const messageSid = params.MessageSid || params.SmsSid || ''
  const comm = messageSid
    ? await db.communication.findFirst({
        where: { externalRef: messageSid, channel: 'SMS', direction: 'OUTBOUND' },
        select: { id: true, client: { select: { organizationId: true } } },
      })
    : null
  let organizationId = comm?.client.organizationId ?? null
  if (!organizationId) {
    const from = toE164(params.From ?? '')
    const line = from ? await db.phoneNumber.findUnique({ where: { e164: from }, select: { organizationId: true } }) : null
    organizationId = line?.organizationId ?? null
  }
  if (!organizationId) return { ok: false, rejection: unknownResource(request, params) }

  const creds = (await telephonyCredentialsDetailed(organizationId)).creds
  if (!unsignedAllowed()) {
    if (!signatureValid(request, params, creds)) return { ok: false, rejection: FORBIDDEN }
    if (!accountMatches(params, creds)) return { ok: false, rejection: FORBIDDEN }
  }
  return {
    ok: true,
    ctx: { params, organizationId, accountSid: creds?.accountSid ?? params.AccountSid ?? 'mock', communicationId: comm?.id ?? null },
  }
}

// ── URLs woven into our TwiML ────────────────────────────────────────────────

export type CallbackExtras = { stage?: string; i?: number; kind?: 'call' | 'voicemail'; leg?: 'child' }

function query(callSid: string, extra: CallbackExtras = {}): string {
  const q = new URLSearchParams({ callSid })
  if (extra.stage) q.set('stage', extra.stage)
  if (typeof extra.i === 'number') q.set('i', String(extra.i))
  if (extra.kind) q.set('kind', extra.kind)
  if (extra.leg) q.set('leg', extra.leg)
  return `?${q.toString()}`
}

/** Absolute callback URLs woven into the TwiML we answer inbound calls with. */
export function callbackUrls(
  callSid: string,
  extra: CallbackExtras = {},
): { dial: string; recording: string; voicemail: string; callRecording: string; childStatus: string } {
  const base = appOrigin()
  return {
    dial: `${base}/api/telephony/voice/dial${query(callSid, { stage: extra.stage, i: extra.i })}`,
    recording: `${base}/api/telephony/voice/recording${query(callSid, { kind: extra.kind ?? 'voicemail' })}`,
    voicemail: `${base}/api/telephony/voice/recording${query(callSid, { kind: 'voicemail' })}`,
    callRecording: `${base}/api/telephony/voice/recording${query(callSid, { kind: 'call' })}`,
    childStatus: `${base}/api/telephony/voice/status${query(callSid, { leg: 'child', stage: extra.stage, i: extra.i })}`,
  }
}

/** Absolute URLs for an outbound browser call's ledger row. */
export function clientCallbackUrls(voiceCallId: string): {
  dial: string
  status: string
  recording: string
  whisper: string
} {
  const base = appOrigin()
  const q = `?vc=${encodeURIComponent(voiceCallId)}`
  return {
    dial: `${base}/api/telephony/client/dial${q}`,
    status: `${base}/api/telephony/client/status${q}`,
    recording: `${base}/api/telephony/client/recording${q}`,
    whisper: `${base}/api/telephony/client/whisper${q}`,
  }
}
