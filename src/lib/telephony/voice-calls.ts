import 'server-only'
import { Prisma, type CallOutcome, type VoiceCall } from '@prisma/client'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { can, clientScope, type SessionUser } from '@/lib/rbac'
import { inquiryAttested, last4Of, phoneHashOrNull } from './compliance-core'
import { toE164 } from './provider'
import { MISSED_DISPOSITIONS, type MissedCallVM, type MissedDisposition } from './voice-contract'

/**
 * The VoiceCall ledger — one row per ROOT carrier call, inbound or outbound.
 *
 * Twilio retries webhooks and delivers callbacks in any order, so every write
 * here is idempotent on the CallSid and only ever moves FORWARD: a status never
 * goes back from completed to ringing, and an outcome that came from the dial
 * result or the voicemail is never overwritten by the parent leg's own
 * "completed" (audit 5a: a completed parent used to read as CONNECTED).
 *
 * The ledger also carries what the concurrency rule needs. While the account
 * is limited to one outbound leg (error 10004), activeLegs() counts every row
 * that holds one — every OUTBOUND call, and INBOUND calls whose stage is
 * ringing a browser, a forward, a teammate or is bridged — under a Postgres
 * advisory lock per account, so two reps dialling at once can't both pass.
 */

export type Db = typeof db | Prisma.TransactionClient

export const ACTIVE_STATUSES = ['initiated', 'ringing', 'in-progress'] as const
export const TERMINAL_STATUSES = ['completed', 'busy', 'no-answer', 'failed', 'canceled', 'unknown'] as const
/** Inbound stages that hold an outbound leg on the account. */
export const LEG_STAGES = ['browser', 'forward', 'team', 'bridged'] as const
/** Rows older than this never count as active, whatever their status says. */
export const ACTIVE_WINDOW_MS = 4 * 60 * 60_000
/** A CONNECTED call this long (talk time) counts as a first contact. */
export const FIRST_CONTACT_SECONDS = 20

export const RECORDING_SID = /^RE[0-9a-f]{32}$/

const RANK: Record<string, number> = {
  queued: 0,
  initiated: 0,
  ringing: 1,
  'in-progress': 2,
  answered: 2,
  completed: 3,
  busy: 3,
  'no-answer': 3,
  failed: 3,
  canceled: 3,
  unknown: 3,
}

export function isTerminal(status: string | null | undefined): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status ?? '')
}

/** Forward-only status: a terminal status sticks; otherwise only a higher rank wins. */
export function nextStatus(current: string, incoming: string | null | undefined): string {
  const next = (incoming ?? '').toLowerCase()
  if (!(next in RANK)) return current
  if (isTerminal(current)) return current
  const normalized = next === 'answered' ? 'in-progress' : next === 'queued' ? 'initiated' : next
  return RANK[normalized] > (RANK[current] ?? -1) ? normalized : current
}

/** The internal playback path stored on Call.recordingRef — never Twilio's URL. */
export function recordingPath(voiceCallId: string): string {
  return `/api/voice/recordings/${voiceCallId}`
}

// ── The per-account lock and the leg count ─────────────────────────────────

/** Postgres transaction-scoped advisory lock, one per Twilio account. */
export async function lockAccount(tx: Prisma.TransactionClient, accountSid: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${accountSid}))::text AS locked`
}

export async function activeLegs(client: Db, accountSid: string, now = new Date(), excludeCallSid?: string): Promise<number> {
  return client.voiceCall.count({
    where: {
      accountSid,
      startedAt: { gte: new Date(now.getTime() - ACTIVE_WINDOW_MS) },
      status: { in: [...ACTIVE_STATUSES] },
      OR: [{ direction: 'OUTBOUND' }, { direction: 'INBOUND', stage: { in: [...LEG_STAGES] } }],
      ...(excludeCallSid ? { NOT: { callSid: excludeCallSid } } : {}),
    },
  })
}

/** Run `fn` inside one transaction holding the account's advisory lock. */
export async function withAccountLock<T>(accountSid: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await lockAccount(tx, accountSid)
    return fn(tx)
  })
}

export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002')
}

// ── Starting rows ──────────────────────────────────────────────────────────

export type RemoteParty = {
  remoteHash: string | null
  remoteLast4: string | null
  remoteSecret: Prisma.InputJsonValue | undefined
}

/** Hash + last four + an encrypted copy (so an unknown caller can be called back). */
export function remoteParty(phone: string | null | undefined): RemoteParty {
  const e164 = phone ? toE164(phone) : null
  let secret: Prisma.InputJsonValue | undefined
  if (e164 && process.env.VAULT_KEY) {
    try {
      secret = encryptSecret(e164) as unknown as Prisma.InputJsonValue
    } catch {
      secret = undefined
    }
  }
  return { remoteHash: e164 ? phoneHashOrNull(e164) : null, remoteLast4: last4Of(e164 ?? phone), remoteSecret: secret }
}

export type InboundStart = {
  organizationId: string
  accountSid: string
  callSid: string
  phoneNumberId: string
  lineE164: string
  from: string
  stage: string
  recordingExpected: boolean
  /** Twilio's StirVerstat for the caller ID, when it sent one. */
  stirVerstat?: string | null
}

/** Idempotent on CallSid: a retry returns the row the first delivery wrote. */
export async function startInboundCall(input: InboundStart, client: Db = db): Promise<{ row: VoiceCall; created: boolean }> {
  const existing = await client.voiceCall.findUnique({ where: { callSid: input.callSid } })
  if (existing) {
    // The voice-limited path writes the row first; keep the attestation it lacked.
    if (input.stirVerstat && !existing.stirVerstat) {
      const row = await client.voiceCall.update({ where: { id: existing.id }, data: { stirVerstat: input.stirVerstat.slice(0, 64) } })
      return { row, created: false }
    }
    return { row: existing, created: false }
  }
  try {
    const row = await client.voiceCall.create({
      data: {
        organizationId: input.organizationId,
        callSid: input.callSid,
        accountSid: input.accountSid,
        direction: 'INBOUND',
        stage: input.stage,
        phoneNumberId: input.phoneNumberId,
        lineE164: input.lineE164,
        recordingExpected: input.recordingExpected || null,
        status: 'ringing',
        stirVerstat: input.stirVerstat?.slice(0, 64) || null,
        ...remoteParty(input.from),
      },
    })
    return { row, created: true }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const raced = await db.voiceCall.findUnique({ where: { callSid: input.callSid } })
    if (!raced) throw err
    return { row: raced, created: false }
  }
}

export async function linkVoiceCall(
  callSid: string,
  link: { clientId?: string | null; communicationId?: string | null; callCenterLeadId?: string | null },
): Promise<void> {
  const data: Prisma.VoiceCallUpdateManyMutationInput = {}
  if (link.clientId) data.clientId = link.clientId
  if (link.communicationId) data.communicationId = link.communicationId
  if (link.callCenterLeadId) data.callCenterLeadId = link.callCenterLeadId
  if (Object.keys(data).length) await db.voiceCall.updateMany({ where: { callSid }, data })
}

export async function setStage(callSid: string, stage: string): Promise<void> {
  await db.voiceCall.updateMany({ where: { callSid, status: { notIn: [...TERMINAL_STATUSES] } }, data: { stage } })
}

// ── Callbacks ──────────────────────────────────────────────────────────────

export type StatusUpdate = {
  status?: string | null
  durationSeconds?: number | null
  errorCode?: string | null
  at?: Date
}

/**
 * The parent leg's own status. Sets endedAt and duration on a terminal status.
 * An inbound call that ended with no dial result and no voicemail means the
 * caller hung up while it rang: NO_ANSWER, and it waits in the missed list.
 */
export async function applyCallStatus(callSid: string, update: StatusUpdate): Promise<VoiceCall | null> {
  const row = await db.voiceCall.findUnique({ where: { callSid } })
  if (!row) return null
  const at = update.at ?? new Date()
  const status = nextStatus(row.status, update.status)
  const data: Prisma.VoiceCallUpdateInput = {}
  if (status !== row.status) data.status = status
  if (update.errorCode && !row.errorCode) data.errorCode = update.errorCode
  if (isTerminal(status) && !isTerminal(row.status)) {
    data.endedAt = row.endedAt ?? at
    if (typeof update.durationSeconds === 'number' && update.durationSeconds >= 0) data.durationSeconds = update.durationSeconds
    if (!row.outcome) {
      if (row.direction === 'INBOUND') {
        data.outcome = 'NO_ANSWER'
        data.stage = 'hung-up'
      } else {
        // The browser leg ending says nothing about the callee (5a, outbound
        // side): only an answered callee leg makes it CONNECTED.
        data.outcome = row.answeredAt ? 'CONNECTED' : status === 'completed' ? 'NO_ANSWER' : outcomeFromStatus(status)
      }
    }
  }
  if (Object.keys(data).length === 0) return row
  return db.voiceCall.update({ where: { id: row.id }, data })
}

function outcomeFromStatus(status: string): CallOutcome {
  switch (status) {
    case 'completed':
      return 'CONNECTED'
    case 'busy':
      return 'BUSY'
    case 'failed':
      return 'FAILED'
    case 'canceled':
      return 'DECLINED'
    default:
      return 'NO_ANSWER'
  }
}

/** Who picked up — a child leg's 'answered' event. */
export async function applyChildAnswered(
  callSid: string,
  input: { answeredBy: string; childCallSid?: string | null; at?: Date },
): Promise<void> {
  const row = await db.voiceCall.findUnique({ where: { callSid }, select: { id: true, answeredBy: true, answeredAt: true } })
  if (!row) return
  await db.voiceCall.update({
    where: { id: row.id },
    data: {
      answeredBy: row.answeredBy ?? input.answeredBy,
      answeredAt: row.answeredAt ?? input.at ?? new Date(),
      childCallSid: input.childCallSid ?? undefined,
      stage: 'bridged',
      ...(input.answeredBy.startsWith('browser:') ? { userId: input.answeredBy.slice('browser:'.length) } : {}),
    },
  })
}

export function dialAnswered(dialStatus: string | null | undefined): boolean {
  const s = (dialStatus ?? '').toLowerCase()
  return s === 'completed' || s === 'answered'
}

/**
 * The result of one <Dial> stage. Answered → CONNECTED with the talk time. Not
 * answered → the stage's outcome (NO_ANSWER / BUSY / FAILED), which a later
 * stage, the voicemail, or an answer may still replace. CONNECTED and
 * VOICEMAIL are final.
 */
export async function applyDialResult(
  callSid: string,
  input: { dialStatus: string | null | undefined; dialDuration?: number | null; answeredBy?: string | null; errorCode?: string | null; at?: Date },
): Promise<VoiceCall | null> {
  const row = await db.voiceCall.findUnique({ where: { callSid } })
  if (!row) return null
  const answered = dialAnswered(input.dialStatus)
  const data: Prisma.VoiceCallUpdateInput = {}
  if (row.outcome === 'CONNECTED' || row.outcome === 'VOICEMAIL') {
    // Final already — a replayed callback changes nothing.
  } else if (answered) {
    data.outcome = 'CONNECTED'
    data.stage = 'done'
    data.answeredAt = row.answeredAt ?? input.at ?? new Date()
    if (typeof input.dialDuration === 'number' && input.dialDuration >= 0) data.talkSeconds = input.dialDuration
    if (input.answeredBy && !row.answeredBy) {
      data.answeredBy = input.answeredBy
      if (input.answeredBy.startsWith('browser:')) data.userId = input.answeredBy.slice('browser:'.length)
    }
  } else {
    data.outcome = outcomeFromStatus((input.dialStatus ?? '').toLowerCase() || 'no-answer')
    if (data.outcome === 'CONNECTED' || data.outcome === 'DECLINED') data.outcome = 'NO_ANSWER'
  }
  if (input.errorCode && !row.errorCode) data.errorCode = input.errorCode
  if (Object.keys(data).length === 0) return row
  return db.voiceCall.update({ where: { id: row.id }, data })
}

export type RecordingInput = {
  recordingSid: string | null | undefined
  durationSeconds?: number | null
  kind: 'call' | 'voicemail'
}

/**
 * Store the RecordingSid only (validated). The media URL is never kept — the
 * playback route rebuilds it from the SID and the call's account. A voicemail
 * makes the call VOICEMAIL unless it was answered.
 */
export async function applyRecording(
  where: { callSid: string } | { id: string },
  input: RecordingInput,
): Promise<VoiceCall | null> {
  const row = await db.voiceCall.findUnique({ where })
  if (!row) return null
  const sid = input.recordingSid ?? ''
  if (!RECORDING_SID.test(sid)) return row
  const data: Prisma.VoiceCallUpdateInput = {}
  if (!row.recordingSid) {
    data.recordingSid = sid
    data.recordingKind = input.kind
  }
  if (typeof input.durationSeconds === 'number' && input.durationSeconds >= 0 && (row.recordingSid === sid || !row.recordingSid)) {
    data.recordingDurationSeconds = input.durationSeconds
  }
  if (input.kind === 'voicemail' && row.outcome !== 'CONNECTED') {
    data.outcome = 'VOICEMAIL'
    data.stage = 'voicemail'
    if (row.direction === 'INBOUND' && !row.handledAt) data.needsAction = true
  }
  if (Object.keys(data).length === 0) return row
  return db.voiceCall.update({ where: { id: row.id }, data })
}

// ── Press 1 for a callback, and voicemail transcripts ──────────────────────

/**
 * The caller pressed 1 instead of leaving a voicemail. The call waits on the
 * Missed list, sorted first. Idempotent: a replayed Gather changes nothing.
 * A call somebody already handled is not reopened.
 */
export async function requestCallback(callSid: string): Promise<VoiceCall | null> {
  const row = await db.voiceCall.findUnique({ where: { callSid } })
  if (!row || row.direction !== 'INBOUND') return row
  if (row.callbackRequested) return row
  return db.voiceCall.update({
    where: { id: row.id },
    data: {
      callbackRequested: true,
      stage: 'callback',
      ...(row.handledAt ? {} : { needsAction: true }),
      ...(row.outcome ? {} : { outcome: 'NO_ANSWER' as const }),
    },
  })
}

/** Longest transcript kept. Twilio only transcribes two-minute recordings, so this rarely bites. */
export const TRANSCRIPT_MAX_CHARS = 2000

/** Collapse whitespace and cut at a word boundary with an ellipsis. Pure. */
export function cleanTranscript(text: string | null | undefined, max = TRANSCRIPT_MAX_CHARS): string | null {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return null
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * Twilio's transcription of a voicemail. Written once: a replay, or a second
 * transcription of the same call, never replaces the first. A transcription of
 * a recording other than the call's voicemail is ignored, and so is one Twilio
 * marks failed (the voicemail itself is still there to play).
 */
export async function applyTranscript(
  callSid: string,
  input: { text: string | null | undefined; status: string | null | undefined; recordingSid?: string | null },
): Promise<{ stored: boolean; row: VoiceCall | null }> {
  const row = await db.voiceCall.findUnique({ where: { callSid } })
  if (!row) return { stored: false, row: null }
  if ((input.status ?? '').toLowerCase() !== 'completed') return { stored: false, row }
  const text = cleanTranscript(input.text)
  if (!text) return { stored: false, row }
  const sid = input.recordingSid ?? ''
  if (sid && (!RECORDING_SID.test(sid) || (row.recordingSid && row.recordingSid !== sid))) return { stored: false, row }
  // Conditional write: two deliveries racing on separate instances store one.
  const res = await db.voiceCall.updateMany({ where: { id: row.id, transcript: null }, data: { transcript: text } })
  return { stored: res.count === 1, row: res.count === 1 ? { ...row, transcript: text } : row }
}

// ── Finalize ───────────────────────────────────────────────────────────────

function clock(seconds: number | null | undefined): string {
  const s = Math.max(0, seconds ?? 0)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The lead-trail line for an inbound call, in plain words. */
export function inboundTrailCopy(
  vc: Pick<VoiceCall, 'outcome' | 'stage' | 'talkSeconds' | 'recordingDurationSeconds'> & { callbackRequested?: boolean },
): {
  label: string
  detail: string
} {
  if (vc.outcome === 'CONNECTED') return { label: 'Inbound call', detail: `Answered · ${clock(vc.talkSeconds)}` }
  if (vc.outcome === 'VOICEMAIL') return { label: 'Voicemail', detail: `Voicemail left · ${clock(vc.recordingDurationSeconds)}` }
  if (vc.callbackRequested) return { label: 'Missed call', detail: 'Asked for a callback (pressed 1)' }
  if (vc.stage === 'hung-up') return { label: 'Missed call', detail: 'Hung up while it rang' }
  if (vc.outcome === 'BUSY') return { label: 'Missed call', detail: 'Line was busy' }
  if (vc.outcome === 'FAILED') return { label: 'Missed call', detail: 'The call failed' }
  return { label: 'Missed call', detail: 'Nobody answered' }
}

/** A voicemail this long (seconds) or longer counts as the caller reaching us. */
export const INQUIRY_VOICEMAIL_SECONDS = 3

/**
 * Did this inbound call count as the caller contacting us, for the 90-day
 * 'inbound_inquiry' consent? Only when the carrier vouched for the caller ID
 * (STIR/SHAKEN A or B: a spoofed number can't open a number to marketing) AND
 * the caller actually reached someone or left a real voicemail — a hang-up
 * during the greeting is not an inquiry.
 */
export function inboundInquiryCounts(
  vc: Pick<VoiceCall, 'direction' | 'outcome' | 'stirVerstat' | 'recordingKind' | 'recordingDurationSeconds'>,
): boolean {
  if (vc.direction !== 'INBOUND' || !inquiryAttested(vc.stirVerstat)) return false
  if (vc.outcome === 'CONNECTED') return true
  return vc.outcome === 'VOICEMAIL' && vc.recordingKind === 'voicemail' && (vc.recordingDurationSeconds ?? 0) >= INQUIRY_VOICEMAIL_SECONDS
}

/**
 * The lead's ONE trail line for this call, kept true as later callbacks land
 * (a voicemail can arrive after the hang-up was written). The unique
 * (voiceCallId, type) key settles two finalizes racing on separate instances:
 * the loser re-reads the call and corrects the line instead of adding one.
 */
async function writeInboundTrail(vc: VoiceCall, now: Date): Promise<void> {
  const leadId = vc.callCenterLeadId!
  const marker = `"voiceCallId":"${vc.id}"`
  const bodyOf = (row: VoiceCall) => {
    const copy = inboundTrailCopy(row)
    return JSON.stringify({ label: copy.label, detail: copy.detail, voiceCallId: row.id })
  }
  const find = () =>
    db.callCenterEvent.findFirst({
      where: { leadId, type: 'CALL', OR: [{ voiceCallId: vc.id }, { body: { contains: marker } }] },
      select: { id: true, body: true },
    })
  let body = bodyOf(vc)
  let already = await find()
  if (!already) {
    try {
      await db.callCenterEvent.create({ data: { leadId, type: 'CALL', createdAt: vc.endedAt ?? now, body, voiceCallId: vc.id } })
      return
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      already = await find()
      const fresh = await db.voiceCall.findUnique({ where: { id: vc.id } })
      if (fresh) body = bodyOf(fresh)
    }
  }
  if (already && already.body !== body) {
    await db.callCenterEvent.update({ where: { id: already.id }, data: { body } })
  }
}

/**
 * Called once the root call is over (and safe to call again). Writes what the
 * rest of the CRM sees: the client's first contact, the Call row on the
 * timeline, the lead's trail and status, the missed-call flag, and — for a
 * verified caller who reached us — the lead's 'inbound_inquiry' consent.
 */
export async function finalizeCall(voiceCallId: string, now = new Date()): Promise<void> {
  const vc = await db.voiceCall.findUnique({ where: { id: voiceCallId } })
  if (!vc || !isTerminal(vc.status)) return

  const answered = vc.outcome === 'CONNECTED'
  if (vc.direction === 'INBOUND' && !answered && !vc.needsAction && !vc.handledAt) {
    await db.voiceCall.update({ where: { id: vc.id }, data: { needsAction: true } })
  }

  if (answered && (vc.talkSeconds ?? 0) >= FIRST_CONTACT_SECONDS && vc.clientId) {
    await db.client.updateMany({ where: { id: vc.clientId, firstContactAt: null }, data: { firstContactAt: vc.answeredAt ?? now } })
  }

  if (vc.communicationId) {
    await db.call.updateMany({
      where: { communicationId: vc.communicationId },
      data: {
        outcome: vc.outcome ?? 'NO_ANSWER',
        durationSeconds: vc.talkSeconds ?? vc.durationSeconds ?? 0,
        ...(vc.recordingSid
          ? {
              recordingRef: recordingPath(vc.id),
              recordingDurationSeconds: vc.recordingDurationSeconds,
              voicemailLeft: vc.recordingKind === 'voicemail',
            }
          : {}),
      },
    })
  }

  if (vc.direction === 'OUTBOUND') await clearMissedByCallback(vc, now)

  if (vc.callCenterLeadId && vc.direction === 'OUTBOUND') {
    // Lazy import: the desk module imports this one.
    const { recordCarrierCallFor } = await import('@/lib/call-center/desk')
    await recordCarrierCallFor(vc.organizationId, vc.callCenterLeadId, vc, now)
  }

  if (vc.callCenterLeadId && vc.direction === 'INBOUND') {
    await writeInboundTrail(vc, now)
    if (inboundInquiryCounts(vc)) {
      // Consent moves forward only from an earlier inquiry, or from nothing at
      // all; a form or staff consent is never replaced, and a STOP never undone.
      await db.callCenterLead.updateMany({
        where: {
          id: vc.callCenterLeadId,
          consentRevokedAt: null,
          OR: [
            { consentSource: null, consentAt: null },
            { consentSource: 'inbound_inquiry', consentAt: { lt: vc.startedAt } },
          ],
        },
        data: { consentAt: vc.startedAt, consentSource: 'inbound_inquiry' },
      })
    }
    if (!answered) {
      await db.callCenterLead.updateMany({
        where: { id: vc.callCenterLeadId, status: { in: ['INBOUND', 'WAITING'] } },
        data: { status: 'MISSED' },
      })
    }
  }
}

// ── Who may see a call ─────────────────────────────────────────────────────

type AccessRow = Pick<VoiceCall, 'organizationId' | 'userId' | 'answeredBy' | 'clientId' | 'callCenterLeadId'>

/**
 * telephony:manage holders: any call in their organization. Anyone else only
 * when they placed or answered it, the call's client is in their scope, or
 * they hold the call's lead. Everyone else gets a 404, not a 403, upstream.
 */
export async function canSeeCall(user: SessionUser, vc: AccessRow): Promise<boolean> {
  if (vc.organizationId !== user.organizationId) return false
  if (can(user, 'telephony:manage')) return true
  if (vc.userId === user.id || vc.answeredBy === `browser:${user.id}` || vc.answeredBy === `team:${user.id}`) return true
  if (vc.clientId) {
    const inScope = await db.client.count({ where: { AND: [clientScope(user), { id: vc.clientId }] } })
    if (inScope > 0) return true
  }
  if (vc.callCenterLeadId) {
    const held = await db.callCenterLead.count({
      where: { id: vc.callCenterLeadId, organizationId: user.organizationId, lockedBy: user.id },
    })
    if (held > 0) return true
  }
  return false
}

export const canPlayRecording = canSeeCall

/** The same rule as a Prisma filter, for lists. */
export function visibleCallsWhere(user: SessionUser, heldLeadIds: string[], scopedClientIds: string[]): Prisma.VoiceCallWhereInput {
  if (can(user, 'telephony:manage')) return { organizationId: user.organizationId }
  return {
    organizationId: user.organizationId,
    OR: [
      { userId: user.id },
      { answeredBy: { in: [`browser:${user.id}`, `team:${user.id}`] } },
      ...(scopedClientIds.length ? [{ clientId: { in: scopedClientIds } }] : []),
      ...(heldLeadIds.length ? [{ callCenterLeadId: { in: heldLeadIds } }] : []),
    ],
  }
}

// ── Missed calls ───────────────────────────────────────────────────────────

export function missedReason(vc: Pick<VoiceCall, 'outcome' | 'stage' | 'recordingKind'>): MissedCallVM['reason'] {
  if (vc.outcome === 'VOICEMAIL' || vc.recordingKind === 'voicemail') return 'voicemail'
  if (vc.outcome === 'BUSY') return 'busy'
  if (vc.outcome === 'FAILED') return 'failed'
  if (vc.stage === 'hung-up') return 'hung-up'
  return 'no-answer'
}

/**
 * Unanswered inbound calls still waiting for someone, in the viewer's scope.
 * Callback requests (the caller pressed 1) come first, then newest first.
 */
export async function listMissed(user: SessionUser, limit = 100): Promise<MissedCallVM[]> {
  const manage = can(user, 'telephony:manage')
  const [held, scoped] = manage
    ? [[], []]
    : await Promise.all([
        db.callCenterLead.findMany({ where: { organizationId: user.organizationId, lockedBy: user.id }, select: { id: true } }),
        db.client.findMany({ where: clientScope(user), select: { id: true }, take: 5000 }),
      ])
  const rows = await db.voiceCall.findMany({
    where: {
      AND: [
        visibleCallsWhere(user, held.map((r) => r.id), scoped.map((r) => r.id)),
        { direction: 'INBOUND', needsAction: true, handledAt: null },
      ],
    },
    orderBy: [{ callbackRequested: 'desc' }, { startedAt: 'desc' }],
    take: limit,
  })
  if (rows.length === 0) return []

  const lineIds = [...new Set(rows.map((r) => r.phoneNumberId).filter((v): v is string => Boolean(v)))]
  const clientIds = [...new Set(rows.map((r) => r.clientId).filter((v): v is string => Boolean(v)))]
  const [lines, clients] = await Promise.all([
    db.phoneNumber.findMany({ where: { id: { in: lineIds } }, select: { id: true, friendlyName: true } }),
    db.client.findMany({
      where: { AND: [clientScope(user), { id: { in: clientIds } }] },
      select: { id: true, firstName: true, lastName: true },
    }),
  ])
  const lineName = new Map(lines.map((l) => [l.id, l.friendlyName]))
  const clientName = new Map(clients.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]))

  return rows.map((vc) => {
    const visibleClient = vc.clientId && clientName.has(vc.clientId) ? vc.clientId : null
    const isVoicemail = Boolean(vc.recordingSid && vc.recordingKind === 'voicemail')
    return {
      id: vc.id,
      at: vc.startedAt.toISOString(),
      lineLabel: (vc.phoneNumberId && lineName.get(vc.phoneNumberId)) || 'Phone line',
      caller: visibleClient ? clientName.get(visibleClient)! : vc.remoteLast4 ? `•••-•••-${vc.remoteLast4}` : 'Unknown caller',
      target: visibleClient ? { kind: 'client', id: visibleClient } : vc.remoteSecret ? { kind: 'missed', id: vc.id } : null,
      reason: missedReason(vc),
      voicemail: isVoicemail ? { src: recordingPath(vc.id), seconds: vc.recordingDurationSeconds ?? 0 } : null,
      callbackRequested: vc.callbackRequested,
      transcript: isVoicemail ? vc.transcript : null,
    }
  })
}

/**
 * How many missed calls wait for this viewer: the nav badge. One count query
 * for telephony:manage holders (the whole org); everyone else is counted by
 * the same visibility rule as the list. Never throws: a badge is not worth an
 * error page, so a failure (or an unmigrated column) reads as zero.
 */
export async function pendingMissedCount(user: SessionUser): Promise<number> {
  try {
    const pending: Prisma.VoiceCallWhereInput = { direction: 'INBOUND', needsAction: true, handledAt: null }
    if (can(user, 'telephony:manage')) {
      return await db.voiceCall.count({ where: { organizationId: user.organizationId, ...pending } })
    }
    const [held, scoped] = await Promise.all([
      db.callCenterLead.findMany({ where: { organizationId: user.organizationId, lockedBy: user.id }, select: { id: true } }),
      db.client.findMany({ where: clientScope(user), select: { id: true }, take: 5000 }),
    ])
    return await db.voiceCall.count({
      where: { AND: [visibleCallsWhere(user, held.map((r) => r.id), scoped.map((r) => r.id)), pending] },
    })
  } catch {
    return 0
  }
}

export function isMissedDisposition(value: unknown): value is MissedDisposition {
  return typeof value === 'string' && (MISSED_DISPOSITIONS as readonly string[]).includes(value)
}

type HandledData = {
  handledAt: Date
  handledById: string | null
  handledNote: string | null
  handledDisposition: MissedDisposition
}

/**
 * Close every pending missed call from this caller (same remoteHash, same
 * org) that started at or before `upTo`. One callback, or one "spam", answers
 * all of that caller's earlier rings; a call that comes in AFTER stays open,
 * because it is a new reason to call. Returns how many rows it closed.
 */
async function clearPendingFromCaller(
  organizationId: string,
  remoteHash: string,
  upTo: Date,
  data: HandledData,
  exceptId?: string,
): Promise<number> {
  const res = await db.voiceCall.updateMany({
    where: {
      organizationId,
      remoteHash,
      direction: 'INBOUND',
      needsAction: true,
      handledAt: null,
      startedAt: { lte: upTo },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    data: { ...data, needsAction: false },
  })
  return res.count
}

/**
 * An outbound call to a caller who is waiting on the Missed list, answered and
 * talked for 20 s or more (FIRST_CONTACT_SECONDS = CONNECTED_SECONDS), IS the
 * callback: their earlier missed calls close as 'called_back'. A shorter or
 * unanswered call handles nothing. Idempotent: a second finalize finds
 * nothing pending.
 */
export async function clearMissedByCallback(
  vc: Pick<VoiceCall, 'direction' | 'outcome' | 'talkSeconds' | 'remoteHash' | 'organizationId' | 'userId' | 'startedAt'>,
  now = new Date(),
): Promise<number> {
  if (vc.direction !== 'OUTBOUND' || vc.outcome !== 'CONNECTED' || !vc.remoteHash) return 0
  if ((vc.talkSeconds ?? 0) < FIRST_CONTACT_SECONDS) return 0
  return clearPendingFromCaller(vc.organizationId, vc.remoteHash, vc.startedAt, {
    handledAt: now,
    handledById: vc.userId ?? null,
    handledNote: 'called back',
    handledDisposition: 'called_back',
  })
}

export type HandleInput = { disposition?: MissedDisposition | null; note?: string | null }

/**
 * Close one missed call with a disposition (default 'handled'), and with it
 * every earlier pending missed call from the same number in the org. A plain
 * string is still accepted as the note (the older call shape).
 */
export async function markHandled(
  user: SessionUser,
  voiceCallId: string,
  input: HandleInput | string | null | undefined,
  now = new Date(),
): Promise<{ ok: true; cleared: number } | { ok: false; error: string }> {
  const opts: HandleInput = typeof input === 'string' || input == null ? { note: input ?? null } : input
  if (opts.disposition != null && !isMissedDisposition(opts.disposition)) {
    return { ok: false, error: 'Pick how the call was handled.' }
  }
  const disposition: MissedDisposition = opts.disposition ?? 'handled'
  const vc = await db.voiceCall.findUnique({ where: { id: voiceCallId } })
  if (!vc || !(await canSeeCall(user, vc))) return { ok: false, error: 'That call is not on your list.' }
  if (vc.handledAt) return { ok: true, cleared: 0 }
  const data: HandledData = {
    handledAt: now,
    handledById: user.id,
    handledNote: typeof opts.note === 'string' ? opts.note.trim().slice(0, 500) || null : null,
    handledDisposition: disposition,
  }
  // Conditional: two people pressing at once close it once.
  const res = await db.voiceCall.updateMany({ where: { id: vc.id, handledAt: null }, data: { ...data, needsAction: false } })
  if (res.count === 0) return { ok: true, cleared: 0 }
  const cleared = vc.remoteHash ? await clearPendingFromCaller(vc.organizationId, vc.remoteHash, vc.startedAt, data, vc.id) : 0
  return { ok: true, cleared }
}
