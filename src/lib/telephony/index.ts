import 'server-only'
import type { NumberWebhooks, TelephonyCredentials, TelephonyProvider } from './provider'
import { MockTelephonyProvider } from './mock'
import { TwilioTelephonyProvider } from './twilio'
import { vaultCredentials } from '@/lib/messaging/vault'

/**
 * Provider selection for number provisioning, mirroring
 * src/lib/messaging/index.ts: TELEPHONY_PROVIDER picks the adapter, the
 * deterministic mock is the default, and an unknown value throws rather than
 * pretending a carrier exists.
 *
 * Credentials resolve PER ACCOUNT, not per process: an org that has stored its
 * own Twilio SID/token in the connector vault (twilio-sms, or twilio-voice)
 * buys numbers on its own Twilio account and gets its own carrier bill. Orgs
 * with nothing stored fall back to the agency's TWILIO_* env credentials —
 * which is exactly the internal-account case (ProdigyFlo, CYS, SCS all ride
 * the agency's Twilio account and therefore the agency's card).
 */

const ADAPTERS: Record<string, () => TelephonyProvider> = {
  mock: () => new MockTelephonyProvider(),
  twilio: () => new TwilioTelephonyProvider(),
}

function providerKey(): string {
  return (process.env.TELEPHONY_PROVIDER ?? 'mock').trim().toLowerCase() || 'mock'
}

let cached: TelephonyProvider | null = null

export function getTelephonyProvider(): TelephonyProvider {
  if (cached) return cached
  const key = providerKey()
  const make = ADAPTERS[key]
  if (!make) {
    throw new Error(
      `TELEPHONY_PROVIDER "${key}" has no adapter (available: ${Object.keys(ADAPTERS).join(', ')})`,
    )
  }
  cached = make()
  return cached
}

/** True when numbers are being minted by the mock carrier. The UI must say so. */
export function isMockTelephony(): boolean {
  return getTelephonyProvider().isMock
}

/** Test seam: forget the memoised adapter after changing TELEPHONY_PROVIDER. */
export function resetTelephonyProvider(): void {
  cached = null
}

/**
 * The carrier credentials one account provisions with, in order: the account's
 * own vault entry, then its agency's (one agency, one Twilio account — the
 * operator pastes the token once, not once per client account), then the
 * server env. Returns null when none exist — callers surface that as a setup
 * message, never as a crash.
 */
export async function telephonyCredentials(
  organizationId: string,
): Promise<TelephonyCredentials | null> {
  const vault = (await vaultCredentials(organizationId, 'TWILIO_SMS', { inheritFromParent: true })) ?? null
  const accountSid = vault?.accountSid?.trim() || process.env.TWILIO_ACCOUNT_SID?.trim() || ''
  const authToken = vault?.authToken?.trim() || process.env.TWILIO_AUTH_TOKEN?.trim() || ''
  if (!accountSid || !authToken) return null
  return { accountSid, authToken }
}

/** Public origin this app is reachable at — where the carrier posts webhooks. */
export function appOrigin(): string {
  return (process.env.APP_URL || 'http://localhost:3300').replace(/\/+$/, '')
}

/**
 * Webhook set handed to the carrier at purchase time. These endpoints are
 * public by necessity — the carrier posts to them unauthenticated — so each
 * one verifies Twilio's own X-Twilio-Signature over the exact URL and params
 * before it looks anything up (see src/lib/telephony/signature.ts).
 */
export function webhooksFor(): NumberWebhooks {
  const base = appOrigin()
  return {
    voiceUrl: `${base}/api/telephony/voice`,
    voiceStatusUrl: `${base}/api/telephony/voice/status`,
    smsUrl: `${base}/api/telephony/sms`,
  }
}

export * from './provider'
