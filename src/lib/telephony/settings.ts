import 'server-only'
import { db } from '@/lib/db'
import { mergeOrgSettings } from '@/lib/org-settings'
import { clampWindow, localTimeIn, type CallWindow } from './timezones'

/**
 * Organization.settings.telephony — the per-account telephony settings. Read
 * defensively (it is a JSON blob other features share) and written only
 * through mergeOrgSettings, which merges this one key atomically.
 */

export type TeamNumber = { hash: string; last4: string; label: string; addedById: string; addedAt: string }
export type A2pState = { status: string; source: 'twilio' | 'manual'; checkedAt: string }
export type BusinessHours = { days: number[]; start: string; end: string }

export type TelephonySettings = {
  recordOutbound: boolean
  /** Twilio transcribes voicemails (default on; only an explicit false turns it off). */
  transcribeVoicemail: boolean
  callWindow: CallWindow
  businessHours: BusinessHours | null
  consentForms: Record<string, string>
  teamNumbers: TeamNumber[]
  messagingServiceSid: string | null
  a2p: A2pState | null
  numberAssignments: Record<string, string>
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(obj(v))) if (typeof val === 'string' && val) out[k] = val
  return out
}

export function readTelephonySettings(settings: unknown): TelephonySettings {
  const t = obj(obj(settings).telephony)
  const window = obj(t.callWindow)
  const bh = obj(t.businessHours)
  const a2p = obj(t.a2p)
  return {
    recordOutbound: t.recordOutbound === true,
    transcribeVoicemail: t.transcribeVoicemail !== false,
    callWindow: clampWindow({
      start: typeof window.start === 'number' ? window.start : undefined,
      end: typeof window.end === 'number' ? window.end : undefined,
    }),
    businessHours:
      Array.isArray(bh.days) && typeof bh.start === 'string' && typeof bh.end === 'string'
        ? { days: bh.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6), start: bh.start, end: bh.end }
        : null,
    consentForms: stringMap(t.consentForms),
    teamNumbers: Array.isArray(t.teamNumbers)
      ? (t.teamNumbers as unknown[])
          .map(obj)
          .filter((n) => typeof n.hash === 'string' && typeof n.last4 === 'string')
          .map((n) => ({
            hash: n.hash as string,
            last4: n.last4 as string,
            label: typeof n.label === 'string' ? n.label : '',
            addedById: typeof n.addedById === 'string' ? n.addedById : '',
            addedAt: typeof n.addedAt === 'string' ? n.addedAt : '',
          }))
      : [],
    messagingServiceSid: typeof t.messagingServiceSid === 'string' && t.messagingServiceSid ? t.messagingServiceSid : null,
    a2p:
      typeof a2p.status === 'string'
        ? {
            status: a2p.status,
            source: a2p.source === 'manual' ? 'manual' : 'twilio',
            checkedAt: typeof a2p.checkedAt === 'string' ? a2p.checkedAt : '',
          }
        : null,
    numberAssignments: stringMap(t.numberAssignments),
  }
}

export async function telephonySettingsFor(organizationId: string): Promise<TelephonySettings & { timezone: string }> {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true, timezone: true } })
  return { ...readTelephonySettings(org?.settings), timezone: org?.timezone ?? 'America/Los_Angeles' }
}

export async function saveTelephonySettings(organizationId: string, patch: Record<string, unknown>): Promise<void> {
  await mergeOrgSettings(organizationId, 'telephony', patch)
}

/**
 * The account's own opening hours (when set), in Organization.timezone.
 * No setting means every hour is a business hour — today's behaviour.
 */
export function withinBusinessHours(hours: BusinessHours | null, timezone: string, now: Date): boolean {
  if (!hours) return true
  const local = localTimeIn(timezone, now)
  if (!hours.days.includes(local.weekday)) return false
  const minutes = local.hour * 60 + local.minute
  const parse = (hhmm: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
    return m ? Number(m[1]) * 60 + Number(m[2]) : null
  }
  const start = parse(hours.start)
  const end = parse(hours.end)
  if (start === null || end === null) return true
  return minutes >= start && minutes < end
}
