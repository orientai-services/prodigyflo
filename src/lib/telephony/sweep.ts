import 'server-only'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { getTelephonyProvider, isMockTelephony, platformCredentials, telephonyCredentialsDetailed } from './index'
import { fetchA2pStatus, refreshAccountState } from './account-status'
import { webhookDriftOf } from './number-sync'
import { expirePresence } from './presence'
import type { TelephonyCredentials } from './provider'
import { readTelephonySettings, saveTelephonySettings } from './settings'
import { applySmsStatus } from './sms-status'
import { runSpeedToLead, type SpeedSummary } from './speed-to-lead'
import {
  buildCallRecordingsRequest,
  buildFetchCallRequest,
  buildFetchMessageRequest,
  parseCallRecordings,
  parseCallStatus,
  parseMessageStatus,
} from './twilio'
import { ACTIVE_STATUSES, applyCallStatus, applyRecording, finalizeCall, isTerminal } from './voice-calls'

/**
 * runTelephonySweep(now) — the telephony housekeeping that rides the 5-minute
 * job runner (/api/jobs/run), BEFORE its PRODIGYFLO_FINAL_DESK early return, so
 * it runs in every mode. It reconciles what a lost or dropped callback (or a
 * maintenance window, which answers Twilio 503) left behind:
 *
 *  1 account state: balance + profile hourly, media auth daily, per-org A2P
 *  2 texts still "Accepted by carrier" after 10 minutes → Twilio's real status
 *  3 calls still "active" after 15 minutes → Twilio's real status; after 4 h
 *    with no answer from Twilio → 'unknown' (no outcome is guessed), then
 *    finalized like any ended call, so a lost inbound call still reaches the
 *    missed-call list and its lead's trail
 *  4 recordings that were expected but never arrived → their SIDs
 *  5 webhook drift, once a day per number (report only, never repoints)
 *  6 presence rows older than 10 minutes are deleted
 *  7 speed-to-lead: untouched new form leads alert at 5 and 15 minutes of
 *    calling-hours clock (speed-to-lead.ts), each alert once
 *
 * Every Twilio fetch has a 5-second timeout and the whole sweep a 20-second
 * budget, checked before each step and item. It never throws.
 */

export const SWEEP_BUDGET_MS = 20_000
const FETCH_TIMEOUT_MS = 5000
const SMS_STALE_MS = 10 * 60_000
const SMS_LOOKBACK_MS = 3 * 86_400_000
const SMS_PER_RUN = 25
const CALL_STALE_MS = 15 * 60_000
const CALL_GIVE_UP_MS = 4 * 60 * 60_000
const CALLS_PER_RUN = 20
const RECORDING_GRACE_MS = 5 * 60_000
const RECORDINGS_PER_RUN = 10
const DRIFT_EVERY_MS = 86_400_000
const A2P_EVERY_MS = 60 * 60_000

export type SweepSummary = {
  mode: 'mock' | 'twilio'
  accounts: number
  a2p: number
  sms: { checked: number; delivered: number; failed: number }
  calls: { checked: number; resolved: number; unknown: number }
  recordings: { checked: number; recovered: number }
  drift: { checked: number; drifting: number }
  presenceExpired: number
  speed: SpeedSummary
  budgetExhausted: boolean
  errors: string[]
}

type Fetcher = typeof fetch

async function getJson(fetcher: Fetcher, req: { url: string; init: RequestInit }): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetcher(req.url, { ...req.init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    return { status: res.status, body: await res.json().catch(() => null) }
  } catch {
    return null
  }
}

/** Credentials for an org that are for THIS account (or the platform's, when it is the platform account). */
async function credsFor(organizationId: string, accountSid?: string | null): Promise<TelephonyCredentials | null> {
  const detailed = await telephonyCredentialsDetailed(organizationId)
  if (detailed.creds && (!accountSid || detailed.creds.accountSid === accountSid)) return detailed.creds
  const platform = platformCredentials()
  return platform && (!accountSid || platform.accountSid === accountSid) ? platform : null
}

export type SweepOptions = {
  /** Injected fetch for Twilio REST reads (tests). */
  fetcher?: Fetcher
  budgetMs?: number
  /** Restrict the sweep to one organization (used by tests; production runs unfiltered). */
  organizationId?: string
}

export async function runTelephonySweep(now = new Date(), opts: SweepOptions = {}): Promise<SweepSummary> {
  const started = Date.now()
  const scope = opts.organizationId ? { organizationId: opts.organizationId } : {}
  const budget = opts.budgetMs ?? SWEEP_BUDGET_MS
  const fetcher = opts.fetcher ?? fetch
  const mock = (() => {
    try {
      return isMockTelephony()
    } catch {
      return true
    }
  })()
  const summary: SweepSummary = {
    mode: mock ? 'mock' : 'twilio',
    accounts: 0,
    a2p: 0,
    sms: { checked: 0, delivered: 0, failed: 0 },
    calls: { checked: 0, resolved: 0, unknown: 0 },
    recordings: { checked: 0, recovered: 0 },
    drift: { checked: 0, drifting: 0 },
    presenceExpired: 0,
    speed: { checked: 0, alerted: 0, escalated: 0, notified: 0 },
    budgetExhausted: false,
    errors: [],
  }
  const left = () => {
    if (Date.now() - started >= budget) {
      summary.budgetExhausted = true
      return false
    }
    return true
  }
  const step = async (name: string, fn: () => Promise<void>) => {
    if (!left()) return
    try {
      await fn()
    } catch (err) {
      summary.errors.push(`${name}: ${err instanceof Error ? err.message.slice(0, 200) : 'failed'}`)
    }
  }

  // 1 — account state and per-org A2P.
  await step('account', async () => {
    if (mock) return
    const platform = platformCredentials()
    if (platform && left()) {
      await refreshAccountState(platform, now)
      summary.accounts += 1
    }
    const orgs = await db.organization.findMany({
      where: { deletedAt: null, ...(opts.organizationId ? { id: opts.organizationId } : {}), settings: { path: ['telephony', 'messagingServiceSid'], string_starts_with: 'MG' } },
      select: { id: true, settings: true },
      take: 50,
    })
    for (const org of orgs) {
      if (!left()) return
      const settings = readTelephonySettings(org.settings)
      if (!settings.messagingServiceSid) continue
      const checked = settings.a2p?.checkedAt ? Date.parse(settings.a2p.checkedAt) : 0
      if (settings.a2p?.source === 'manual' || now.getTime() - checked < A2P_EVERY_MS) continue
      const creds = await credsFor(org.id)
      if (!creds) continue
      const status = await fetchA2pStatus(settings.messagingServiceSid, creds)
      if (status) {
        await saveTelephonySettings(org.id, { a2p: { status, source: 'twilio', checkedAt: now.toISOString() } })
        summary.a2p += 1
      }
    }
  })

  // 2 — texts still SENT with no terminal callback. Least recently checked
  // first: a text Twilio keeps calling 'sent' (no delivery receipt from the
  // carrier), or one Twilio won't return, goes to the back of the queue
  // instead of crowding out newer texts every run.
  await step('sms', async () => {
    if (mock) return
    const stale = await db.communication.findMany({
      where: {
        ...(opts.organizationId ? { client: { organizationId: opts.organizationId } } : {}),
        channel: 'SMS',
        direction: 'OUTBOUND',
        status: 'SENT',
        externalRef: { not: null },
        occurredAt: { lte: new Date(now.getTime() - SMS_STALE_MS), gte: new Date(now.getTime() - SMS_LOOKBACK_MS) },
        message: {
          OR: [{ providerStatusAt: null }, { providerStatusAt: { lte: new Date(now.getTime() - SMS_STALE_MS) } }],
        },
      },
      orderBy: [{ message: { providerStatusAt: { sort: 'asc', nulls: 'first' } } }, { occurredAt: 'asc' }],
      take: SMS_PER_RUN,
      select: { id: true, externalRef: true, client: { select: { organizationId: true } }, message: { select: { id: true } } },
    })
    // Stamped when nothing came back, so the row waits SMS_STALE_MS like a checked one.
    const touch = async (messageId: string | undefined) => {
      if (messageId) await db.message.update({ where: { id: messageId }, data: { providerStatusAt: now } })
    }
    for (const comm of stale) {
      if (!left()) return
      const creds = await credsFor(comm.client.organizationId)
      if (!creds || !comm.externalRef) {
        await touch(comm.message?.id)
        continue
      }
      summary.sms.checked += 1
      const res = await getJson(fetcher, buildFetchMessageRequest(comm.externalRef, creds))
      const parsed = res && res.status < 300 ? parseMessageStatus(res.body) : null
      if (!parsed) {
        await touch(comm.message?.id)
        continue
      }
      const out = await applySmsStatus(comm.id, { status: parsed.status, errorCode: parsed.errorCode, at: now })
      if (out === 'delivered') summary.sms.delivered += 1
      if (out === 'failed') summary.sms.failed += 1
    }
  })

  // 3 — calls the ledger still thinks are live.
  await step('calls', async () => {
    const stuck = await db.voiceCall.findMany({
      where: { ...scope, status: { in: [...ACTIVE_STATUSES] }, startedAt: { lte: new Date(now.getTime() - CALL_STALE_MS) } },
      orderBy: { startedAt: 'asc' },
      take: CALLS_PER_RUN,
      select: { id: true, callSid: true, organizationId: true, accountSid: true, startedAt: true },
    })
    for (const vc of stuck) {
      if (!left()) return
      summary.calls.checked += 1
      let resolved = false
      if (!mock) {
        const creds = await credsFor(vc.organizationId, vc.accountSid)
        const res = creds ? await getJson(fetcher, buildFetchCallRequest(vc.callSid, creds)) : null
        const parsed = res && res.status < 300 ? parseCallStatus(res.body) : null
        if (parsed) {
          const row = await applyCallStatus(vc.callSid, { status: parsed.status, durationSeconds: parsed.durationSeconds, at: parsed.endedAt ?? now })
          if (row && isTerminal(row.status)) {
            await finalizeCall(row.id, now)
            summary.calls.resolved += 1
            resolved = true
          }
        }
      }
      if (!resolved && now.getTime() - vc.startedAt.getTime() >= CALL_GIVE_UP_MS) {
        // Twilio never told us: say "unknown", never guess an outcome. Then
        // finalize: an unanswered inbound call is still somebody to call back.
        await db.voiceCall.update({ where: { id: vc.id }, data: { status: 'unknown', endedAt: now } })
        await finalizeCall(vc.id, now)
        summary.calls.unknown += 1
      }
    }
  })

  // 4 — recordings that should exist but whose callback never came.
  await step('recordings', async () => {
    if (mock) return
    const lost = await db.voiceCall.findMany({
      where: {
        ...scope,
        recordingExpected: true,
        recordingSid: null,
        endedAt: { lte: new Date(now.getTime() - RECORDING_GRACE_MS), gte: new Date(now.getTime() - 86_400_000) },
      },
      orderBy: { endedAt: 'asc' },
      take: RECORDINGS_PER_RUN,
      select: { id: true, callSid: true, organizationId: true, accountSid: true, outcome: true, stage: true },
    })
    for (const vc of lost) {
      if (!left()) return
      const creds = await credsFor(vc.organizationId, vc.accountSid)
      if (!creds) continue
      summary.recordings.checked += 1
      const res = await getJson(fetcher, buildCallRecordingsRequest(vc.callSid, creds))
      const found = res && res.status < 300 ? parseCallRecordings(res.body)[0] : undefined
      if (!found) continue
      const kind = vc.outcome === 'VOICEMAIL' || vc.stage === 'voicemail' ? 'voicemail' : 'call'
      const row = await applyRecording({ id: vc.id }, { recordingSid: found.sid, durationSeconds: found.durationSeconds, kind })
      if (row?.recordingSid) {
        await finalizeCall(row.id, now)
        summary.recordings.recovered += 1
      }
    }
  })

  // 5 — daily webhook drift report (never repoints).
  await step('drift', async () => {
    if (mock) return
    const due = await db.phoneNumber.findMany({
      where: {
        ...scope,
        status: 'ACTIVE',
        provider: 'twilio',
        providerSid: { not: null },
        OR: [{ webhookCheckedAt: null }, { webhookCheckedAt: { lte: new Date(now.getTime() - DRIFT_EVERY_MS) } }],
      },
      select: { id: true, organizationId: true, providerSid: true, providerAccountSid: true },
      take: 200,
    })
    const byAccount = new Map<string, { creds: TelephonyCredentials; rows: typeof due }>()
    for (const row of due) {
      const creds = await credsFor(row.organizationId, row.providerAccountSid)
      if (!creds) continue
      const entry = byAccount.get(creds.accountSid) ?? { creds, rows: [] }
      entry.rows.push(row)
      byAccount.set(creds.accountSid, entry)
    }
    for (const { creds, rows } of byAccount.values()) {
      if (!left()) return
      const listed = await getTelephonyProvider().listOwnedNumbers(creds)
      if (!listed.ok) continue
      const bySid = new Map(listed.numbers.map((n) => [n.sid, n]))
      for (const row of rows) {
        const n = row.providerSid ? bySid.get(row.providerSid) : undefined
        if (!n) continue
        const drift = webhookDriftOf(n)
        summary.drift.checked += 1
        if (drift) summary.drift.drifting += 1
        await db.phoneNumber.update({
          where: { id: row.id },
          data: { webhookCheckedAt: now, webhookDrift: drift ? (drift as Prisma.InputJsonValue) : Prisma.DbNull },
        })
      }
    }
  })

  // 6 — presence older than ten minutes.
  await step('presence', async () => {
    summary.presenceExpired = await expirePresence(now)
  })

  // 7 — speed-to-lead alerts (no carrier calls; runs in mock mode too).
  await step('speed', async () => {
    summary.speed = await runSpeedToLead(now, { organizationId: opts.organizationId, left })
  })

  return summary
}

