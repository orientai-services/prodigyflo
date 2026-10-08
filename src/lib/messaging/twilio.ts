import type { OutboundSms, SendResult, SmsProvider } from './provider'
import { vaultCredentials } from './vault'
import { accountSendingNumber } from './sending-number'

/**
 * Twilio SMS adapter — the first real SmsProvider.
 *
 * Selected via SMS_PROVIDER=twilio. The account SID and token come from ONE
 * source (telephonyCredentialsDetailed: the org's vault, its agency's vault, or
 * the platform env) — never a vault SID paired with the env token. A stored but
 * unreadable vault entry refuses honestly. Like every adapter, failures surface
 * as FAILED SendResults with the provider's own error text — never a faked SENT.
 *
 * The From number is ALWAYS one of the account's own texting lines (Settings →
 * Phone numbers) on the carrier account the text goes out on, so a text from
 * CYS comes from the CYS line and its reply — STOP included — routes back to
 * CYS. The From number stored on the connector is never sent from directly,
 * not even next to an org's OWN Twilio SID and token: a number with no
 * PhoneNumber row can't route its replies, so a STOP to it would fail the
 * signature check (or never reach the app) and no opt-out would be written.
 * Such an org is told to sync the number in first. There is no shared
 * fallback number either: an account with no line of its own is told so
 * instead of texting from someone else's number, where the reply would land
 * in the wrong account.
 *
 * When the org has its own Messaging Service (settings.telephony.messagingServiceSid), the request
 * carries BOTH the service and that From, so the text goes out under that
 * org's A2P campaign from that org's own number. There is deliberately no
 * global Messaging Service: one pool for every org would send everyone's texts
 * under one brand.
 *
 * Every send asks Twilio to post delivery status to /api/telephony/sms/status:
 * a 201 "queued" only means the carrier ACCEPTED the text. 30034 (texting
 * registration pending) and every other delivery failure arrive there.
 *
 * Inbound webhooks (including STOP handling) live in inbound.ts.
 */

export const NO_TEXTING_LINE = 'This account has no texting line yet. Buy one under Settings → Phone numbers.'
export const FROM_NUMBER_NOT_SYNCED =
  "Your From number isn't one of this account's lines yet, so replies (STOP included) can't reach it. Use Sync numbers from Twilio under Settings → Phone numbers."

export type TwilioConfig = {
  accountSid: string
  authToken: string
  /** E.164 sending number, e.g. +15551234567. */
  fromNumber: string
  /** The org's own Messaging Service (MG…), sent together with From. */
  messagingServiceSid?: string | null
  /** Absolute URL Twilio posts delivery status to. */
  statusCallback?: string | null
}

/** Pure request builder — exactly what will be fetched, testable offline. */
export function buildTwilioRequest(
  msg: Pick<OutboundSms, 'to' | 'body'>,
  config: TwilioConfig,
): { url: string; init: RequestInit } {
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')
  const params = new URLSearchParams({ To: msg.to, From: config.fromNumber, Body: msg.body })
  if (config.messagingServiceSid) params.set('MessagingServiceSid', config.messagingServiceSid)
  if (config.statusCallback) params.set('StatusCallback', config.statusCallback)
  return {
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    },
  }
}

/**
 * Pure response mapping. Twilio answers 201 with status "queued" — that is its
 * confirmation of acceptance for delivery, which is the strongest signal a
 * fire-and-forget send gets, so it maps to SENT ("Accepted by carrier" in the
 * UI) with the message SID as the external ref; the status callback moves it
 * on. Anything else maps to FAILED with Twilio's own error text and code.
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
    const { appOrigin, platformCredentials, telephonyCredentialsDetailed } = await import('@/lib/telephony')
    const detailed = msg.organizationId
      ? await telephonyCredentialsDetailed(msg.organizationId)
      : (() => {
          const platform = platformCredentials()
          return platform ? ({ creds: platform, source: 'platform' } as const) : ({ creds: null, reason: 'none' } as const)
        })()
    if (!detailed.creds && detailed.reason === 'unreadable') {
      return {
        status: 'FAILED',
        externalRef: null,
        error: "This account's stored Twilio credentials can't be read. Re-enter them under Settings → Connectors → Twilio SMS.",
      }
    }

    const accountSid = detailed.creds?.accountSid ?? ''
    const authToken = detailed.creds?.authToken ?? ''

    let fromNumber = ''
    if (msg.organizationId) {
      if (accountSid) {
        fromNumber = (await accountSendingNumber(msg.organizationId, { accountSid })) ?? ''
        if (!fromNumber) {
          // A From number saved next to the org's OWN credentials but never
          // synced in: say so, rather than texting from a line whose replies
          // can't be routed or verified.
          const ownVault =
            detailed.creds && 'source' in detailed && detailed.source === 'vault' && detailed.vaultOrgId === msg.organizationId
          const saved = ownVault ? (await vaultCredentials(msg.organizationId, 'TWILIO_SMS'))?.fromNumber?.trim() : ''
          return { status: 'FAILED', externalRef: null, error: saved ? FROM_NUMBER_NOT_SYNCED : NO_TEXTING_LINE }
        }
      }
    } else {
      // Not an organization's text (system use only): the configured number.
      fromNumber = process.env.TWILIO_FROM_NUMBER?.trim() ?? ''
    }

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

    let messagingServiceSid: string | null = null
    if (msg.organizationId) {
      const { telephonySettingsFor } = await import('@/lib/telephony/settings')
      messagingServiceSid = (await telephonySettingsFor(msg.organizationId)).messagingServiceSid
    }

    try {
      const { url, init } = buildTwilioRequest(msg, {
        accountSid,
        authToken,
        fromNumber,
        messagingServiceSid,
        statusCallback: `${appOrigin()}/api/telephony/sms/status`,
      })
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
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
