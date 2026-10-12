import 'server-only'
import type { Prisma, SunoffHandoffStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { rememberNonce } from './sign'

/**
 * Hand-off status (docs/CYS_BRIDGE.md §B3.2). SunOff reports standby →
 * started → submitted; ProdigyFlo never moves a row backwards, except to
 * WITHDRAWN (closed-lost or deleted in SunOff), and a later send can revive a
 * withdrawn row. SENDING and ERROR are ProdigyFlo's own transient states.
 */

export const STATUS_RANK: Record<SunoffHandoffStatus, number> = {
  SENDING: 0,
  ERROR: 0,
  WITHDRAWN: 0,
  STANDBY: 1,
  STARTED: 2,
  SUBMITTED: 3,
}

const FROM_SUNOFF: Record<string, SunoffHandoffStatus> = {
  standby: 'STANDBY',
  started: 'STARTED',
  submitted: 'SUBMITTED',
  withdrawn: 'WITHDRAWN',
}

export function fromSunoffStatus(raw: unknown): SunoffHandoffStatus | null {
  return typeof raw === 'string' ? FROM_SUNOFF[raw.trim().toLowerCase()] ?? null : null
}

/** The status after `incoming`, or null when it would move the row backwards (or not at all). */
export function nextStatus(current: SunoffHandoffStatus, incoming: SunoffHandoffStatus): SunoffHandoffStatus | null {
  if (incoming === current) return null
  if (incoming === 'WITHDRAWN') return 'WITHDRAWN'
  return STATUS_RANK[incoming] > STATUS_RANK[current] ? incoming : null
}

/** "pf:<organizationId>:<callCenterLeadId>" → its parts, or null. */
export function parsePfLeadId(raw: unknown): { organizationId: string; leadId: string } | null {
  if (typeof raw !== 'string') return null
  const m = /^pf:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,64})$/.exec(raw)
  return m ? { organizationId: m[1], leadId: m[2] } : null
}

export const STATUS_LABEL: Record<SunoffHandoffStatus, string> = {
  SENDING: 'Sending to SunOff',
  STANDBY: 'In SunOff · Standby',
  STARTED: 'In SunOff · Started',
  SUBMITTED: 'In SunOff · Submitted',
  WITHDRAWN: 'Withdrawn in SunOff',
  ERROR: "SunOff didn't answer",
}

/** A desk trail line (CallCenterEvent HANDOFF) in the desk's { label, detail } shape. Never carries PII. */
export function handoffTrailBody(label: string, detail: string): string {
  return JSON.stringify({ label, detail: detail.replace(/\d{5,}/g, '····').slice(0, 300) })
}

/** System audit row (no session): the bridge acts, not a person. */
export async function bridgeAudit(
  store: Prisma.TransactionClient,
  organizationId: string,
  input: { action: string; entityId: string; summary: string; before?: unknown; after?: unknown },
): Promise<void> {
  await store.auditEvent.create({
    data: {
      organizationId,
      actorId: null,
      actorLabel: 'SunOff bridge (system)',
      action: input.action,
      entityType: 'SunoffHandoff',
      entityId: input.entityId,
      summary: input.summary,
      before: (input.before ?? undefined) as never,
      after: (input.after ?? undefined) as never,
    },
  })
}

export type StatusHookResult =
  | { ok: true; status: SunoffHandoffStatus; changed: boolean }
  | { ok: false; httpStatus: number; error: string; message: string }

/**
 * Applies a signed status hook from SunOff. The signature is checked by the
 * route; this checks the body, the replay key and monotonicity, then writes
 * the row, a HANDOFF trail line and an audit row in one transaction.
 */
export async function applySunoffStatus(
  body: unknown,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<StatusHookResult> {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  const ids = parsePfLeadId(b?.pf_lead_id)
  const incoming = fromSunoffStatus(b?.status)
  if (!b || !ids || !incoming) return { ok: false, httpStatus: 400, error: 'bad_body', message: 'pf_lead_id and status are required.' }
  if (!idempotencyKey || idempotencyKey.length > 200) return { ok: false, httpStatus: 400, error: 'missing_idempotency_key', message: 'Idempotency-Key is required.' }
  const sunoffLeadId = b.sunoff_lead_id == null ? null : Number(b.sunoff_lead_id)
  if (sunoffLeadId != null && (!Number.isInteger(sunoffLeadId) || sunoffLeadId <= 0)) {
    return { ok: false, httpStatus: 400, error: 'bad_body', message: 'sunoff_lead_id must be a positive integer.' }
  }
  const atRaw = typeof b.at === 'number' ? new Date(b.at * 1000) : typeof b.at === 'string' ? new Date(b.at) : now
  const at = Number.isNaN(atRaw.getTime()) ? now : atRaw
  const detail = typeof b.detail === 'string' ? b.detail.slice(0, 200) : ''

  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.sunoffHandoff.findFirst({ where: { callCenterLeadId: ids.leadId, organizationId: ids.organizationId } })
    if (!row) return { ok: false, httpStatus: 404, error: 'unknown_pf_lead', message: 'No hand-off for this lead.' }
    if (sunoffLeadId != null && row.sunoffLeadId != null && row.sunoffLeadId !== sunoffLeadId) {
      return { ok: false, httpStatus: 409, error: 'lead_mismatch', message: 'sunoff_lead_id does not match this hand-off.' }
    }
    const nonces = rememberNonce((row.nonces ?? {}) as Record<string, number>, idempotencyKey, now)
    if (!nonces) return { ok: false, httpStatus: 409, error: 'replay', message: 'This request was already received.' }
    const next = nextStatus(row.status, incoming)
    const done = await db.$transaction(async (tx) => {
      // Optimistic: the row must still be as read, or the loop reads it again.
      const updated = await tx.sunoffHandoff.updateMany({
        where: { id: row.id, updatedAt: row.updatedAt },
        data: {
          nonces,
          ...(row.sunoffLeadId == null && sunoffLeadId != null ? { sunoffLeadId } : {}),
          ...(next
            ? {
                status: next,
                ...(next === 'STARTED' ? { startedAt: at } : {}),
                ...(next === 'SUBMITTED' ? { submittedAt: at } : {}),
                ...(next === 'WITHDRAWN' ? { withdrawnAt: at, nextResendAt: null } : {}),
              }
            : {}),
        },
      })
      if (updated.count === 0) return false
      if (next) {
        await tx.callCenterEvent.create({
          data: { leadId: row.callCenterLeadId, type: 'HANDOFF', body: handoffTrailBody('CYS Sign up', STATUS_LABEL[next]) },
        })
        await bridgeAudit(tx, row.organizationId, {
          action: 'sunoff.handoff_status',
          entityId: row.id,
          summary: `${STATUS_LABEL[row.status]} → ${STATUS_LABEL[next]}`,
          before: { status: row.status },
          after: { status: next, at: at.toISOString(), detail: detail || undefined },
        })
      }
      return true
    })
    if (done) return { ok: true, status: next ?? row.status, changed: Boolean(next) }
  }
  return { ok: false, httpStatus: 409, error: 'busy', message: 'The hand-off changed while updating. Retry.' }
}
