import 'server-only'
import type { PermissionKey } from '@/lib/permissions'
import { effectivePermissions } from '@/lib/permissions'
import { db } from '@/lib/db'
import { PRESENT_WITHIN_MS } from './presence'
import { SPEED_ALERT_MINUTES, SPEED_ESCALATE_MINUTES, SPEED_LOOKBACK_MS, speedAlertsDue, speedClockOpen } from './speed-clock'

/**
 * Speed-to-lead (docs/DIALER_POWER.md Lane C, item 4), run from the 5-minute
 * telephony sweep.
 *
 * A lead is untouched when it came from a form, nobody has tried it
 * (tries = 0), it has no CALL or OUTCOME on its trail, it is not on do-not-
 * call, booked or already a client, and it arrived in the last 24 hours.
 *
 *   5 min on the clock  → the reps who are online (VoicePresence ready) and
 *                         everyone with telephony:manage
 *   15 min on the clock → the org's super admins
 *
 * The clock is speed-clock.ts (9:00–20:00 Pacific). Each alert is claimed
 * with a conditional write on its column before anyone is notified, so two
 * sweeps running at once still send it once. Notifications use the app's
 * own inbox (the Notification table), the same way an unknown inbound caller
 * is announced in calls.ts.
 */

const LEADS_PER_RUN = 50

export type SpeedSummary = { checked: number; alerted: number; escalated: number; notified: number }

type Recipients = { alert: string[]; escalate: string[] }

async function recipientsFor(organizationId: string, now: Date): Promise<Recipients> {
  const users = await db.user.findMany({
    where: { organizationId, isActive: true, deletedAt: null },
    select: { id: true, role: { select: { key: true, permissions: { select: { permission: { select: { key: true } } } } } } },
  })
  const perms = new Map(
    users.map((u) => [u.id, effectivePermissions(u.role.key, u.role.permissions.map((p) => p.permission.key as PermissionKey))]),
  )
  const present = await db.voicePresence.findMany({
    where: { organizationId, state: 'ready', lastSeenAt: { gte: new Date(now.getTime() - PRESENT_WITHIN_MS) } },
    select: { userId: true },
  })
  const alert = new Set<string>()
  for (const p of present) if (perms.get(p.userId)?.has('communications:send')) alert.add(p.userId)
  for (const [id, set] of perms) if (set.has('telephony:manage')) alert.add(id)
  const escalate = users.filter((u) => u.role.key === 'SUPER_ADMIN').map((u) => u.id)
  return { alert: [...alert], escalate }
}

function leadLabel(last4: string | null): string {
  return last4 ? `A new form lead (•••-•••-${last4})` : 'A new form lead'
}

export async function runSpeedToLead(
  now = new Date(),
  opts: { organizationId?: string; left?: () => boolean } = {},
): Promise<SpeedSummary> {
  const summary: SpeedSummary = { checked: 0, alerted: 0, escalated: 0, notified: 0 }
  // Nothing can be due while the clock is stopped; skip the query entirely.
  if (!speedClockOpen(now)) return summary

  const leads = await db.callCenterLead.findMany({
    where: {
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
      source: 'FORM',
      tries: 0,
      doNotCallAt: null,
      clientId: null,
      status: { not: 'BOOKED' },
      createdAt: { gte: new Date(now.getTime() - SPEED_LOOKBACK_MS), lte: new Date(now.getTime() - SPEED_ALERT_MINUTES * 60_000) },
      OR: [{ speedAlertedAt: null }, { speedEscalatedAt: null }],
      events: { none: { type: { in: ['CALL', 'OUTCOME'] } } },
    },
    orderBy: { createdAt: 'asc' },
    take: LEADS_PER_RUN,
    select: { id: true, organizationId: true, createdAt: true, phoneLast4: true, speedAlertedAt: true, speedEscalatedAt: true },
  })

  // Claim first, notify after: one lead gets its own alert; several at once
  // (the 9:00 overnight backlog) get ONE summary per person, not a pile.
  type Claimed = { id: string; phoneLast4: string | null; minutes: number }
  const byOrg = new Map<string, { alert: Claimed[]; escalate: Claimed[] }>()
  const bucket = (orgId: string) => {
    let b = byOrg.get(orgId)
    if (!b) {
      b = { alert: [], escalate: [] }
      byOrg.set(orgId, b)
    }
    return b
  }

  for (const lead of leads) {
    if (opts.left && !opts.left()) break
    summary.checked += 1
    const due = speedAlertsDue(lead, now)
    if (due.alert) {
      const claimed = await db.callCenterLead.updateMany({ where: { id: lead.id, speedAlertedAt: null }, data: { speedAlertedAt: now } })
      if (claimed.count === 1) {
        summary.alerted += 1
        bucket(lead.organizationId).alert.push({ id: lead.id, phoneLast4: lead.phoneLast4, minutes: due.minutes })
      }
    }
    if (due.escalate) {
      const claimed = await db.callCenterLead.updateMany({ where: { id: lead.id, speedEscalatedAt: null }, data: { speedEscalatedAt: now } })
      if (claimed.count === 1) {
        summary.escalated += 1
        bucket(lead.organizationId).escalate.push({ id: lead.id, phoneLast4: lead.phoneLast4, minutes: due.minutes })
      }
    }
  }

  const send = async (organizationId: string, userIds: string[], list: Claimed[], level: 'alert' | 'escalate') => {
    if (!userIds.length || !list.length) return
    const one = list.length === 1 ? list[0] : null
    const title = one
      ? level === 'alert'
        ? `New lead waiting ${SPEED_ALERT_MINUTES} minutes`
        : `New lead still waiting after ${SPEED_ESCALATE_MINUTES} minutes`
      : level === 'alert'
        ? `${list.length} new leads waiting`
        : `${list.length} new leads still waiting after ${SPEED_ESCALATE_MINUTES} minutes`
    const body = one
      ? level === 'alert'
        ? `${leadLabel(one.phoneLast4)} has waited ${one.minutes} minutes and nobody has called yet.`
        : `${leadLabel(one.phoneLast4)} has waited ${one.minutes} minutes of calling time and nobody has called yet.`
      : `Nobody has called them yet. The longest has waited ${Math.max(...list.map((l) => l.minutes))} minutes. They're at the top of Today.`
    const href = one ? `/call-center?lead=${encodeURIComponent(one.id)}` : '/call-center'
    await db.notification.createMany({
      data: userIds.map((userId) => ({ organizationId, userId, kind: 'SLA_WARNING' as const, title, body, href })),
    })
    summary.notified += userIds.length
  }

  for (const [orgId, b] of byOrg) {
    const r = await recipientsFor(orgId, now)
    await send(orgId, r.alert, b.alert, 'alert')
    await send(orgId, r.escalate, b.escalate, 'escalate')
  }
  return summary
}
