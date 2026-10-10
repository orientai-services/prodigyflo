import 'server-only'
import type { TelephonyAccountState } from '@prisma/client'
import { db } from '@/lib/db'
import { isMockTelephony } from './index'
import type { TelephonyCredentials } from './provider'
import {
  buildA2pStatusRequest,
  buildBalanceRequest,
  buildCustomerProfilesRequest,
  buildLatestRecordingRequest,
  parseA2pStatus,
  parseBalance,
  parseProfileStatus,
} from './twilio'

/**
 * What we last learned about one Twilio account (one row per account SID).
 *
 * The important fact is VOICE-LIMITED: until Twilio approves the business
 * profile, the account may hold only ONE outbound leg at a time (error 10004
 * on a second). Every bridge, forward and browser ring counts, in both
 * directions. The code reads the state instead of assuming it, so the normal
 * flow comes back by itself the day the profile is approved — nothing to
 * redeploy.
 *
 *   mode on   → limited (owner's choice)
 *   mode off  → normal (owner's choice)
 *   mode auto → limited while the profile is not 'twilio-approved' (unknown
 *               counts as not approved), or for 24 h after any 10004
 */

export type VoiceLimitMode = 'auto' | 'on' | 'off'

const DAY = 86_400_000
export const REFRESH_EVERY_MS = 60 * 60_000
export const MEDIA_PROBE_EVERY_MS = DAY

export function normalizeMode(raw: string | null | undefined): VoiceLimitMode {
  return raw === 'on' || raw === 'off' ? raw : 'auto'
}

export async function getAccountState(accountSid: string): Promise<TelephonyAccountState | null> {
  if (!accountSid) return null
  return db.telephonyAccountState.findUnique({ where: { accountSid } })
}

export type VoiceLimitView = { on: boolean; mode: VoiceLimitMode; why: string }

/** Pure: the limit as the state row and the clock say. */
export function voiceLimitFrom(
  state: Pick<TelephonyAccountState, 'voiceLimitedMode' | 'voiceLimitedSeenAt' | 'profileStatus'> | null,
  now: Date,
  mock: boolean,
): VoiceLimitView {
  const mode = normalizeMode(state?.voiceLimitedMode)
  if (mode === 'on') return { on: true, mode, why: 'Set to one call at a time by the owner.' }
  if (mode === 'off') return { on: false, mode, why: 'Normal (set by the owner).' }
  if (mock) return { on: false, mode, why: 'Test mode. No real calls are placed.' }
  if (state?.voiceLimitedSeenAt && now.getTime() - state.voiceLimitedSeenAt.getTime() < DAY) {
    return { on: true, mode, why: 'Twilio refused a second call in the last day (error 10004).' }
  }
  if (state?.profileStatus !== 'twilio-approved') {
    return {
      on: true,
      mode,
      why: state?.profileStatus
        ? `Twilio hasn't approved the business profile yet (${state.profileStatus}).`
        : "We don't know the business profile status yet.",
    }
  }
  return { on: false, mode, why: 'Normal.' }
}

export async function voiceLimitView(accountSid: string, now = new Date()): Promise<VoiceLimitView> {
  return voiceLimitFrom(await getAccountState(accountSid), now, isMockTelephony())
}

export async function voiceLimited(accountSid: string, now = new Date()): Promise<boolean> {
  return (await voiceLimitView(accountSid, now)).on
}

/** Any callback carrying a carrier error. 10004 starts the 24-hour limit window. */
export async function noteCarrierError(accountSid: string, code: string | null | undefined, now = new Date()): Promise<void> {
  if (!accountSid || !code) return
  try {
    if (String(code) === '10004') {
      await db.telephonyAccountState.upsert({
        where: { accountSid },
        create: { accountSid, voiceLimitedSeenAt: now },
        update: { voiceLimitedSeenAt: now },
      })
    }
  } catch {
    // Informational only: a failed write must never break a webhook answer.
  }
}

export async function setVoiceLimitMode(accountSid: string, mode: VoiceLimitMode, userId: string): Promise<void> {
  await db.telephonyAccountState.upsert({
    where: { accountSid },
    create: { accountSid, voiceLimitedMode: mode, updatedById: userId },
    update: { voiceLimitedMode: mode, updatedById: userId },
  })
}

export async function setManualAccountState(
  accountSid: string,
  input: { profile?: string | null; mediaAuth?: 'on' | 'off' | 'unknown' | null },
  userId: string,
  now = new Date(),
): Promise<void> {
  const data: Partial<TelephonyAccountState> = { updatedById: userId }
  if (input.profile !== undefined) {
    data.profileStatus = input.profile
    data.profileSource = input.profile ? 'manual' : null
  }
  if (input.mediaAuth !== undefined) {
    data.mediaAuthState = input.mediaAuth
    data.mediaAuthSource = input.mediaAuth ? 'manual' : null
    data.mediaAuthCheckedAt = now
  }
  await db.telephonyAccountState.upsert({
    where: { accountSid },
    create: { accountSid, ...data },
    update: data,
  })
}

async function fetchJson(req: { url: string; init: RequestInit }): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(5000) })
    return { status: res.status, body: await res.json().catch(() => null) }
  } catch {
    return null
  }
}

/**
 * Twilio's "Enforce HTTP Basic Auth on media URLs": one UNAUTHENTICATED HEAD of
 * the newest recording's media URL. 401/403 → on, 200 → off, nothing to test →
 * unknown. The recording itself is never downloaded.
 */
export async function probeMediaAuth(creds: TelephonyCredentials): Promise<'on' | 'off' | 'unknown'> {
  const latest = await fetchJson(buildLatestRecordingRequest(creds))
  const rows = (latest?.body as { recordings?: { sid?: unknown }[] } | null)?.recordings
  const sid = Array.isArray(rows) && typeof rows[0]?.sid === 'string' ? (rows[0].sid as string) : null
  if (!sid || !/^RE[0-9a-f]{32}$/.test(sid)) return 'unknown'
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Recordings/${sid}.mp3`
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) })
    if (res.status === 401 || res.status === 403) return 'on'
    if (res.status === 200 || (res.status >= 300 && res.status < 400)) return 'off'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export type RefreshResult = { mode: 'mock' } | { mode: 'twilio'; refreshed: boolean; error?: string }

/**
 * Balance and business profile (hourly), media auth (daily). Never throws;
 * every fetch has a 5-second timeout. `force` ignores the hourly gate.
 */
export async function refreshAccountState(
  creds: TelephonyCredentials,
  now = new Date(),
  opts: { force?: boolean; probeMedia?: boolean } = {},
): Promise<RefreshResult> {
  if (isMockTelephony()) return { mode: 'mock' }
  const state = await getAccountState(creds.accountSid).catch(() => null)
  const stale = !state?.lastCheckedAt || now.getTime() - state.lastCheckedAt.getTime() >= REFRESH_EVERY_MS
  if (!opts.force && !stale) return { mode: 'twilio', refreshed: false }

  const data: Partial<TelephonyAccountState> = { lastCheckedAt: now, lastError: null }
  const balance = await fetchJson(buildBalanceRequest(creds))
  const parsedBalance = balance && balance.status < 300 ? parseBalance(balance.body) : null
  if (parsedBalance) {
    data.balance = parsedBalance.balance
    data.balanceCurrency = parsedBalance.currency
  } else {
    data.lastError = balance ? `Balance read failed (HTTP ${balance.status}).` : 'Balance read failed.'
  }

  // A subaccount may not be allowed to read Trust Hub; a manual entry stays then.
  const profiles = await fetchJson(buildCustomerProfilesRequest(creds))
  if (profiles && profiles.status < 300) {
    const status = parseProfileStatus(profiles.body)
    if (status) {
      data.profileStatus = status
      data.profileSource = 'twilio'
    }
  }

  const mediaDue =
    opts.probeMedia ?? (!state?.mediaAuthCheckedAt || now.getTime() - state.mediaAuthCheckedAt.getTime() >= MEDIA_PROBE_EVERY_MS)
  if (mediaDue && state?.mediaAuthSource !== 'manual') {
    const probed = await probeMediaAuth(creds)
    if (probed !== 'unknown' || !state?.mediaAuthState) {
      data.mediaAuthState = probed
      data.mediaAuthSource = 'probe'
    }
    data.mediaAuthCheckedAt = now
  }

  try {
    await db.telephonyAccountState.upsert({
      where: { accountSid: creds.accountSid },
      create: { accountSid: creds.accountSid, ...data },
      update: data,
    })
  } catch (err) {
    return { mode: 'twilio', refreshed: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { mode: 'twilio', refreshed: true, ...(data.lastError ? { error: data.lastError } : {}) }
}

/** A2P status of one org's Messaging Service, or null when it can't be read. */
export async function fetchA2pStatus(serviceSid: string, creds: TelephonyCredentials): Promise<string | null> {
  if (isMockTelephony()) return null
  const res = await fetchJson(buildA2pStatusRequest(serviceSid, creds))
  return res && res.status < 300 ? parseA2pStatus(res.body) : null
}
