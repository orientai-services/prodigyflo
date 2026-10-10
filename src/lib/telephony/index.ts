import 'server-only'
import type { NumberWebhooks, TelephonyCredentials, TelephonyProvider } from './provider'
import { MockTelephonyProvider } from './mock'
import { TwilioTelephonyProvider } from './twilio'
import { vaultCredentialsDetailed } from '@/lib/messaging/vault'

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

export type DetailedCredentials =
  | { creds: TelephonyCredentials; source: 'vault'; vaultOrgId: string }
  | { creds: TelephonyCredentials; source: 'platform' }
  | { creds: null; reason: 'unreadable' | 'none' }

/** The platform subaccount ("ProdigyFlo Platform") from env, or null. */
export function platformCredentials(): TelephonyCredentials | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || ''
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() || ''
  return accountSid && authToken ? { accountSid, authToken } : null
}

/** True when these are the platform subaccount's env credentials. */
export function isPlatformAccount(creds: TelephonyCredentials | null | undefined): boolean {
  const platform = platformCredentials()
  return Boolean(creds && platform && creds.accountSid === platform.accountSid)
}

/**
 * The carrier credentials one account uses, from exactly ONE source, in order:
 * the account's own vault entry, then its agency's (one agency, one Twilio
 * account — the operator pastes the token once), then the platform's env.
 *
 * The SID and the token always come from the same place. A vault row with only
 * one of the two, or one that cannot be decrypted, refuses ('unreadable'): it
 * never pairs a vault SID with the env token and never silently falls back to
 * the platform account (audit 5j).
 *
 * A vault entry naming the PLATFORM's Account SID is not a tenant's own
 * account, whatever token sits next to it: the SID is no secret (it is the
 * `sub` of every voice token). Such an org rides the platform account like any
 * other tenant, with the platform's own env token, so it can't claim the
 * shared account's carrier state or sign webhooks with a token it chose.
 */
export async function telephonyCredentialsDetailed(organizationId: string): Promise<DetailedCredentials> {
  const hasTwilioField = (c: Record<string, string>) => Boolean(c.accountSid?.trim() || c.authToken?.trim())
  const vault = await vaultCredentialsDetailed(organizationId, 'TWILIO_SMS', {
    inheritFromParent: true,
    accept: hasTwilioField,
  })
  const platform = platformCredentials()
  if (vault.state === 'unreadable') return { creds: null, reason: 'unreadable' }
  if (vault.state === 'ok') {
    const accountSid = vault.creds.accountSid?.trim() || ''
    const authToken = vault.creds.authToken?.trim() || ''
    if (platform && accountSid === platform.accountSid) return { creds: platform, source: 'platform' }
    if (!accountSid || !authToken) return { creds: null, reason: 'unreadable' }
    return { creds: { accountSid, authToken }, source: 'vault', vaultOrgId: vault.organizationId }
  }
  return platform ? { creds: platform, source: 'platform' } : { creds: null, reason: 'none' }
}

/**
 * Thin wrapper kept for existing callers: the credentials, or null when there
 * are none or the stored ones can't be trusted. Callers surface null as a setup
 * message, never as a crash.
 */
export async function telephonyCredentials(
  organizationId: string,
): Promise<TelephonyCredentials | null> {
  const detailed = await telephonyCredentialsDetailed(organizationId)
  return detailed.creds
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
  const fallback = process.env.TWILIO_VOICE_FALLBACK_URL?.trim()
  return {
    voiceUrl: `${base}/api/telephony/voice`,
    voiceStatusUrl: `${base}/api/telephony/voice/status`,
    smsUrl: `${base}/api/telephony/sms`,
    ...(fallback ? { voiceFallbackUrl: fallback } : {}),
  }
}

export * from './provider'
