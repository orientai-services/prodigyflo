import 'server-only'
import type { CallRouting, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { can, type SessionUser } from '@/lib/rbac'
import { formatE164, toE164 } from './provider'
import type { CallerLine } from './voice-contract'

/**
 * Caller-ID lines for browser calls (P0b, docs/TELEPHONY_LIVE.md §2.4).
 *
 * The number a consumer sees must belong to the calling organization and must
 * reach a person if they call it back during business hours (TSR caller-ID
 * rule). So a line qualifies only when it is ACTIVE, voice-capable, in the
 * caller's org, and its inbound path reaches someone: FORWARD to a valid
 * number, TEAM with at least one member, or browser ringing while browser
 * calling is on. Imported lines start voicemail-only and so can't be caller ID
 * until a manager sets their routing.
 */

const LINE_SELECT = {
  id: true,
  organizationId: true,
  e164: true,
  friendlyName: true,
  status: true,
  isPrimary: true,
  capabilities: true,
  routing: true,
  forwardTo: true,
  teamUserIds: true,
  assignedUserId: true,
  ringBrowsers: true,
} as const

export type LineRow = Prisma.PhoneNumberGetPayload<{ select: typeof LINE_SELECT }>

/** null = ring browsers unless the line is voicemail-only. */
export function ringsBrowsers(line: { ringBrowsers: boolean | null; routing: CallRouting }): boolean {
  return line.ringBrowsers ?? line.routing !== 'VOICEMAIL_ONLY'
}

export function voiceCapable(capabilities: unknown): boolean {
  const caps = (capabilities ?? {}) as { voice?: unknown }
  // Older rows stored {} — treat a missing flag as capable, an explicit false as not.
  return !('voice' in caps) || caps.voice === true
}

export function takesCallbacks(
  line: Pick<LineRow, 'status' | 'capabilities' | 'routing' | 'forwardTo' | 'teamUserIds' | 'ringBrowsers'>,
  browserEnabled: boolean = browserCallingOn(),
): boolean {
  if (line.status !== 'ACTIVE' || !voiceCapable(line.capabilities)) return false
  if (line.routing === 'FORWARD' && line.forwardTo && toE164(line.forwardTo)) return true
  if (line.routing === 'TEAM' && Array.isArray(line.teamUserIds) && (line.teamUserIds as unknown[]).length > 0) return true
  return browserEnabled && ringsBrowsers(line)
}

export const NO_LINES = 'This account has no phone line yet.'
export const NO_CALLBACK_LINE = "This line can't take callbacks yet. Set it to forward, ring a team or ring browsers."
export const NOT_YOUR_LINE = "You can't call from that line. Use your own line or the main line."

function toCallerLine(line: LineRow, isDefault: boolean): CallerLine {
  return { id: line.id, display: formatE164(line.e164), label: line.friendlyName, isDefault }
}

async function orgLines(organizationId: string): Promise<LineRow[]> {
  return db.phoneNumber.findMany({
    where: { organizationId, status: 'ACTIVE' },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: LINE_SELECT,
  })
}

function browserCallingOn(): boolean {
  return process.env.VOICE_BROWSER_ENABLED === 'true'
}

/**
 * telephony:manage holders: every qualifying line. Everyone else: their own
 * line if it qualifies, else the account's main line if it qualifies.
 */
export async function callerLinesFor(user: SessionUser): Promise<CallerLine[]> {
  const lines = await orgLines(user.organizationId)
  const ok = lines.filter((l) => takesCallbacks(l, browserCallingOn()))
  if (can(user, 'telephony:manage')) {
    const def = ok.find((l) => l.assignedUserId === user.id) ?? ok.find((l) => l.isPrimary) ?? ok[0]
    return ok.map((l) => toCallerLine(l, l.id === def?.id))
  }
  const own = ok.find((l) => l.assignedUserId === user.id)
  if (own) return [toCallerLine(own, true)]
  const main = ok.find((l) => l.isPrimary)
  return main ? [toCallerLine(main, true)] : []
}

export type ResolvedLine = { ok: true; line: { id: string; e164: string; label: string } } | { ok: false; code: 'NO_LINE'; reason: string }

/** The line a call goes out on. A line the user may not use is refused, never swapped. */
export async function resolveCallerLine(user: SessionUser, lineId?: string | null): Promise<ResolvedLine> {
  const allowed = await callerLinesFor(user)
  if (allowed.length === 0) {
    const any = await db.phoneNumber.count({ where: { organizationId: user.organizationId, status: 'ACTIVE' } })
    return { ok: false, code: 'NO_LINE', reason: any === 0 ? NO_LINES : NO_CALLBACK_LINE }
  }
  const pick = lineId ? allowed.find((l) => l.id === lineId) : allowed.find((l) => l.isDefault) ?? allowed[0]
  if (!pick) {
    // A line of this org that takes callbacks but isn't one this user may use.
    const other = lineId
      ? await db.phoneNumber.findFirst({ where: { id: lineId, organizationId: user.organizationId, status: 'ACTIVE' }, select: LINE_SELECT })
      : null
    return { ok: false, code: 'NO_LINE', reason: other && takesCallbacks(other) ? NOT_YOUR_LINE : NO_CALLBACK_LINE }
  }
  const row = await db.phoneNumber.findFirst({
    where: { id: pick.id, organizationId: user.organizationId },
    select: { id: true, e164: true, friendlyName: true },
  })
  if (!row) return { ok: false, code: 'NO_LINE', reason: NO_CALLBACK_LINE }
  return { ok: true, line: { id: row.id, e164: row.e164, label: row.friendlyName } }
}
