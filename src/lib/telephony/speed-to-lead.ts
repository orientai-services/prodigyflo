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

  const recipients = new Map<string, Recipients>()
  const who = async (orgId: string) => {
    let r = recipients.get(orgId)
    if (!r) {
      r = await recipientsFor(orgId, now)
      recipients.set(orgId, r)
    }
    return r
  }

  for (const lead of leads) {
    if (opts.left && !opts.left()) break
    summary.checked += 1
    const due = speedAlertsDue(lead, now)
    const href = `/call-center?lead=${encodeURIComponent(lead.id)}`

    if (due.alert) {
      const claimed = await db.callCenterLead.updateMany({ where: { id: lead.id, speedAlertedAt: null }, data: { speedAlertedAt: now } })
      if (claimed.count === 1) {
        summary.alerted += 1
        const { alert } = await who(lead.organizationId)
        if (alert.length) {
          await db.notification.createMany({
            data: alert.map((userId) => ({
              organizationId: lead.organizationId,
              userId,
              kind: 'SLA_WARNING' as const,
              title: `New lead waiting ${SPEED_ALERT_MINUTES} minutes`,
              body: `${leadLabel(lead.phoneLast4)} has waited ${due.minutes} minutes and nobody has called yet.`,
              href,
            })),
          })
          summary.notified += alert.length
        }
      }
    }

    if (due.escalate) {
      const claimed = await db.callCenterLead.updateMany({ where: { id: lead.id, speedEscalatedAt: null }, data: { speedEscalatedAt: now } })
      if (claimed.count === 1) {
        summary.escalated += 1
        const { escalate } = await who(lead.organizationId)
        if (escalate.length) {
          await db.notification.createMany({
            data: escalate.map((userId) => ({
              organizationId: lead.organizationId,
              userId,
              kind: 'SLA_WARNING' as const,
              title: `New lead still waiting after ${SPEED_ESCALATE_MINUTES} minutes`,
              body: `${leadLabel(lead.phoneLast4)} has waited ${due.minutes} minutes of calling time and nobody has called yet.`,
              href,
            })),
          })
          summary.notified += escalate.length
        }
      }
    }
  }
  return summary
}
