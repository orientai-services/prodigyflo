/**
 * Messaging provider boundary.
 *
 * Every outbound email or SMS goes through one of these interfaces so the rest
 * of the codebase never talks to a vendor SDK. Adapters register themselves in
 * `src/lib/messaging/index.ts`; the deterministic mock stays the default, with
 * Resend (email) and Twilio (SMS) selectable via env.
 */

export type MessagingChannel = 'EMAIL' | 'SMS'

export type OutboundEmail = {
  to: string
  subject: string
  /** Plain-text body — always present, the universal fallback. */
  body: string
  /**
   * Optional HTML alternative. Adapters that can send multipart do; the mock
   * and any text-only adapter fall back to `body`. Used by the lean
   * transactional path (src/lib/auth-mail.ts) for branded auth links.
   */
  html?: string
  /**
   * Lets real adapters prefer the org's vault-stored connector credentials
   * over env config. Optional — when absent, env credentials apply.
   */
  organizationId?: string
}

export type OutboundSms = {
  to: string
  body: string
  /** Same vault-credential seam as OutboundEmail. */
  organizationId?: string
}

/**
 * `status` reflects what the provider actually confirmed. Callers must never
 * persist SENT unless the provider returned SENT.
 */
export type SendResult = {
  status: 'SENT' | 'FAILED'
  externalRef: string | null
  error?: string
}

export interface EmailProvider {
  readonly name: string
  send(msg: OutboundEmail): Promise<SendResult>
}

export interface SmsProvider {
  readonly name: string
  send(msg: OutboundSms): Promise<SendResult>
}
