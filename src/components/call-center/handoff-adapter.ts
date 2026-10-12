'use server'

/**
 * The dialer's door to the CYS bridge server actions (docs/CYS_BRIDGE.md §B1,
 * §B3). The screen imports only from here, so swapping a stub for the real
 * action is a one-line change in this file and nothing on the screen moves.
 *
 * Each function forwards to its lane's real server action:
 *   - scsIntakeLink, scsIntakeTextStatus, possibleMatchFor, linkLeadToClient → '@/lib/call-center/actions'
 *   - startSunoffHandoff, refreshSunoffHandoff, sunoffHandoffState,
 *     provisionSunoffUser → '@/lib/call-center/sunoff-actions'
 */

import type { HandoffStatus, IntakeMode } from '@/lib/call-center/model'
import * as desk from '@/lib/call-center/actions'
import * as bridge from '@/lib/call-center/sunoff-actions'

export type ScsIntakeResult = { ok: true; url?: string; sent?: boolean } | { ok: false; reason: string }

export type PossibleMatch = { clientId: string; firstName: string; createdAt: string }
export type PossibleMatchResult = { ok: true; match: PossibleMatch | null; canLink: boolean } | { ok: false; reason: string }

export type LinkResult = { ok: true } | { ok: false; reason: string }

export type HandoffCode = 'NO_CLIENT' | 'NO_SUNOFF_USER' | 'SUNOFF_DOWN' | 'NOT_ALLOWED'
export type HandoffResult =
  | { ok: true; url: string; status: 'STANDBY' | 'STARTED' | 'SUBMITTED'; created: boolean }
  | { ok: false; reason: string; code?: HandoffCode }

export type HandoffState = { status: HandoffStatus; lastSentAt: string | null; stale: boolean; lastError: string | null }

/** PF-B returns more (created, sunoffUserId, code); `message` is ready to show. */
export type ProvisionResult = { ok: true; email: string; message?: string } | { ok: false; reason: string }

/** Build the signed SCS /begin URL; 'text' sends it, 'copy' and 'open' return it. */
export async function scsIntakeLink(leadId: string, mode: IntakeMode): Promise<ScsIntakeResult> {
  return desk.scsIntakeLink(leadId, mode)
}

/** May this lead be texted the link now? The reason shows on "Text link" before the rep tries. */
export async function scsIntakeTextStatus(leadId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  return desk.scsIntakeTextStatus(leadId)
}

/** One Client in the org with this lead's phone hash, created in the last 30 days. */
export async function possibleMatchFor(leadId: string): Promise<PossibleMatchResult> {
  const r = await desk.possibleMatchFor(leadId)
  if (!r.ok) return r
  return {
    ok: true,
    canLink: r.canLink,
    match: r.match ? { clientId: r.match.clientId, firstName: r.match.firstName, createdAt: String(r.match.createdAt) } : null,
  }
}

/** Link the lead to that Client (clients:reassign or SUPER_ADMIN; audited). */
export async function linkLeadToClient(leadId: string, clientId: string): Promise<LinkResult> {
  return desk.linkLeadToClient(leadId, clientId)
}

/** Send the profile to SunOff (standby) and return a one-time SSO url. */
export async function startSunoffHandoff(leadId: string): Promise<HandoffResult> {
  return bridge.startSunoffHandoff(leadId)
}

/** Re-send the current revision of the profile. */
export async function refreshSunoffHandoff(leadId: string): Promise<HandoffResult> {
  return bridge.refreshSunoffHandoff(leadId)
}

/** The SunoffHandoff row for this lead, or null before the first send. */
export async function sunoffHandoffState(leadId: string): Promise<HandoffState | null> {
  const r = await bridge.sunoffHandoffState(leadId)
  return r ? { status: r.status, lastSentAt: r.lastSentAt, stale: r.stale, lastError: r.lastError ?? null } : null
}

/** Create or link the signed-in user's SunOff account (decision D2). */
export async function provisionSunoffUser(): Promise<ProvisionResult> {
  const r = await bridge.provisionSunoffUser()
  return r.ok ? { ok: true, email: r.email, message: r.message } : { ok: false, reason: r.reason }
}
