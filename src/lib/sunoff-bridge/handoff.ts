import 'server-only'
import type { SunoffHandoffStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/rbac'
import { HANDOFF_PATH, PROVISION_PATH, postToSunoff, sunoffBaseUrl } from './client'
import { PAYLOAD_MAX_BYTES, PAYLOAD_VERSION, buildSunoffPayload, pfLeadId } from './payload'
import { STATUS_LABEL, STATUS_RANK, bridgeAudit, fromSunoffStatus, handoffTrailBody } from './status'

/**
 * "CYS Sign up" (docs/CYS_BRIDGE.md §B3): send a desk lead's linked Client to
 * SunOff, where it waits in standby until a rep taps Start. The click path is
 * synchronous (the rep is waiting for the tab); a failure is shown, never
 * retried silently. Re-sends after profile changes are a separate cron step
 * (resendStaleHandoffs).
 *
 * Every function here takes the acting user; the server actions in
 * src/lib/call-center/sunoff-actions.ts supply it from the session.
 */

export type HandoffCode = 'NO_CLIENT' | 'NO_SUNOFF_USER' | 'SUNOFF_DOWN' | 'NOT_ALLOWED'
export type HandoffStatusOut = 'STANDBY' | 'STARTED' | 'SUBMITTED'
export type HandoffResult =
  | { ok: true; url: string; status: HandoffStatusOut; created: boolean }
  | { ok: false; reason: string; code?: HandoffCode }

export type HandoffState = {
  status: SunoffHandoffStatus
  sunoffLeadId: number | null
  lastSentAt: string | null
  /** The Client changed after the last send: offer "Re-send profile". */
  stale: boolean
  /** SunOff's error code from the last failed send, null after a success. */
  lastError: string | null
} | null

export type ProvisionResult =
  | { ok: true; created: boolean; message: string; email: string; sunoffUserId: number | null }
  | { ok: false; reason: string; code?: HandoffCode }

type Deps = { fetchImpl?: typeof fetch; now?: Date }

const NO_SUNOFF_USER_MESSAGE = 'Ask the owner to link your SunOff account.'
const DOWN_MESSAGE = "SunOff didn't answer · Retry"
/** A SENDING row younger than this means another click is in flight. */
const IN_FLIGHT_MS = 30_000
/** Re-send backoff after a profile change (cron), then give up until the next manual send. */
export const RESEND_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 2 * 3600_000, 2 * 3600_000]

type SunoffAccept = {
  sunoff_lead_id?: unknown
  url?: unknown
  status?: unknown
  created?: unknown
  matched_by?: unknown
}

/** Only a one-time SSO link on SunOff's own origin is ever handed to the browser. */
export function safeSunoffUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw)
    const base = new URL(sunoffBaseUrl())
    if (url.origin !== base.origin) return null
    if (url.protocol !== 'https:' && !(base.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(base.hostname))) return null
    return url.toString()
  } catch {
    return null
  }
}

async function accessibleLead(user: SessionUser, leadId: string, lockFree = false) {
  const lead = await db.callCenterLead.findFirst({
    where: { id: leadId, organizationId: user.organizationId },
    select: { id: true, organizationId: true, lockedBy: true, clientId: true },
  })
  if (!lead) return { ok: false as const, result: { ok: false as const, reason: 'Lead not found', code: 'NOT_ALLOWED' as const } }
  if (!lockFree && lead.lockedBy !== user.id && user.role !== 'SUPER_ADMIN') {
    return { ok: false as const, result: { ok: false as const, reason: 'Take the lead first', code: 'NOT_ALLOWED' as const } }
  }
  if (!lead.clientId) {
    return { ok: false as const, result: { ok: false as const, reason: 'Link the SCS intake to this lead first', code: 'NO_CLIENT' as const } }
  }
  const client = await db.client.findFirst({ where: { id: lead.clientId, organizationId: user.organizationId, deletedAt: null }, select: { id: true } })
  if (!client) return { ok: false as const, result: { ok: false as const, reason: 'The linked client is gone', code: 'NO_CLIENT' as const } }
  return { ok: true as const, lead: { ...lead, clientId: client.id } }
}

function outStatus(status: SunoffHandoffStatus): HandoffStatusOut {
  return status === 'STARTED' || status === 'SUBMITTED' ? status : 'STANDBY'
}

async function send(user: SessionUser, leadId: string, mode: 'start' | 'refresh' | 'resend', deps: Deps, forceFull = false): Promise<HandoffResult> {
  const now = deps.now ?? new Date()
  // The cron re-send acts for the original sender even after the lock moved on.
  const access = await accessibleLead(user, leadId, mode === 'resend')
  if (!access.ok) return access.result
  const { lead } = access

  let row = await db.sunoffHandoff.findUnique({ where: { callCenterLeadId: lead.id } })
  if (mode !== 'start' && !row) return { ok: false, reason: 'Send it to SunOff first', code: 'NOT_ALLOWED' }
  if (row && row.status === 'SENDING' && now.getTime() - row.updatedAt.getTime() < IN_FLIGHT_MS) {
    return { ok: false, reason: 'Already sending to SunOff', code: 'NOT_ALLOWED' }
  }
  if (!row) {
    row = await db.sunoffHandoff
      .create({ data: { organizationId: lead.organizationId, callCenterLeadId: lead.id, clientId: lead.clientId, createdById: user.id } })
      .catch(async () => db.sunoffHandoff.findUnique({ where: { callCenterLeadId: lead.id } }))
    if (!row) return { ok: false, reason: 'Could not start the hand-off', code: 'NOT_ALLOWED' }
  }

  const built = await buildSunoffPayload({
    organizationId: lead.organizationId,
    clientId: lead.clientId,
    leadId: lead.id,
    handoffId: row.id,
    rep: { id: user.id, name: user.name, email: user.email },
  })
  if (!built) return { ok: false, reason: 'The linked client is gone', code: 'NO_CLIENT' }
  if (built.bytes > PAYLOAD_MAX_BYTES) return { ok: false, reason: 'This profile is too large to send', code: 'NOT_ALLOWED' }

  const accepted = STATUS_RANK[row.status] > 0
  const sameRevision = accepted && row.revision === built.revision && row.clientId === lead.clientId
  // Unchanged and already in SunOff: ask only for a fresh one-time link.
  const purpose: 'handoff' | 'open' = mode === 'start' && sameRevision && !forceFull ? 'open' : 'handoff'
  const body = purpose === 'open'
    ? { version: PAYLOAD_VERSION, pf_lead_id: built.payload.pf_lead_id, pf_client_id: built.payload.pf_client_id, revision: built.revision, purpose, rep: built.payload.rep }
    : built.payload
  const attempts = row.attempts + 1
  const prior = row
  await db.sunoffHandoff.update({
    where: { id: row.id },
    data: { attempts, ...(accepted ? {} : { status: 'SENDING', clientId: lead.clientId }) },
  })

  const call = await postToSunoff<SunoffAccept>(HANDOFF_PATH, body, {
    idempotencyKey: `${row.id}:${built.revision}:${attempts}`,
    fetchImpl: deps.fetchImpl,
    now,
  })

  // SunOff lost the lead behind an "open": send everything again.
  if (purpose === 'open' && !call.ok && call.error === 'unknown_pf_lead') return send(user, leadId, mode, deps, true)
  const url = call.ok ? safeSunoffUrl(call.data.url) : null
  const sunoffLeadId = call.ok ? Number(call.data.sunoff_lead_id) : NaN
  if (!call.ok || !url || !Number.isInteger(sunoffLeadId) || sunoffLeadId <= 0) {
    const down = !call.ok ? call.down : false
    const code: HandoffCode = !call.ok && call.error === 'no_sunoff_user' ? 'NO_SUNOFF_USER' : down || call.ok ? 'SUNOFF_DOWN' : 'NOT_ALLOWED'
    const reason = code === 'NO_SUNOFF_USER'
      ? (call.ok ? NO_SUNOFF_USER_MESSAGE : call.message || NO_SUNOFF_USER_MESSAGE)
      : code === 'SUNOFF_DOWN' ? DOWN_MESSAGE : (!call.ok && call.message) || 'SunOff refused the hand-off'
    const lastError = call.ok ? 'bad_response' : call.error
    await db.$transaction(async (tx) => {
      await tx.sunoffHandoff.update({
        where: { id: row.id },
        data: { lastError, ...(accepted ? {} : { status: 'ERROR' }) },
      })
      await tx.callCenterEvent.create({ data: { leadId: lead.id, type: 'HANDOFF', body: handoffTrailBody('CYS Sign up', code === 'SUNOFF_DOWN' ? "SunOff didn't answer" : 'SunOff refused the hand-off', accepted ? prior.status : 'ERROR') } })
    })
    await recordAudit(user, {
      action: 'sunoff.handoff_failed',
      entityType: 'SunoffHandoff',
      entityId: row.id,
      summary: `${mode} · ${lastError}`,
      after: { error: lastError, http: call.ok ? call.status : call.status, attempts },
    })
    return { ok: false, reason, code }
  }

  const reported = fromSunoffStatus(call.data.status) ?? 'STANDBY'
  const created = call.data.created === true
  let status: SunoffHandoffStatus = reported
  await db.$transaction(async (tx) => {
    // SunOff's answer may lag a status hook that landed while we waited: never move back.
    const current = (await tx.sunoffHandoff.findUnique({ where: { id: row.id }, select: { status: true } }))?.status ?? prior.status
    const settled = current === 'SENDING' || current === 'ERROR' ? prior.status : current
    status = settled === 'WITHDRAWN' || STATUS_RANK[reported] >= STATUS_RANK[settled] ? reported : settled
    await tx.sunoffHandoff.update({
      where: { id: row.id },
      data: {
        status,
        sunoffLeadId,
        lastError: null,
        ...(status === 'STARTED' && !prior.startedAt ? { startedAt: now } : {}),
        ...(status === 'SUBMITTED' && !prior.submittedAt ? { submittedAt: now } : {}),
        ...(purpose === 'handoff'
          ? {
              clientId: lead.clientId,
              revision: built.revision,
              manifest: built.manifest,
              lastSentAt: now,
              resendTries: 0,
              nextResendAt: null,
            }
          : {}),
      },
    })
    if (purpose === 'handoff' || status !== prior.status) {
      await tx.callCenterEvent.create({
        data: { leadId: lead.id, type: 'HANDOFF', body: handoffTrailBody('CYS Sign up', purpose === 'handoff' && prior.revision ? `Profile re-sent · ${STATUS_LABEL[status]}` : STATUS_LABEL[status], status) },
      })
    }
  })
  if (purpose === 'handoff') {
    const after = { revision: built.revision, documents: built.manifest.length, status, created, sunoffLeadId, mode }
    if (mode === 'resend') await bridgeAudit(db, lead.organizationId, { action: 'sunoff.handoff_sent', entityId: row.id, summary: 'Profile re-sent after a change', after })
    else await recordAudit(user, { action: 'sunoff.handoff_sent', entityType: 'SunoffHandoff', entityId: row.id, summary: `Sent to SunOff · ${STATUS_LABEL[status]}`, after })
  }
  return { ok: true, url, status: outStatus(status), created }
}

export function startSunoffHandoffFor(user: SessionUser, leadId: string, deps: Deps = {}): Promise<HandoffResult> {
  return send(user, leadId, 'start', deps)
}

export function refreshSunoffHandoffFor(user: SessionUser, leadId: string, deps: Deps = {}): Promise<HandoffResult> {
  return send(user, leadId, 'refresh', deps)
}

/** The newest change on the Client that the payload reads. */
async function clientChangedAt(clientId: string): Promise<Date | null> {
  const [client, doc, survey, field, appt, brief] = await Promise.all([
    db.client.findUnique({ where: { id: clientId }, select: { updatedAt: true } }),
    db.clientDocument.findFirst({ where: { clientId }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    db.surveyResponse.findFirst({ where: { clientId }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    db.cysFieldValue.findFirst({ where: { clientId }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    db.appointment.findFirst({ where: { clientId }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    db.closerBrief.findFirst({ where: { clientId }, orderBy: { generatedAt: 'desc' }, select: { generatedAt: true } }),
  ])
  const times = [client?.updatedAt, doc?.updatedAt, survey?.updatedAt, field?.updatedAt, appt?.updatedAt, brief?.generatedAt].filter((d): d is Date => Boolean(d))
  return times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null
}

/** What the lead panel shows. Any desk user in the org may read it. */
export async function sunoffHandoffStateFor(user: SessionUser, leadId: string): Promise<HandoffState> {
  const row = await db.sunoffHandoff.findFirst({
    where: { callCenterLeadId: leadId, organizationId: user.organizationId },
    select: { status: true, sunoffLeadId: true, lastSentAt: true, clientId: true, lastError: true },
  })
  if (!row) return null
  const lead = await db.callCenterLead.findFirst({ where: { id: leadId, organizationId: user.organizationId }, select: { clientId: true } })
  const changed = row.lastSentAt ? await clientChangedAt(row.clientId) : null
  const stale = Boolean(
    row.lastSentAt && (lead?.clientId !== row.clientId || (changed && changed.getTime() > row.lastSentAt.getTime())),
  )
  return { status: row.status, sunoffLeadId: row.sunoffLeadId, lastSentAt: row.lastSentAt?.toISOString() ?? null, stale, lastError: row.lastError }
}

/**
 * Decision D2: create (or link) the signed-in user's SunOff account. SunOff
 * matches by email first and emails a set-password link to a new account.
 */
export async function provisionSunoffUserFor(user: SessionUser, deps: Deps = {}): Promise<ProvisionResult> {
  if (user.portalClientId) return { ok: false, reason: 'Not allowed', code: 'NOT_ALLOWED' }
  const call = await postToSunoff<{ created?: unknown; invite_sent?: unknown; user_id?: unknown }>(
    PROVISION_PATH,
    { version: PAYLOAD_VERSION, pf_user_id: user.id, name: user.name, email: user.email, org_id: user.organizationId },
    { idempotencyKey: `provision:${user.id}:${(deps.now ?? new Date()).getTime()}`, fetchImpl: deps.fetchImpl, now: deps.now },
  )
  if (!call.ok) {
    return call.down
      ? { ok: false, reason: DOWN_MESSAGE, code: 'SUNOFF_DOWN' }
      : { ok: false, reason: call.message || 'SunOff could not create the account', code: 'NOT_ALLOWED' }
  }
  const created = call.data.created === true
  await recordAudit(user, { action: 'sunoff.user_provisioned', entityType: 'User', entityId: user.id, summary: created ? 'SunOff account created' : 'SunOff account linked', after: { created } })
  const id = Number(call.data.user_id)
  return {
    ok: true,
    created,
    email: user.email,
    sunoffUserId: Number.isInteger(id) && id > 0 ? id : null,
    message: created ? `SunOff account created. Check ${user.email} for the link to set a password.` : 'Your SunOff account is linked.',
  }
}

/**
 * The signed-in user's SunOff user id without creating anything (chat lane):
 * the provision endpoint with `create: false`; SunOff answers 422
 * no_sunoff_user when nobody matches (link row, then unique email). Nothing
 * is stored on the ProdigyFlo side.
 */
export async function sunoffUserIdFor(user: SessionUser, deps: Deps = {}): Promise<number | null> {
  const call = await postToSunoff<{ user_id?: unknown }>(
    PROVISION_PATH,
    { version: PAYLOAD_VERSION, pf_user_id: user.id, name: user.name, email: user.email, org_id: user.organizationId, create: false },
    { idempotencyKey: `lookup:${user.id}:${(deps.now ?? new Date()).getTime()}`, fetchImpl: deps.fetchImpl, now: deps.now },
  )
  const id = call.ok ? Number(call.data.user_id) : NaN
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Cron step (meant for /api/jobs/run): re-send STANDBY hand-offs whose Client
 * changed after the last send. Backoff 1, 5, 30 min, then 2 h, at most 6
 * tries; the sender is the user who first sent it.
 */
export async function resendStaleHandoffs(deps: Deps & { limit?: number } = {}): Promise<{ checked: number; sent: number; failed: number }> {
  const now = deps.now ?? new Date()
  const rows = await db.sunoffHandoff.findMany({
    where: { status: 'STANDBY', lastSentAt: { not: null }, resendTries: { lt: RESEND_BACKOFF_MS.length }, OR: [{ nextResendAt: null }, { nextResendAt: { lte: now } }] },
    orderBy: { updatedAt: 'asc' },
    take: deps.limit ?? 25,
  })
  const totals = { checked: rows.length, sent: 0, failed: 0 }
  const { loadActor } = await import('@/lib/automation/actor')
  for (const row of rows) {
    const changed = await clientChangedAt(row.clientId)
    if (!changed || !row.lastSentAt || changed.getTime() <= row.lastSentAt.getTime()) continue
    const actor = await loadActor(row.createdById)
    if (!actor || actor.organizationId !== row.organizationId) continue
    const result = await send(actor, row.callCenterLeadId, 'resend', { ...deps, now })
    if (result.ok) totals.sent += 1
    else {
      totals.failed += 1
      const tries = row.resendTries + 1
      await db.sunoffHandoff.update({
        where: { id: row.id },
        data: { resendTries: tries, nextResendAt: new Date(now.getTime() + RESEND_BACKOFF_MS[Math.min(tries, RESEND_BACKOFF_MS.length) - 1]) },
      })
    }
  }
  return totals
}

export { pfLeadId }
