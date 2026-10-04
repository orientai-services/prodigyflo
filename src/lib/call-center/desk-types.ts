import type { CallLead, LeadOutcome } from './model'

export type DeskResult =
  | { ok: true; lead: CallLead }
  | { ok: false; error: string }

export type CallCenterContact = {
  phone: string | null
  email: string | null
}

export type DeskActor = {
  id: string
  name: string
}

export type DeskOutcome = LeadOutcome
