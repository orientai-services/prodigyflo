import 'server-only'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { bridgeKey } from './client'
import { signBridgeRequest } from './sign'
import { syncAssignedSunoffLeads } from './assigned'
import { mayManageSunoff, sourceMeta, SUNOFF_PARTNERS, sunoffActive } from './assigned-model'
import type { DeskActor, DeskOutcome } from '@/lib/call-center/desk-types'

export type AssignedChange =
  | { type: 'desk'; outcome: DeskOutcome; followupAt: number | null }
  | { type: 'booking'; at: number; confirm?: boolean }
  | { type: 'confirm' }
  | { type: 'visit'; outcome: 'sat' | 'no-show' | 'rescheduled' | 'cancelled' }
export type AssignedWriteResult = { ok: true } | { ok: false; reason: string }
export const ASSIGNED_COMMAND_PATH = '/api/internal/prodigyflo-lead'

/** Source first, then reconcile its signed response. Never hold a database lock across the network.
 * One request id is reused on timeout, so retries cannot apply an outcome twice.
 * Actual actor identity/role comes from the authenticated server action, not form input.
 */
export async function writeAssignedLead(organizationId: string, actor: DeskActor, leadId: string, change: AssignedChange,
  options: { fetchImpl?: typeof fetch } = {}): Promise<AssignedWriteResult> {
  const row = await db.callCenterLead.findFirst({ where: { id: leadId, organizationId } })
  const m = sourceMeta(row?.leadAttribution)
  if (!row || !m || !sunoffActive(row.leadAttribution) || (row.lockedBy !== actor.id && !mayManageSunoff(actor.role, row.leadAttribution)))
    return { ok: false, reason: 'This SunOff lead is not assigned to you.' }
  const person = await db.user.findFirst({ where: { id: actor.id, organizationId, isActive: true, deletedAt: null }, select: { email: true } })
  const uid = Object.entries(SUNOFF_PARTNERS).find(([,p]) => p.email === person?.email.toLowerCase())?.[0]
  if (!person || (actor.role !== 'SUPER_ADMIN' && uid !== String(m.userId))) return { ok: false, reason: 'Not allowed.' }
  const key = bridgeKey()
  if (!key) return { ok: false, reason: 'SunOff sync is not configured.' }
  const body = JSON.stringify({ version: 1, requestId: randomUUID(), leadId: m.id, expected: m.sourceUpdatedAt,
    actor: { uid: actor.role === 'SUPER_ADMIN' ? 'owner' : uid, name: actor.name }, change })
  let response: Response | undefined
  for (let attempt=0; attempt<2; attempt++) {
    try {
      response = await (options.fetchImpl ?? fetch)(`https://dialer.sunoff.app${ASSIGNED_COMMAND_PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'SunOff-ProdigyFlo-Bridge/1.0', ...signBridgeRequest({ key, method: 'POST', path: ASSIGNED_COMMAND_PATH, body }) },
        body, signal: AbortSignal.timeout(25_000), redirect: 'manual', cache: 'no-store',
      })
      if (response.status < 500) break
    } catch { /* same request id and body on retry */ }
  }
  if (!response || response.status >= 500) return { ok: false, reason: 'Could not confirm the save with SunOff. Refresh before trying again.' }
  const data = await response.json().catch(() => null) as { ok?: boolean; error?: string; snapshot?: unknown } | null
  if (!response.ok || !data?.ok) return { ok: false, reason: data?.error === 'conflict'
    ? 'This lead changed in SunOff. Refresh it and try again.' : 'SunOff could not save this change. Refresh and try again.' }
  const synced = await syncAssignedSunoffLeads(data.snapshot)
  if (!synced.ok) return { ok: false, reason: 'Saved in SunOff. ProdigyFlo is still reconnecting; refresh shortly.' }
  return { ok: true }
}
