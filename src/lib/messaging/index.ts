import type { EmailProvider, MessagingChannel, SmsProvider } from './provider'
import { MockEmailProvider, MockSmsProvider } from './mock'
import { ResendEmailProvider } from './resend'
import { TwilioSmsProvider } from './twilio'

/**
 * Provider selection, mirroring `src/lib/ai/index.ts`: the env var picks the
 * adapter and everything else in the codebase stays vendor-blind. The
 * deterministic mock is the default; EMAIL_PROVIDER=resend and
 * SMS_PROVIDER=twilio select the real adapters (each reads its own
 * credentials — RESEND_API_KEY/EMAIL_FROM, TWILIO_ACCOUNT_SID/AUTH_TOKEN/
 * FROM_NUMBER — or the org's connector vault, and fails honestly when they
 * are missing). An unknown value throws rather than silently pretending a
 * real provider exists.
 */

const EMAIL_ADAPTERS: Record<string, () => EmailProvider> = {
  mock: () => new MockEmailProvider(),
  resend: () => new ResendEmailProvider(),
}

const SMS_ADAPTERS: Record<string, () => SmsProvider> = {
  mock: () => new MockSmsProvider(),
  twilio: () => new TwilioSmsProvider(),
}

function providerKey(channel: MessagingChannel): string {
  const raw = channel === 'EMAIL' ? process.env.EMAIL_PROVIDER : process.env.SMS_PROVIDER
  return (raw ?? 'mock').trim().toLowerCase() || 'mock'
}

let cachedEmail: EmailProvider | null = null
let cachedSms: SmsProvider | null = null

export function getEmailProvider(): EmailProvider {
  if (cachedEmail) return cachedEmail
  const key = providerKey('EMAIL')
  const make = EMAIL_ADAPTERS[key]
  if (!make) throw new Error(`EMAIL_PROVIDER "${key}" has no adapter (available: ${Object.keys(EMAIL_ADAPTERS).join(', ')})`)
  cachedEmail = make()
  return cachedEmail
}

export function getSmsProvider(): SmsProvider {
  if (cachedSms) return cachedSms
  const key = providerKey('SMS')
  const make = SMS_ADAPTERS[key]
  if (!make) throw new Error(`SMS_PROVIDER "${key}" has no adapter (available: ${Object.keys(SMS_ADAPTERS).join(', ')})`)
  cachedSms = make()
  return cachedSms
}

/** True when the resolved adapter for the channel is the mock — the UI must label it. */
export function isMockMode(channel: MessagingChannel): boolean {
  return providerKey(channel) === 'mock' || !(channel === 'EMAIL' ? EMAIL_ADAPTERS : SMS_ADAPTERS)[providerKey(channel)]
}

export * from './provider'
export { getMockOutbox } from './mock'
