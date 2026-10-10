import 'server-only'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { can, type SessionUser } from '@/lib/rbac'
import { getTelephonyProvider, isMockTelephony, telephonyCredentialsDetailed } from './index'
import { getAccountState, refreshAccountState, voiceLimitFrom } from './account-status'
import { carrierCodeFrom, explainCarrierError } from './carrier-errors'
import { maskAccount } from './number-sync'
import { telephonySettingsFor } from './settings'
import { guardAccountAction, isPlatformOwner } from './tenancy'
import type { CarrierState, TwilioStatusVM } from './voice-contract'

/**
 * The owner's one-card view of the Twilio account (§2.8, §3 TwilioStatusVM).
 *
 * Scope matters on a shared account. The platform owner looking at the
 * platform account sees everything account-wide: balance, the number count at
 * Twilio, profile / A2P, voice limit, media auth, which env vars are set (names
 * only, never values) and every carrier error. Anyone else sees their own
 * org's numbers and errors, their own texting registration, and whether calls
 * are limited — no balance, no env, no account-wide errors, and no switches.
 */

const ENV_NAMES = [
  'TELEPHONY_PROVIDER',
  'SMS_PROVIDER',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'APP_URL',
  'PHONE_HASH_KEY',
  'TELEPHONY_OVERRIDE_KEY',
  'TELEPHONY_PLATFORM_ORG_ID',
  'TWILIO_VOICE_FALLBACK_URL',
  'TELEPHONY_WEBHOOK_HOSTS',
  'VOICE_BROWSER_ENABLED',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_TWIML_APP_SID',
] as const

const ERROR_WINDOW_MS = 7 * 86_400_000

function profileState(status: string | null | undefined, source: string | null | undefined): CarrierState {
  if (!status) return { status: 'unknown', source: 'unknown', note: "Twilio hasn't told us the business profile status yet." }
  const approved = status === 'twilio-approved'
  return {
    status,
    source: source === 'manual' ? 'manual' : 'twilio',
    note: approved ? 'Business profile approved.' : 'Until it is approved: one call at a time, and texting registration waits.',
  }
}

async function recentErrors(where: { organizationIds?: string[]; accountSid?: string }, now: Date) {
  const since = new Date(now.getTime() - ERROR_WINDOW_MS)
  const [calls, texts] = await Promise.all([
    db.voiceCall.findMany({
      where: {
        errorCode: { not: null },
        startedAt: { gte: since },
        ...(where.accountSid ? { accountSid: where.accountSid } : { organizationId: { in: where.organizationIds ?? [] } }),
      },
      select: { errorCode: true, startedAt: true },
      take: 500,
    }),
    db.message.findMany({
      where: {
        failureCode: { not: null },
        communication: {
          channel: 'SMS',
          occurredAt: { gte: since },
          ...(where.organizationIds ? { client: { organizationId: { in: where.organizationIds } } } : {}),
        },
      },
      select: { failureCode: true, communication: { select: { occurredAt: true } } },
      take: 500,
    }),
  ])
  const byCode = new Map<string, { count: number; lastAt: Date }>()
  const add = (code: string | null, at: Date) => {
    if (!code) return
    const cur = byCode.get(code)
    if (!cur) byCode.set(code, { count: 1, lastAt: at })
    else {
      cur.count += 1
      if (at > cur.lastAt) cur.lastAt = at
    }
  }
  for (const c of calls) add(c.errorCode, c.startedAt)
  for (const t of texts) add(carrierCodeFrom(t.failureCode), t.communication.occurredAt)
  return [...byCode.entries()]
    .map(([code, v]) => ({ code, meaning: explainCarrierError(code).meaning, count: v.count, lastAt: v.lastAt.toISOString() }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, 10)
}

export async function twilioStatusFor(user: SessionUser, opts: { refresh?: boolean } = {}, now = new Date()): Promise<TwilioStatusVM> {
  const mode: TwilioStatusVM['mode'] = isMockTelephony() ? 'mock' : 'twilio'
  const detailed = await telephonyCredentialsDetailed(user.organizationId)
  const settings = await telephonySettingsFor(user.organizationId)
  const a2p: CarrierState = settings.a2p
    ? { status: settings.a2p.status, source: settings.a2p.source, note: settings.messagingServiceSid ? 'This account’s Messaging Service.' : 'No Messaging Service set yet.' }
    : {
        status: settings.messagingServiceSid ? 'unknown' : 'not set up',
        source: 'unknown',
        note: settings.messagingServiceSid ? "Not checked yet." : 'No Messaging Service for this account yet. Texts may be blocked (30034).',
      }

  if (!detailed.creds) {
    const unreadable = detailed.reason === 'unreadable'
    return {
      mode,
      scope: 'org',
      account: unreadable ? "Stored credentials can't be read" : 'Not set up',
      balance: null,
      numbers: { inTwilio: null, here: await db.phoneNumber.count({ where: { organizationId: user.organizationId, status: { not: 'RELEASED' } } }), drift: 0 },
      profile: { status: 'unknown', source: 'unknown', note: unreadable ? 'Re-enter the Twilio credentials under Settings → Connectors.' : "Phone calling isn't set up yet." },
      a2p,
      voiceLimited: { on: false, mode: 'auto', why: unreadable ? "Stored credentials can't be read." : "Phone calling isn't set up yet.", canChange: false },
      mediaAuth: { state: 'unknown', checkedAt: null },
      env: [],
      recentErrors: [],
      checkedAt: null,
    }
  }

  const creds = detailed.creds
  const guard = await guardAccountAction(user, user.organizationId)
  const accountWide = guard.ok && (detailed.source === 'vault' || isPlatformOwner(user))
  const scope: TwilioStatusVM['scope'] = detailed.source === 'platform' && isPlatformOwner(user) ? 'platform' : 'org'

  if (opts.refresh && accountWide) await refreshAccountState(creds, now, { force: true })
  const state = await getAccountState(creds.accountSid)
  const limit = voiceLimitFrom(state, now, mode === 'mock')

  let inTwilio: number | null = null
  if (opts.refresh && accountWide) {
    const listed = await getTelephonyProvider().listOwnedNumbers(creds)
    inTwilio = listed.ok ? listed.numbers.length : null
  }
  const numberWhere =
    scope === 'platform'
      ? { status: { not: 'RELEASED' as const }, OR: [{ providerAccountSid: creds.accountSid }, { providerAccountSid: null }] }
      : { organizationId: user.organizationId, status: { not: 'RELEASED' as const } }
  const [here, drift] = await Promise.all([
    db.phoneNumber.count({ where: numberWhere }),
    db.phoneNumber.count({ where: { ...numberWhere, webhookDrift: { not: Prisma.DbNull } } }).catch(() => 0),
  ])

  return {
    mode,
    scope,
    account: maskAccount(creds.accountSid),
    balance: accountWide ? state?.balance ?? null : null,
    numbers: { inTwilio, here, drift },
    profile: accountWide
      ? profileState(state?.profileStatus, state?.profileSource)
      : { status: state?.profileStatus === 'twilio-approved' ? 'approved' : 'pending', source: 'unknown', note: 'Shown in full to the platform owner.' },
    a2p,
    voiceLimited: { on: limit.on, mode: limit.mode, why: limit.why, canChange: guard.ok && can(user, 'telephony:read') },
    mediaAuth: {
      state: (state?.mediaAuthState as 'on' | 'off' | 'unknown' | null) ?? 'unknown',
      checkedAt: state?.mediaAuthCheckedAt?.toISOString() ?? null,
    },
    env: scope === 'platform' ? ENV_NAMES.map((name) => ({ name, set: Boolean(process.env[name]?.trim()) })) : [],
    recentErrors:
      scope === 'platform'
        ? await recentErrors({ accountSid: creds.accountSid }, now)
        : await recentErrors({ organizationIds: [user.organizationId] }, now),
    checkedAt: state?.lastCheckedAt?.toISOString() ?? null,
  }
}
