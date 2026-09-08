import type { OutboundSms, SendResult, SmsProvider } from './provider'
import { vaultCredentials } from './vault'
import { accountSendingNumber } from './sending-number'

/**
 * Twilio SMS adapter — the first real SmsProvider.
 *
 * Selected via SMS_PROVIDER=twilio. Credentials come from the connector vault
 * when the org has stored them (twilio-sms: accountSid / authToken /
 * fromNumber), then from its agency's vault entry, and otherwise from
 * TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER. Like every adapter, failures surface as FAILED
 * SendResults with the provider's own error text — never a faked SENT.
 *
 * The From number prefers the ACCOUNT'S OWN main line (Settings → Phone
 * numbers) over any shared configured number, so a text from CYS comes from
 * the CYS line and its reply routes back to CYS. The configured fromNumber is
 * the fallback for accounts that have not bought a number yet.
 *
 * Inbound webhooks (including STOP handling) live in inbound.ts and are
 * untouched by this adapter.
 */

export type TwilioConfig = {
  accountSid: string
  authToken: string
  /** E.164 sending number, e.g. +15551234567. */
  fromNumber: string
}

/** Pure request builder — exactly what will be fetched, testable offline. */
export function buildTwilioRequest(
  msg: Pick<OutboundSms, 'to' | 'body'>,
  config: TwilioConfig,
): { url: string; init: RequestInit } {
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')
  return {
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: msg.to, From: config.fromNumber, Body: msg.body }).toString(),
    },
  }
}

/**
 * Pure response mapping. Twilio answers 201 with status "queued" — that is its
 * confirmation of acceptance for delivery, which is the strongest signal a
 * fire-and-forget send gets, so it maps to SENT with the message SID as the
 * external ref. Anything else maps to FAILED with Twilio's own error text.
 */
export function twilioResultFromResponse(status: number, body: unknown): SendResult {
  const record = (body ?? {}) as Record<string, unknown>
  if (status >= 200 && status < 300) {
    return { status: 'SENT', externalRef: typeof record.sid === 'string' ? record.sid : null }
  }
  const message =
    typeof record.message === 'string' && record.message
      ? record.message
      : `Twilio API error (HTTP ${status}).`
  const code = typeof record.code === 'number' ? ` [code ${record.code}]` : ''
  return { status: 'FAILED', externalRef: null, error: `${message}${code}`.slice(0, 500) }
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio'

  async send(msg: OutboundSms): Promise<SendResult> {
    const vault = await vaultCredentials(msg.organizationId, 'TWILIO_SMS', { inheritFromParent: true })
    const accountSid = vault?.accountSid ?? process.env.TWILIO_ACCOUNT_SID?.trim() ?? ''
    const authToken = vault?.authToken ?? process.env.TWILIO_AUTH_TOKEN?.trim() ?? ''
    const ownedLine = msg.organizationId ? await accountSendingNumber(msg.organizationId) : null
    const fromNumber = ownedLine ?? vault?.fromNumber ?? process.env.TWILIO_FROM_NUMBER?.trim() ?? ''

    const missing = [
      !accountSid && 'TWILIO_ACCOUNT_SID',
      !authToken && 'TWILIO_AUTH_TOKEN',
      !fromNumber && 'TWILIO_FROM_NUMBER',
    ].filter(Boolean)
    if (missing.length > 0) {
      return {
        status: 'FAILED',
        externalRef: null,
        error: `SMS_PROVIDER=twilio but credentials are incomplete — missing ${missing.join(', ')}. Store them on the Twilio SMS connector, or buy this account a line under Settings → Phone numbers.`,
      }
    }

    try {
      const { url, init } = buildTwilioRequest(msg, { accountSid, authToken, fromNumber })
      const res = await fetch(url, init)
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        // Non-JSON error bodies still map to an honest FAILED below.
      }
      return twilioResultFromResponse(res.status, body)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { status: 'FAILED', externalRef: null, error: `Twilio request failed: ${detail}`.slice(0, 500) }
    }
  }
}
