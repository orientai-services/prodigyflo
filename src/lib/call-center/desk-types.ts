import type { CallLead, LeadOutcome } from './model'

export type DeskResult =
  | { ok: true; lead: CallLead }
  | { ok: false; error: string }

export type CallCenterContact = {
  phone: string | null
  email: string | null
}

export type DeskActor = {
  /** From requireUser(), never from a request body. */
  role?: string
  id: string
  name: string
}

export type DeskOutcome = LeadOutcome
