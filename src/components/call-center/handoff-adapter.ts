'use server'

/**
 * The dialer's door to the CYS bridge server actions (docs/CYS_BRIDGE.md §B1,
 * §B3). The screen imports only from here, so swapping a stub for the real
 * action is a one-line change in this file and nothing on the screen moves.
 *
 * TEMP: every function below is a stub until its lane lands.
 *   - scsIntakeLink, possibleMatchFor, linkLeadToClient → lane PF-A (link)
 *   - startSunoffHandoff, refreshSunoffHandoff, sunoffHandoffState,
 *     provisionSunoffUser → lane PF-B (handoff), src/lib/call-center/sunoff-actions.ts
 * Replace each body with `return <real action>(...)` (or re-export it) and
 * delete its TEMP line.
 */

import type { HandoffStatus, IntakeMode } from '@/lib/call-center/model'

export type ScsIntakeResult = { ok: true; url?: string; sent?: boolean } | { ok: false; reason: string }

export type PossibleMatch = { clientId: string; firstName: string; createdAt: string }
export type PossibleMatchResult = { ok: true; match: PossibleMatch | null; canLink: boolean } | { ok: false; reason: string }

export type LinkResult = { ok: true } | { ok: false; reason: string }

export type HandoffCode = 'NO_CLIENT' | 'NO_SUNOFF_USER' | 'SUNOFF_DOWN' | 'NOT_ALLOWED'
export type HandoffResult =
  | { ok: true; url: string; status: 'STANDBY' | 'STARTED' | 'SUBMITTED'; created: boolean }
  | { ok: false; reason: string; code?: HandoffCode }

export type HandoffState = { status: HandoffStatus; lastSentAt: string | null; stale: boolean; lastError: string | null }

export type ProvisionResult = { ok: true; email: string } | { ok: false; reason: string }

const NOT_CONNECTED = 'Not connected yet'

/** TEMP (PF-A): build the signed SCS /begin URL; 'text' sends it, 'copy' and 'open' return it. */
export async function scsIntakeLink(leadId: string, mode: IntakeMode): Promise<ScsIntakeResult> {
  void leadId; void mode
  return { ok: false, reason: NOT_CONNECTED }
}

/** TEMP (PF-A): one Client in the org with this lead's phone hash, created in the last 30 days. */
export async function possibleMatchFor(leadId: string): Promise<PossibleMatchResult> {
  void leadId
  return { ok: false, reason: NOT_CONNECTED }
}

/** TEMP (PF-A): link the lead to that Client (clients:reassign or SUPER_ADMIN; audited). */
export async function linkLeadToClient(leadId: string, clientId: string): Promise<LinkResult> {
  void leadId; void clientId
  return { ok: false, reason: NOT_CONNECTED }
}

/** TEMP (PF-B): send the profile to SunOff (standby) and return a one-time SSO url. */
export async function startSunoffHandoff(leadId: string): Promise<HandoffResult> {
  void leadId
  return { ok: false, reason: NOT_CONNECTED }
}

/** TEMP (PF-B): re-send a newer revision of the profile. */
export async function refreshSunoffHandoff(leadId: string): Promise<HandoffResult> {
  void leadId
  return { ok: false, reason: NOT_CONNECTED }
}

/** TEMP (PF-B): the SunoffHandoff row for this lead, or null before the first send. */
export async function sunoffHandoffState(leadId: string): Promise<HandoffState | null> {
  void leadId
  return null
}

/** TEMP (PF-B): create the signed-in user's SunOff account and email them a set-password link. */
export async function provisionSunoffUser(): Promise<ProvisionResult> {
  return { ok: false, reason: NOT_CONNECTED }
}
