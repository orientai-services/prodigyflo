'use server'

import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { ZONE_WAIT_NOTE } from '@/lib/automation/engine'
import { can, requireUser, type SessionUser } from '@/lib/rbac'
import { platformCredentials, telephonyCredentialsDetailed } from './index'
import type { NumberActionResult } from './numbers'
import { toE164, formatE164 } from './provider'
import { mintVoiceToken } from './access-token'
import { fetchA2pStatus, getAccountState, normalizeMode, setManualAccountState, setVoiceLimitMode } from './account-status'
import { auditOutbound, decideOutbound, signOverride } from './compliance'
import { last4Of, phoneHash, phoneHashOrNull, PhoneHashKeyMissingError } from './compliance-core'
import { resolveCallerLine } from './lines'
import {
  applyNumberSync as applySync,
  previewNumberSync as previewSync,
  setNumberAssignment as assignNumber,
} from './number-sync'
import { saveTelephonySettings, telephonySettingsFor } from './settings'
import { twilioStatusFor } from './status-view'
import { blockNumber, clearSmsPair, removeBlock } from './suppressions'
import { resolveDialTarget, targetKey } from './targets'
import { guardAccountAction } from './tenancy'
import { clampWindow, isValidZone } from './timezones'
import { listMissed, markHandled } from './voice-calls'
import { voiceBrowserEnabled, voiceKeys, voiceSetupFor, FLAG_OFF } from './voice-config'
import type {
  CallingRulesVM,
  DialCheck,
  DialTarget,
  MissedCallVM,
  SuppressionVM,
  SyncPreviewVM,
  SyncResultVM,
  TwilioStatusVM,
  VoiceSetup,
  VoiceToken,
} from './voice-contract'

/**
 * The telephony server actions (docs/TELEPHONY_LIVE.md §3). Each one re-checks
 * permission itself — the UI hiding a button is a courtesy, not the control —
 * and none returns a secret, a token other than the voice JWT, or a full phone
 * number to anyone without telephony:manage in the owning org.
 *
 * Results follow NumberActionResult ({ ok: true, … } | { ok: false, error,
 * code? }); list and view-model actions return their payload bare.
 */

type Fail = { ok: false; error: string; code?: string }
const fail = (error: string, code?: string): Fail => ({ ok: false, error, code })
const NO_PERMISSION = fail("You don't have permission to do that.", 'FORBIDDEN')

function isTarget(t: unknown): t is DialTarget {
  if (!t || typeof t !== 'object') return false
  const v = t as { kind?: unknown; id?: unknown }
  return (v.kind === 'client' || v.kind === 'lead' || v.kind === 'missed') && typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 200
}

// ── Browser calling (P0b) ────────────────────────────────────────────────────

export async function getVoiceSetup(): Promise<VoiceSetup> {
  const user = await requireUser()
  return voiceSetupFor(user)
}

export async function getVoiceToken(): Promise<VoiceToken | Fail> {
  const user = await requireUser()
  if (!can(user, 'communications:send')) return NO_PERMISSION
  if (!voiceBrowserEnabled()) return fail(FLAG_OFF, 'FLAG_OFF')
  const setup = await voiceSetupFor(user)
  if (!setup.ready) return fail(setup.reason, 'NOT_READY')
  const keys = voiceKeys()
  const platform = platformCredentials()
  if (!keys || !platform) return fail("Phone calling isn't set up yet.", 'NOT_CONFIGURED')
  const minted = await mintVoiceToken({
    accountSid: platform.accountSid,
    apiKeySid: keys.apiKeySid,
    apiKeySecret: keys.apiKeySecret,
    appSid: keys.appSid,
    identity: setup.identity,
    now: new Date(),
  })
  return { token: minted.token, identity: setup.identity, expiresAt: minted.expiresAt.toISOString() }
}

/**
 * The pre-check every "Call" runs: in P0a before the tel: link opens, in P0b
 * before Device.connect (and the webhook checks again, authoritatively). An
 * hours override is for telephony:manage only, needs a reason, and can only
 * widen the account window up to the legal ceiling.
 */
export async function checkDial(
  target: DialTarget,
  lineId?: string,
  override?: { kind: 'hours'; reason: string },
): Promise<DialCheck> {
  const user = await requireUser()
  if (!can(user, 'communications:send')) {
    return { ok: false, code: 'NO_PERMISSION', reason: "You don't have permission to place calls.", canOverride: null }
  }
  if (!isTarget(target)) return { ok: false, code: 'NOT_IN_SCOPE', reason: "That contact isn't in your list.", canOverride: null }

  const resolved = await resolveDialTarget(user, target)
  if (!resolved.ok) return { ok: false, code: resolved.code, reason: resolved.reason, canOverride: null }
  const t = resolved.target

  let line: { id: string; display: string; label: string; isDefault: boolean } | null = null
  const setup = voiceBrowserEnabled() ? await voiceSetupFor(user) : null
  if (setup?.ready) {
    const picked = await resolveCallerLine(user, lineId ?? null)
    if (!picked.ok) return { ok: false, code: 'NO_LINE', reason: picked.reason, canOverride: null }
    line = { id: picked.line.id, display: formatE164(picked.line.e164), label: picked.line.label, isDefault: !lineId }
  }

  const input = {
    organizationId: user.organizationId,
    channel: 'CALL' as const,
    purpose: t.purpose,
    phone: t.phone,
    servicingBasis: t.servicingBasis,
    clientId: t.clientId,
    leadId: t.leadId,
    zoneHints: t.zoneHints,
  }
  const manager = can(user, 'telephony:manage')
  let decision = await decideOutbound(input, { actor: user })
  let overrideToken: string | undefined

  if (!decision.allowed && decision.code === 'OUTSIDE_HOURS' && decision.canOverride === 'hours' && override?.kind === 'hours' && manager) {
    const reason = override.reason?.trim()
    if (!reason) return { ok: false, code: 'OUTSIDE_HOURS', reason: 'Give a reason for calling outside the window.', canOverride: 'hours' }
    const now = new Date()
    const token = signOverride(
      { orgId: user.organizationId, userId: user.id, target: targetKey(target), lineId: line?.id ?? '', code: 'OUTSIDE_HOURS' },
      now,
    )
    if (!token) return { ok: false, code: 'NOT_CONFIGURED', reason: "Hours overrides aren't set up yet.", canOverride: null }
    decision = await decideOutbound(input, { actor: user, override: true, now })
    if (decision.allowed) {
      overrideToken = token
      await auditOutbound(input, user, {
        action: 'telephony.hours_override',
        summary: `Hours override for a call to •••${last4Of(t.phone) ?? ''}: ${reason.slice(0, 200)}`,
        after: { reason: reason.slice(0, 500), target: target.kind, last4: last4Of(t.phone) },
      })
    }
  }

  if (!decision.allowed) {
    return { ok: false, code: decision.code, reason: decision.reason, canOverride: manager ? decision.canOverride : null }
  }
  return {
    ok: true,
    who: t.who,
    purpose: decision.purpose,
    calleeLocalTime: decision.calleeLocalTime,
    calleeZone: decision.calleeZone,
    line,
    basis: decision.basis,
    ...(overrideToken ? { overrideToken } : {}),
    // P0a call back (missed calls from unknown numbers) needs something to
    // dial. Full numbers stay with telephony:manage (§3).
    ...(!line && manager && t.phone ? { dial: t.phone } : {}),
  }
}

// ── Missed calls ─────────────────────────────────────────────────────────────

export async function listMissedCalls(): Promise<MissedCallVM[]> {
  const user = await requireUser()
  return listMissed(user)
}

export async function markMissedCallHandled(id: string, note?: string): Promise<NumberActionResult> {
  const user = await requireUser()
  if (typeof id !== 'string' || !id) return fail('That call is not on your list.')
  const res = await markHandled(user, id, note)
  if (!res.ok) return fail(res.error)
  await recordAudit(user, {
    action: 'telephony.missed_handled',
    entityType: 'VoiceCall',
    entityId: id,
    summary: 'Missed call marked handled',
    after: { note: note?.trim().slice(0, 200) || null },
  })
  return { ok: true }
}

// ── Numbers at the carrier ───────────────────────────────────────────────────

export async function previewNumberSync(organizationId?: string): Promise<SyncPreviewVM | Fail> {
  const user = await requireUser()
  const res = await previewSync({ kind: 'user', user }, organizationId)
  return res.ok ? res.preview : fail(res.error, res.code)
}

export async function setNumberAssignment(input: { sid: string; organizationId: string | null }): Promise<NumberActionResult> {
  const user = await requireUser()
  const res = await assignNumber(user, { sid: String(input?.sid ?? ''), organizationId: input?.organizationId || null })
  return res.ok ? { ok: true } : fail(res.error, res.code)
}

export async function applyNumberSync(input: {
  organizationId?: string
  importSids: string[]
  repointSids: string[]
}): Promise<SyncResultVM | Fail> {
  const user = await requireUser()
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 500) : [])
  const res = await applySync(
    { kind: 'user', user },
    { organizationId: input?.organizationId, importSids: strings(input?.importSids), repointSids: strings(input?.repointSids) },
  )
  return res.ok ? res.result : fail(res.error, res.code)
}

// ── Account status ───────────────────────────────────────────────────────────

export async function getTwilioStatus(refresh?: boolean): Promise<TwilioStatusVM | Fail> {
  const user = await requireUser()
  if (!can(user, 'telephony:read')) return NO_PERMISSION
  return twilioStatusFor(user, { refresh: refresh === true })
}

export async function setVoiceLimitedMode(mode: 'auto' | 'on' | 'off'): Promise<NumberActionResult> {
  const user = await requireUser()
  const guard = await guardAccountAction(user, user.organizationId)
  if (!guard.ok) return fail(guard.error, guard.code)
  const next = normalizeMode(mode)
  const before = (await getAccountState(guard.scope.creds.accountSid))?.voiceLimitedMode ?? 'auto'
  await setVoiceLimitMode(guard.scope.creds.accountSid, next, user.id)
  await recordAudit(user, {
    action: 'telephony.voice_limit_mode',
    entityType: 'TelephonyAccountState',
    summary: `One-call-at-a-time mode set to ${next}`,
    before: { mode: before },
    after: { mode: next },
  })
  return { ok: true }
}

const PROFILE_STATES = new Set(['twilio-approved', 'pending-review', 'in-review', 'twilio-rejected', 'draft'])

export async function setManualCarrierState(input: {
  profile?: string | null
  a2p?: string | null
  mediaAuth?: 'on' | 'off' | 'unknown' | null
}): Promise<NumberActionResult> {
  const user = await requireUser()
  const guard = await guardAccountAction(user, user.organizationId)
  if (!guard.ok) return fail(guard.error, guard.code)
  const profile = input?.profile === undefined ? undefined : input.profile ? String(input.profile).slice(0, 40) : null
  if (profile && !PROFILE_STATES.has(profile)) return fail('Pick one of the listed profile states.', 'BAD_STATE')
  const mediaAuth = input?.mediaAuth === undefined ? undefined : input.mediaAuth
  if (mediaAuth && !['on', 'off', 'unknown'].includes(mediaAuth)) return fail('Media auth is on, off or unknown.', 'BAD_STATE')
  if (profile !== undefined || mediaAuth !== undefined) {
    await setManualAccountState(guard.scope.creds.accountSid, { profile, mediaAuth }, user.id)
  }
  if (input?.a2p !== undefined) {
    const a2p = input.a2p ? { status: String(input.a2p).slice(0, 40), source: 'manual', checkedAt: new Date().toISOString() } : null
    await saveTelephonySettings(user.organizationId, { a2p })
  }
  await recordAudit(user, {
    action: 'telephony.carrier_state_manual',
    entityType: 'TelephonyAccountState',
    summary: 'Carrier state recorded by hand',
    after: { profile: profile ?? undefined, a2p: input?.a2p ?? undefined, mediaAuth: mediaAuth ?? undefined },
  })
  return { ok: true }
}

export async function setMessagingService(input: { organizationId: string; sid: string | null }): Promise<NumberActionResult> {
  const user = await requireUser()
  const orgId = String(input?.organizationId ?? '')
  if (!orgId) return fail('Pick an account.')
  const guard = await guardAccountAction(user, orgId)
  if (!guard.ok) return fail(guard.error, guard.code)
  const sid = input.sid ? String(input.sid).trim() : null
  if (sid && !/^MG[0-9a-f]{32}$/.test(sid)) return fail("That isn't a Messaging Service SID (MG…).", 'BAD_SID')
  const status = sid ? await fetchA2pStatus(sid, guard.scope.creds) : null
  await saveTelephonySettings(orgId, {
    messagingServiceSid: sid,
    a2p: sid && status ? { status, source: 'twilio', checkedAt: new Date().toISOString() } : null,
  })
  await recordAudit(user, {
    action: 'telephony.messaging_service_set',
    entityType: 'Organization',
    entityId: orgId,
    summary: sid ? `Messaging Service set (${sid.slice(0, 6)}…${sid.slice(-4)})` : 'Messaging Service cleared',
    after: { organizationId: orgId, a2p: status },
  })
  return { ok: true }
}

// ── Do-not-contact list ──────────────────────────────────────────────────────

export async function listSuppressions(): Promise<SuppressionVM[] | Fail> {
  const user = await requireUser()
  if (!can(user, 'communications:send')) return NO_PERMISSION
  const rows = await db.callCenterSuppression.findMany({
    where: { organizationId: user.organizationId, removedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  const ids = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => Boolean(v)))]
  const users = ids.length
    ? await db.user.findMany({ where: { id: { in: ids }, organizationId: user.organizationId }, select: { id: true, name: true } })
    : []
  const names = new Map(users.map((u) => [u.id, u.name]))
  return rows.map((r) => {
    const legacy = !r.smsBlockedAt && !r.callBlockedAt
    return {
      id: r.id,
      last4: r.last4 ?? '····',
      reason: r.reason,
      by: r.createdById ? names.get(r.createdById) ?? null : null,
      sms: r.smsBlockedAt
        ? { at: r.smsBlockedAt.toISOString(), source: r.smsBlockedSource ?? 'manual' }
        : legacy
          ? { at: r.createdAt.toISOString(), source: 'import' }
          : null,
      call: r.callBlockedAt
        ? { at: r.callBlockedAt.toISOString(), source: r.callBlockedSource ?? 'manual' }
        : legacy
          ? { at: r.createdAt.toISOString(), source: 'import' }
          : null,
    }
  })
}

function hashOrFail(phone: string): { ok: true; e164: string; hash: string } | Fail {
  const e164 = toE164(phone ?? '')
  if (!e164) return fail("That isn't a valid phone number.", 'BAD_NUMBER')
  try {
    return { ok: true, e164, hash: phoneHash(e164) }
  } catch (err) {
    if (err instanceof PhoneHashKeyMissingError) return fail("The do-not-call list isn't set up yet (PHONE_HASH_KEY).", 'NOT_CONFIGURED')
    throw err
  }
}

export async function addSuppression(input: { phone: string; sms: boolean; call: boolean; reason: string }): Promise<NumberActionResult> {
  const user = await requireUser()
  if (!can(user, 'communications:send')) return NO_PERMISSION
  if (!input?.sms && !input?.call) return fail('Block texts, calls, or both.', 'NOTHING_BLOCKED')
  const reason = String(input.reason ?? '').trim()
  if (!reason) return fail('Say why this number is blocked.', 'NO_REASON')
  const h = hashOrFail(String(input.phone ?? ''))
  if (!('hash' in h)) return h
  await blockNumber({
    organizationId: user.organizationId,
    numberHash: h.hash,
    last4: last4Of(h.e164),
    sms: input.sms ? 'manual' : null,
    call: input.call ? 'manual' : null,
    reason,
    createdById: user.id,
  })
  await recordAudit(user, {
    action: 'telephony.suppression_added',
    entityType: 'CallCenterSuppression',
    summary: `Number ending ${last4Of(h.e164)} blocked (${[input.sms && 'texts', input.call && 'calls'].filter(Boolean).join(' and ')})`,
    after: { last4: last4Of(h.e164), sms: Boolean(input.sms), call: Boolean(input.call), reason: reason.slice(0, 200) },
  })
  return { ok: true }
}

export async function removeSuppression(id: string, note: string): Promise<NumberActionResult> {
  const user = await requireUser()
  if (!can(user, 'telephony:manage')) return NO_PERMISSION
  const text = String(note ?? '').trim()
  if (!text) return fail('Add a note saying why it is coming off the list.', 'NO_NOTE')
  const row = await db.callCenterSuppression.findFirst({ where: { id, organizationId: user.organizationId, removedAt: null } })
  if (!row) return fail('That entry is not on the list.', 'NOT_FOUND')
  await removeBlock(row.id, user.organizationId, user.id, text)
  await recordAudit(user, {
    action: 'telephony.suppression_removed',
    entityType: 'CallCenterSuppression',
    entityId: row.id,
    summary: `Number ending ${row.last4 ?? '····'} removed from the do-not-contact list`,
    before: { sms: row.smsBlockedSource, call: row.callBlockedSource },
    after: { note: text.slice(0, 200) },
  })
  return { ok: true }
}

export async function reviewSmsOptOut(id: string, decision: 'confirm' | 'lift', note: string): Promise<NumberActionResult> {
  const user = await requireUser()
  if (!can(user, 'telephony:manage')) return NO_PERMISSION
  if (decision !== 'confirm' && decision !== 'lift') return fail('Confirm or lift.', 'BAD_DECISION')
  const row = await db.callCenterSuppression.findFirst({
    where: { id, organizationId: user.organizationId, removedAt: null, smsBlockedSource: 'sms_stop_review' },
  })
  if (!row) return fail('That possible opt-out is not waiting for review.', 'NOT_FOUND')
  const now = new Date()
  if (decision === 'confirm') {
    await db.callCenterSuppression.update({
      where: { id: row.id },
      data: { smsBlockedSource: 'sms_stop', note: String(note ?? '').slice(0, 500) || row.note },
    })
    await db.callCenterLead.updateMany({
      where: { organizationId: user.organizationId, phoneHash: row.numberHash, consentRevokedAt: null },
      data: { consentRevokedAt: now },
    })
    // A confirmed opt-out is a revocation like a bare STOP: the client's TCPA
    // consent ends too, so calls need consent again and START can't undo it.
    await revokeClientConsentsFor(user, row.numberHash, row.last4, now)
  } else {
    await clearSmsPair({ organizationId: user.organizationId, id: row.id, smsBlockedSource: 'sms_stop_review' }, user.id, now)
  }
  await recordAudit(user, {
    action: 'telephony.optout_review',
    entityType: 'CallCenterSuppression',
    entityId: row.id,
    summary: `Possible opt-out ${decision === 'confirm' ? 'confirmed' : 'lifted'} for the number ending ${row.last4 ?? '····'}`,
    after: { decision, note: String(note ?? '').slice(0, 200) },
  })
  return { ok: true }
}

/** Clients in the viewer's org whose phone hashes to this number: their live TCPA consent is revoked. */
async function revokeClientConsentsFor(user: SessionUser, numberHash: string, last4: string | null, now: Date): Promise<number> {
  if (!last4) return 0
  const candidates = await db.client.findMany({
    where: { organizationId: user.organizationId, phone: { contains: last4 } },
    select: { id: true, phone: true },
    take: 500,
  })
  const clientIds = candidates.filter((c) => phoneHashOrNull(c.phone) === numberHash).map((c) => c.id)
  let total = 0
  for (const clientId of clientIds) {
    const revoked = await db.consent.updateMany({
      where: { clientId, type: 'TCPA_CONTACT', granted: true, revokedAt: null },
      data: { revokedAt: now },
    })
    total += revoked.count
    await recordAudit(user, {
      action: 'consent.revoked',
      entityType: 'Client',
      entityId: clientId,
      summary: `TCPA contact consent revoked: opt-out confirmed by staff (${revoked.count} consent record${revoked.count === 1 ? '' : 's'} updated)`,
      after: { trigger: 'optout_review_confirmed' },
    })
  }
  return total
}

// ── Team numbers, consent, time zones, calling rules ─────────────────────────

export async function listTeamNumbers(): Promise<{ hash: string; last4: string; label: string }[] | Fail> {
  const user = await requireUser()
  if (!can(user, 'telephony:manage')) return NO_PERMISSION
  const settings = await telephonySettingsFor(user.organizationId)
  return settings.teamNumbers.map((t) => ({ hash: t.hash, last4: t.last4, label: t.label }))
}

export async function addTeamNumber(input: { phone: string; label: string }): Promise<NumberActionResult> {
  const user = await requireUser()
  if (!can(user, 'telephony:manage')) return NO_PERMISSION
  const label = String(input?.label ?? '').trim().slice(0, 60)
  if (!label) return fail('Give the number a label (whose phone it is).', 'NO_LABEL')
  const h = hashOrFail(String(input?.phone ?? ''))
  if (!('hash' in h)) return h
  const settings = await telephonySettingsFor(user.organizationId)
  if (settings.teamNumbers.some((t) => t.hash === h.hash)) return { ok: true }
  const teamNumbers = [
    ...settings.teamNumbers,
    { hash: h.hash, last4: last4Of(h.e164) ?? '', label, addedById: user.id, addedAt: new Date().toISOString() },
  ].slice(-100)
  await saveTelephonySettings(user.organizationId, { teamNumbers })
  await recordAudit(user, {
    action: 'telephony.team_number_added',
    entityType: 'Organization',
    entityId: user.organizationId,
    summary: `Team number ending ${last4Of(h.e164)} added (${label})`,
    after: { last4: last4Of(h.e164), label },
  })
  return { ok: true }
}

export async function removeTeamNumber(hash: string): Promise<NumberActionResult> {
  const user = await requireUser()
  if (!can(user, 'telephony:manage')) return NO_PERMISSION
  const settings = await telephonySettingsFor(user.organizationId)
  const gone = settings.teamNumbers.find((t) => t.hash === hash)
  if (!gone) return { ok: true }
  await saveTelephonySettings(user.organizationId, { teamNumbers: settings.teamNumbers.filter((t) => t.hash !== hash) })
  await recordAudit(user, {
    action: 'telephony.team_number_removed',
    entityType: 'Organization',
    entityId: user.organizationId,
    summary: `Team number ending ${gone.last4} removed`,
    before: { last4: gone.last4, label: gone.label },
  })
  return { ok: true }
}

async function leadForTarget(user: SessionUser, target: DialTarget): Promise<string | null> {
  if (target.kind === 'lead') {
    const lead = await db.callCenterLead.findFirst({ where: { id: target.id, organizationId: user.organizationId }, select: { id: true } })
    return lead?.id ?? null
  }
  if (target.kind === 'missed') {
    const vc = await db.voiceCall.findFirst({ where: { id: target.id, organizationId: user.organizationId }, select: { callCenterLeadId: true } })
    return vc?.callCenterLeadId ?? null
  }
  return null
}

/**
 * A manager records consent by hand. The note must say where the signed
 * consent is kept. Recording it again is also how texting/calling comes back
 * after a STOP — a START alone never restores consent.
 */
export async function recordConsent(input: { target: DialTarget; note: string }): Promise<NumberActionResult> {
  const user = await requireUser()
  if (!can(user, 'telephony:manage')) return NO_PERMISSION
  if (!isTarget(input?.target)) return fail("That contact isn't in your list.", 'NOT_IN_SCOPE')
  const note = String(input.note ?? '').trim()
  if (note.length < 5) return fail('Say where the signed consent is kept.', 'NO_NOTE')
  const now = new Date()
  if (input.target.kind === 'client') {
    const resolved = await resolveDialTarget(user, input.target)
    if (!resolved.ok || !resolved.target.clientId) return fail("That contact isn't in your list.", 'NOT_IN_SCOPE')
    await db.consent.create({
      data: {
        clientId: resolved.target.clientId,
        type: 'TCPA_CONTACT',
        granted: true,
        textVersion: 'manual',
        text: note.slice(0, 2000),
        purpose: 'Recorded by staff',
        grantedAt: now,
      },
    })
    await auditOutbound({ organizationId: user.organizationId, clientId: resolved.target.clientId }, user, {
      action: 'telephony.consent_recorded',
      summary: 'Contact consent recorded by staff',
      after: { source: 'manual', note: note.slice(0, 200) },
    })
    return { ok: true }
  }
  const leadId = await leadForTarget(user, input.target)
  if (!leadId) return fail("That contact isn't in your list.", 'NOT_IN_SCOPE')
  await db.callCenterLead.update({
    where: { id: leadId },
    data: { consentAt: now, consentSource: 'manual', consentNote: note.slice(0, 500), consentRevokedAt: null, consentFormId: null, consentTextVersion: null },
  })
  await auditOutbound({ organizationId: user.organizationId, leadId }, user, {
    action: 'telephony.consent_recorded',
    summary: 'Contact consent recorded by staff',
    after: { source: 'manual', note: note.slice(0, 200) },
  })
  return { ok: true }
}

/** Adding a form is the owner's statement that THIS form's text carries the consent language. */
export async function setConsentForms(input: { formId: string; textVersion: string | null }): Promise<NumberActionResult> {
  const user = await requireUser()
  if (!can(user, 'telephony:manage')) return NO_PERMISSION
  const formId = String(input?.formId ?? '').trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(formId)) return fail("That isn't a Facebook form id.", 'BAD_FORM')
  const version = input.textVersion ? String(input.textVersion).trim().slice(0, 80) : null
  const settings = await telephonySettingsFor(user.organizationId)
  const consentForms = { ...settings.consentForms }
  const before = consentForms[formId] ?? null
  if (version) consentForms[formId] = version
  else delete consentForms[formId]
  await saveTelephonySettings(user.organizationId, { consentForms })
  await recordAudit(user, {
    action: 'telephony.consent_form_set',
    entityType: 'Organization',
    entityId: user.organizationId,
    summary: version ? `Form ${formId} marked as carrying consent text ${version}` : `Form ${formId} no longer counts as consent`,
    before: { formId, textVersion: before },
    after: { formId, textVersion: version },
  })
  return { ok: true }
}

/**
 * "They told us they're in X." Saved on the lead, or on the client — for a
 * client whose address and number don't give a zone (a number abroad), this is
 * the only honest way past UNKNOWN_TIMEZONE. Audited with the note either way.
 */
export async function setContactTimeZone(input: { target: DialTarget; zone: string; note: string }): Promise<NumberActionResult> {
  const user = await requireUser()
  if (!can(user, 'communications:send')) return NO_PERMISSION
  if (!isTarget(input?.target)) return fail("That contact isn't in your list.", 'NOT_IN_SCOPE')
  const zone = String(input.zone ?? '').trim()
  if (!isValidZone(zone) || !/^(America|Pacific)\//.test(zone)) return fail('Pick a time zone from the list.', 'BAD_ZONE')
  const resolved = await resolveDialTarget(user, input.target)
  if (!resolved.ok) return fail(resolved.reason, resolved.code)
  const clientId = resolved.target.clientId
  if (clientId) {
    const before = await db.client.findUnique({ where: { id: clientId }, select: { timeZone: true } })
    await db.client.update({ where: { id: clientId }, data: { timeZone: zone } })
    await auditOutbound({ organizationId: user.organizationId, clientId }, user, {
      action: 'telephony.timezone_set',
      summary: `Time zone set to ${zone}`,
      after: { before: before?.timeZone ?? null, zone, note: String(input.note ?? '').slice(0, 200) },
    })
    // Automated texts parked for this client's zone go on the next job run
    // (which still applies the calling hours), not hours from now.
    const now = new Date()
    await db.scheduledMessage.updateMany({ where: { clientId, status: 'PENDING', error: ZONE_WAIT_NOTE }, data: { sendAt: now } })
    await db.sequenceEnrollment.updateMany({ where: { clientId, status: 'ACTIVE', stoppedReason: ZONE_WAIT_NOTE }, data: { nextRunAt: now } })
    return { ok: true }
  }
  const leadId = resolved.target.leadId
  if (!leadId) return fail('This caller has no lead to save the time zone on.', 'NO_LEAD')
  const before = await db.callCenterLead.findUnique({ where: { id: leadId }, select: { timeZone: true } })
  await db.callCenterLead.update({ where: { id: leadId }, data: { timeZone: zone } })
  await auditOutbound({ organizationId: user.organizationId, leadId }, user, {
    action: 'telephony.timezone_set',
    summary: `Time zone set to ${zone}`,
    after: { before: before?.timeZone ?? null, zone, note: String(input.note ?? '').slice(0, 200) },
  })
  return { ok: true }
}

export async function getCallingRules(): Promise<CallingRulesVM | Fail> {
  const user = await requireUser()
  const settings = await telephonySettingsFor(user.organizationId)
  return { recordOutbound: settings.recordOutbound, windowStart: settings.callWindow.start, windowEnd: settings.callWindow.end }
}

export async function saveCallingRules(rules: CallingRulesVM): Promise<NumberActionResult> {
  const user = await requireUser()
  if (!can(user, 'telephony:manage')) return NO_PERMISSION
  const start = Number(rules?.windowStart)
  const end = Number(rules?.windowEnd)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 8 || end > 21 || start >= end) {
    return fail('The calling window must sit between 8:00 am and 9:00 pm.', 'BAD_WINDOW')
  }
  const window = clampWindow({ start, end })
  const recordOutbound = rules?.recordOutbound === true
  if (recordOutbound) {
    const detailed = await telephonyCredentialsDetailed(user.organizationId)
    const state = detailed.creds ? await getAccountState(detailed.creds.accountSid) : null
    if (state?.mediaAuthState === 'off') {
      return fail('Recordings are public at Twilio. Turn on HTTP auth for media.', 'MEDIA_AUTH_OFF')
    }
  }
  const before = await telephonySettingsFor(user.organizationId)
  await saveTelephonySettings(user.organizationId, { recordOutbound, callWindow: window })
  await recordAudit(user, {
    action: 'telephony.calling_rules_saved',
    entityType: 'Organization',
    entityId: user.organizationId,
    summary: `Calling rules saved (${window.start}:00–${window.end}:00${recordOutbound ? ', outbound recording on' : ''})`,
    before: { recordOutbound: before.recordOutbound, callWindow: before.callWindow },
    after: { recordOutbound, callWindow: window },
  })
  return { ok: true }
}
