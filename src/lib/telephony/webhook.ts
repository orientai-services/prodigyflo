import 'server-only'
import { appOrigin, telephonyCredentials } from './index'
import { resolveInboundNumber, type InboundNumber } from './calls'
import { formToParams, publicWebhookUrl, TWILIO_SIGNATURE_HEADER, validateTwilioSignature } from './signature'
import { toE164 } from './provider'

/**
 * The shared front door for every carrier webhook.
 *
 * Each of the four routes needs the same three things before it may act:
 * the posted form, the account line the traffic arrived on, and proof that
 * Twilio — not a stranger with the URL — sent it. Doing that in one place is
 * what keeps the individual routes short enough to read in one screen.
 *
 * The auth token used to check the signature is the one belonging to the
 * account that owns the dialled number, so an install with per-account Twilio
 * subaccounts validates each account against its own key.
 *
 * TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS=true skips the signature check. It exists
 * for local development against the mock carrier (where no token exists to
 * sign with) and is opt-in, never inferred from NODE_ENV — a webhook endpoint
 * that quietly trusts anyone because a var was missing is how these get
 * abused.
 */

export type WebhookContext = {
  params: Record<string, string>
  number: InboundNumber
  /** The number that was dialled / texted, E.164. */
  to: string
  /** The caller / sender, E.164 where parseable, raw otherwise. */
  from: string
}

export type WebhookRejection = { status: number; reason: string }

export async function authenticateWebhook(
  request: Request,
): Promise<{ ok: true; ctx: WebhookContext } | { ok: false; rejection: WebhookRejection }> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return { ok: false, rejection: { status: 400, reason: 'Body must be form-encoded.' } }
  }
  const params = formToParams(form)

  const to = toE164(params.To ?? '') ?? params.To ?? ''
  if (!to) return { ok: false, rejection: { status: 400, reason: 'Missing To.' } }

  const number = await resolveInboundNumber(to)
  if (!number) return { ok: false, rejection: { status: 404, reason: 'Number not in service here.' } }

  const allowUnsigned = process.env.TELEPHONY_ALLOW_UNSIGNED_WEBHOOKS === 'true'
  if (!allowUnsigned) {
    const creds = await telephonyCredentials(number.organizationId)
    const valid = validateTwilioSignature({
      authToken: creds?.authToken,
      url: publicWebhookUrl(request, appOrigin()),
      params,
      header: request.headers.get(TWILIO_SIGNATURE_HEADER),
    })
    if (!valid) return { ok: false, rejection: { status: 403, reason: 'Invalid signature.' } }
  }

  return {
    ok: true,
    ctx: { params, number, to, from: toE164(params.From ?? '') ?? params.From ?? '' },
  }
}

/** Absolute callback URLs woven into the TwiML we answer with. */
export function callbackUrls(callSid: string): { dial: string; recording: string } {
  const base = appOrigin()
  const q = `?callSid=${encodeURIComponent(callSid)}`
  return {
    dial: `${base}/api/telephony/voice/dial${q}`,
    recording: `${base}/api/telephony/voice/recording${q}`,
  }
}
