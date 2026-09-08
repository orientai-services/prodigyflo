import type { EmailProvider, OutboundEmail, SendResult } from './provider'
import { vaultCredentials } from './vault'

/**
 * Resend email adapter (https://resend.com) — the first real EmailProvider.
 *
 * Selected via EMAIL_PROVIDER=resend. Credentials come from the connector
 * vault when the org has stored them (email-service: apiKey / fromAddress),
 * otherwise from RESEND_API_KEY + EMAIL_FROM. Errors are surfaced honestly as
 * FAILED SendResults so the Communication row records what actually happened —
 * this adapter never fakes a SENT.
 *
 * The request/response mapping lives in pure functions so it can be unit
 * tested without a network.
 */

export type ResendConfig = {
  apiKey: string
  /** RFC 5322 from, e.g. `ProdigyFlo <no-reply@prodigyflo.ai>` or a bare address. */
  from: string
}

export const RESEND_ENDPOINT = 'https://api.resend.com/emails'

// Resend's edge rejects requests without a User-Agent header (observed in the
// wild as opaque 4xx responses) — always send one.
export const RESEND_USER_AGENT = 'prodigyflo-messaging/1.0'

/** Pure request builder — exactly what will be fetched, testable offline. */
export function buildResendRequest(
  msg: Pick<OutboundEmail, 'to' | 'subject' | 'body' | 'html'>,
  config: ResendConfig,
): { url: string; init: RequestInit } {
  return {
    url: RESEND_ENDPOINT,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': RESEND_USER_AGENT,
      },
      body: JSON.stringify({
        from: config.from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.body,
        // Omitted (not null) when absent so text-only payloads stay identical.
        ...(msg.html ? { html: msg.html } : {}),
      }),
    },
  }
}

/** Pure response mapping. SENT only when Resend confirmed with 2xx. */
export function resendResultFromResponse(status: number, body: unknown): SendResult {
  const record = (body ?? {}) as Record<string, unknown>
  if (status >= 200 && status < 300) {
    return { status: 'SENT', externalRef: typeof record.id === 'string' ? record.id : null }
  }
  const message =
    typeof record.message === 'string' && record.message
      ? record.message
      : `Resend API error (HTTP ${status}).`
  const name = typeof record.name === 'string' && record.name ? ` [${record.name}]` : ''
  return { status: 'FAILED', externalRef: null, error: `${message}${name}`.slice(0, 500) }
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend'

  async send(msg: OutboundEmail): Promise<SendResult> {
    const vault = await vaultCredentials(msg.organizationId, 'EMAIL')
    const apiKey = vault?.apiKey ?? process.env.RESEND_API_KEY?.trim() ?? ''
    const from = vault?.fromAddress ?? process.env.EMAIL_FROM?.trim() ?? ''

    if (!apiKey) {
      return {
        status: 'FAILED',
        externalRef: null,
        error:
          'EMAIL_PROVIDER=resend but no API key is configured — set RESEND_API_KEY or store the email-service connector credentials.',
      }
    }
    if (!from) {
      return {
        status: 'FAILED',
        externalRef: null,
        error:
          'EMAIL_PROVIDER=resend but no sender address is configured — set EMAIL_FROM or store the email-service fromAddress credential.',
      }
    }

    try {
      const { url, init } = buildResendRequest(msg, { apiKey, from })
      const res = await fetch(url, init)
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        // Non-JSON error bodies still map to an honest FAILED below.
      }
      return resendResultFromResponse(res.status, body)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { status: 'FAILED', externalRef: null, error: `Resend request failed: ${detail}`.slice(0, 500) }
    }
  }
}
