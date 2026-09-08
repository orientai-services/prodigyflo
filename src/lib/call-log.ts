import 'server-only'
import type { CallOutcome, CommunicationDirection, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit, redactForAudit } from '@/lib/audit'
import { can, findClientInScope, ForbiddenError, type SessionUser } from '@/lib/rbac'
import { maskPhone } from '@/lib/messaging/send'
import { adherencePct, parseAdherence, type AdherenceEntry } from '@/lib/adherence'
import { humanize } from '@/lib/format'

/**
 * Call logging — Phase 1 discipline: EVERY call gets logged, with the 5-step
 * funnel checklist recorded at log time (Phase 2 process-adherence tracking).
 *
 * A logged call is a human record of a human conversation. It writes the same
 * Communication shape the outbound messaging path does (see messaging/send.ts)
 * so the client timeline, comms tab, and scoreboard all pick it up unchanged.
 */

export type LogCallInput = {
  clientId: string
  direction: CommunicationDirection
  outcome: CallOutcome
  /** Whole or fractional minutes; stored as seconds on the Call row. */
  durationMinutes: number
  summary: string
  /** 5-step funnel checklist. Empty = no checklist recorded (excluded from averages). */
  adherence: AdherenceEntry[]
  voicemailLeft: boolean
}

export type LogCallResult = {
  ok: true
  communicationId: string
  /** null when no checklist was recorded. */
  adherencePct: number | null
}

/**
 * Scoreboard abuse guard. Full-funnel adherence is the only call-based points
 * line (see scoreboard.ts POINTS_RECIPE), and it counts calls whose stored
 * checklist scores 100% — so a call is made non-scoring simply by not storing
 * its checklist. The call itself is still recorded in full.
 *
 * Two blocks:
 *  - a CONNECTED call with zero duration is not a conversation; it earns no
 *    adherence credit.
 *  - beyond MAX_SCORING_CALLS_PER_CLIENT_PER_DAY same-day calls to the same
 *    client, further calls stop earning credit (no minting points by
 *    re-logging the same client all day).
 */
export const MAX_SCORING_CALLS_PER_CLIENT_PER_DAY = 3

export type CallScoringBlock = 'zero_duration_connected' | 'daily_cap' | null

export function callScoringBlock(input: {
  outcome: CallOutcome
  durationSeconds: number
  /** CALL comms this closer already logged for this client today (server-local day). */
  sameDayCallCount: number
}): CallScoringBlock {
  if (input.outcome === 'CONNECTED' && input.durationSeconds <= 0) return 'zero_duration_connected'
  if (input.sameDayCallCount >= MAX_SCORING_CALLS_PER_CLIENT_PER_DAY) return 'daily_cap'
  return null
}

export async function logCall(user: SessionUser, input: LogCallInput): Promise<LogCallResult> {
  if (!can(user, 'communications:send')) {
    throw new ForbiddenError('You do not have permission to log calls.')
  }

  const client = await findClientInScope(user, input.clientId)
  if (!client) throw new ForbiddenError('This client is not in your scope.')

  const summary = input.summary.trim()
  if (!summary) throw new ForbiddenError('Write a short summary of the call.')
  if (!Number.isFinite(input.durationMinutes) || input.durationMinutes < 0) {
    throw new ForbiddenError('Enter a valid call duration.')
  }

  const durationSeconds = Math.round(input.durationMinutes * 60)

  // Scoreboard abuse guard (see callScoringBlock): count today's CALL comms by
  // this closer for this client BEFORE inserting, so the cap is on prior calls.
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const sameDayCallCount = await db.communication.count({
    where: { clientId: client.id, userId: user.id, channel: 'CALL', occurredAt: { gte: startOfDay } },
  })
  const scoringBlock = callScoringBlock({ outcome: input.outcome, durationSeconds, sameDayCallCount })

  // Re-parse whatever the caller sent — only canonical steps are ever stored.
  // A non-scoring call stores an empty checklist: that is exactly how the
  // scoreboard excludes a call from adherence averages and full-funnel points.
  const adherence = scoringBlock === null ? parseAdherence(input.adherence) : []
  const pct = adherencePct(adherence)
  const clientMasked = client.phone ? maskPhone(client.phone) : null
  const outbound = input.direction === 'OUTBOUND'

  const communication = await db.communication.create({
    data: {
      clientId: client.id,
      userId: user.id,
      channel: 'CALL',
      direction: input.direction,
      // Mirrors the seeded/provider convention: outbound activity is SENT,
      // inbound is RECEIVED. The timeline renders this badge via humanize().
      status: outbound ? 'SENT' : 'RECEIVED',
      body: summary,
      occurredAt: new Date(),
      call: {
        create: {
          toMasked: outbound ? clientMasked : null,
          fromMasked: outbound ? null : clientMasked,
          durationSeconds,
          outcome: input.outcome,
          voicemailLeft: input.voicemailLeft,
          adherence: adherence as unknown as Prisma.InputJsonValue,
        },
      },
    },
  })

  await db.client.update({ where: { id: client.id }, data: { lastActivityAt: new Date() } })

  await recordAudit(user, {
    action: 'call.logged',
    entityType: 'Communication',
    entityId: communication.id,
    summary: `Logged ${outbound ? 'outbound' : 'inbound'} call (${humanize(input.outcome).toLowerCase()}${
      pct === null ? '' : `, ${pct}% funnel adherence`
    })`,
    after: redactForAudit({
      clientId: client.id,
      direction: input.direction,
      outcome: input.outcome,
      durationSeconds,
      voicemailLeft: input.voicemailLeft,
      adherence,
      adherencePct: pct,
      scoringBlock,
    }),
  })

  return { ok: true, communicationId: communication.id, adherencePct: pct }
}

export type CallLogContext = {
  /** True when the client's LATEST Closer Brief has been viewed — pre-checks step 1. */
  briefViewed: boolean
}

/** What the Log-call dialog needs to open honestly. Scope-checked. */
export async function getCallLogContext(user: SessionUser, clientId: string): Promise<CallLogContext> {
  const client = await findClientInScope(user, clientId)
  if (!client) throw new ForbiddenError('This client is not in your scope.')

  const latest = await db.closerBrief.findFirst({
    where: { organizationId: user.organizationId, clientId: client.id },
    orderBy: { generatedAt: 'desc' },
    select: { viewedAt: true },
  })
  return { briefViewed: latest?.viewedAt != null }
}
