import 'server-only'
import { can, type SessionUser } from '@/lib/rbac'
import { isMockTelephony, telephonyCredentialsDetailed } from './index'
import { voiceIdentity } from './access-token'
import { voiceLimited } from './account-status'
import { callerLinesFor } from './lines'
import { telephonySettingsFor } from './settings'
import type { VoiceSetup } from './voice-contract'

/**
 * Browser calling (P0b) ships DARK behind VOICE_BROWSER_ENABLED. With the flag
 * off nothing about it is reachable: getVoiceSetup says so in plain words, the
 * TwiML App route hangs up politely, /api/voice/presence 404s, and the UI never
 * loads the SDK. The DA turns it on in Vercel env after the live smoke test.
 */

export const FLAG_OFF = "Phone calling from the browser isn't switched on yet."
export const NOT_SET_UP = "Phone calling isn't set up yet."
export const OWN_TWILIO = "Browser calling isn't set up for this account's own Twilio yet."
export const NO_SEND = "You don't have permission to place calls."

export function voiceBrowserEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VOICE_BROWSER_ENABLED === 'true'
}

const REQUIRED = ['TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_TWIML_APP_SID'] as const

/** Is browser calling switched on and fully configured? Names only, never values. */
export function voiceConfig(env: Record<string, string | undefined> = process.env): { ready: boolean; missing: string[] } {
  const missing: string[] = []
  if (!voiceBrowserEnabled(env)) missing.push('VOICE_BROWSER_ENABLED')
  for (const name of REQUIRED) if (!env[name]?.trim()) missing.push(name)
  return { ready: missing.length === 0, missing }
}

export function voiceKeys(env: Record<string, string | undefined> = process.env): {
  apiKeySid: string
  apiKeySecret: string
  appSid: string
} | null {
  const apiKeySid = env.TWILIO_API_KEY_SID?.trim()
  const apiKeySecret = env.TWILIO_API_KEY_SECRET?.trim()
  const appSid = env.TWILIO_TWIML_APP_SID?.trim()
  return apiKeySid && apiKeySecret && appSid ? { apiKeySid, apiKeySecret, appSid } : null
}

/** The VoiceSetup the UI renders from. Plain-English reason whenever it isn't ready. */
export async function voiceSetupFor(user: SessionUser): Promise<VoiceSetup> {
  if (!voiceBrowserEnabled()) return { ready: false, reason: FLAG_OFF }
  if (!can(user, 'communications:send')) return { ready: false, reason: NO_SEND }
  if (!voiceConfig().ready) return { ready: false, reason: NOT_SET_UP }

  const detailed = await telephonyCredentialsDetailed(user.organizationId)
  if (!detailed.creds) return { ready: false, reason: NOT_SET_UP }
  if (detailed.source !== 'platform') return { ready: false, reason: OWN_TWILIO }

  const [lines, settings, limited] = await Promise.all([
    callerLinesFor(user),
    telephonySettingsFor(user.organizationId),
    voiceLimited(detailed.creds.accountSid),
  ])
  return {
    ready: true,
    identity: voiceIdentity(user.organizationId, user.id),
    lines,
    canPickLine: can(user, 'telephony:manage'),
    voiceLimited: limited,
    recordOutbound: settings.recordOutbound,
    mode: isMockTelephony() ? 'mock' : 'twilio',
  }
}
