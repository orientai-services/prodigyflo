'use server'

import { requireUser } from '@/lib/rbac'
import {
  recordCallCenterAttemptFor,
  recordCallCenterNoteFor,
  recordCallCenterOutcomeFor,
  recordCallCenterTextFor,
  revealCallCenterContactFor,
  sendCallCenterIntakeFor,
  skipCallCenterLeadFor,
  takeCallCenterLeadFor,
} from './desk'
import type { CallCenterContact, DeskOutcome, DeskResult } from './desk-types'

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

export async function saveCallCenterOutcome(leadId: string, outcome: DeskOutcome): Promise<DeskResult> {
  const user = await actor()
  return recordCallCenterOutcomeFor(user.organizationId, user, leadId, outcome)
}

export async function saveCallCenterNote(leadId: string, text: string): Promise<DeskResult> {
  const user = await actor()
  return recordCallCenterNoteFor(user.organizationId, user, leadId, text)
}

export async function sendCallCenterIntakeLink(leadId: string): Promise<DeskResult> {
  const user = await actor()
  return sendCallCenterIntakeFor(user.organizationId, user, leadId)
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
