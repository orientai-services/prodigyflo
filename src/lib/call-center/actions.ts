'use server'

import { requireUser } from '@/lib/rbac'
import {
  recordCallCenterAttemptFor,
  recordCallCenterNoteFor,
  recordCallCenterOutcomeFor,
  recordCallCenterTextFor,
  revealCallCenterContactFor,
  scsIntakeLinkFor,
  scsIntakeTextStatusFor,
  sendCallCenterIntakeFor,
  skipCallCenterLeadFor,
  takeCallCenterLeadFor,
  type IntakeLinkMode,
  type IntakeLinkResult,
} from './desk'
import type { CallCenterContact, DeskOutcome, DeskResult } from './desk-types'
import { findPossibleMatch, linkLeadToClientFor, type LinkLeadResult, type PossibleMatch } from './possible-match'

async function actor() {
  const user = await requireUser()
  return { organizationId: user.organizationId, id: user.id, name: user.name }
}

export async function takeCallCenterLead(leadId: string): Promise<DeskResult> {
  const user = await actor()
  return takeCallCenterLeadFor(user.organizationId, user, leadId)
}

export async function skipCallCenterLead(leadId: string): Promise<DeskResult> {
  const user = await actor()
  return skipCallCenterLeadFor(user.organizationId, user, leadId)
}

/** `callbackAt` (ISO) only with 'callback'; the server checks it is ahead and within 60 days. */
export async function saveCallCenterOutcome(leadId: string, outcome: DeskOutcome, callbackAt?: string | null): Promise<DeskResult> {
  const user = await actor()
  return recordCallCenterOutcomeFor(user.organizationId, user, leadId, outcome, new Date(), { callbackAt: callbackAt ?? null })
}

export async function saveCallCenterNote(leadId: string, text: string): Promise<DeskResult> {
  const user = await actor()
  return recordCallCenterNoteFor(user.organizationId, user, leadId, text)
}

export async function sendCallCenterIntakeLink(leadId: string): Promise<DeskResult> {
  const user = await actor()
  return sendCallCenterIntakeFor(user.organizationId, user, leadId)
}

/** SCS Intake button (docs/CYS_BRIDGE.md §B1): open with the client, text, or copy the signed link. */
export async function scsIntakeLink(leadId: string, mode: IntakeLinkMode): Promise<IntakeLinkResult> {
  const user = await requireUser()
  return scsIntakeLinkFor(user, leadId, mode)
}

/** Whether "Text link" is offered for this lead right now, with the reason when it isn't. */
export async function scsIntakeTextStatus(leadId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const user = await requireUser()
  return scsIntakeTextStatusFor(user, leadId)
}

/** The one recent Client with this lead's phone, for the "Possible match" card; null when none or several. */
export async function possibleMatchFor(leadId: string): Promise<PossibleMatch | null> {
  const user = await requireUser()
  return findPossibleMatch(user, leadId)
}

/** Link the lead to a Client by hand (clients:reassign or Super Admin). Never replaces an existing link. */
export async function linkLeadToClient(leadId: string, clientId: string): Promise<LinkLeadResult> {
  const user = await requireUser()
  return linkLeadToClientFor(user, leadId, clientId)
}

export async function recordCallCenterAttempt(leadId: string): Promise<DeskResult> {
  const user = await actor()
  return recordCallCenterAttemptFor(user.organizationId, user, leadId)
}

export async function recordCallCenterText(leadId: string): Promise<DeskResult> {
  const user = await actor()
  return recordCallCenterTextFor(user.organizationId, user, leadId)
}

export async function revealCallCenterContact(leadId: string): Promise<CallCenterContact> {
  const user = await actor()
  return revealCallCenterContactFor(user.organizationId, user.id, leadId)
}
