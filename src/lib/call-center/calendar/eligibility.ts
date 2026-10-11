/** Leads the calendar must never book: out of state, do-not-call, opted out. */
export type EligibilityLead = {
  outOfArea: boolean
  doNotCallAt: Date | null
  consentRevokedAt: Date | null
  /** True when the number is on the org's suppression list (call or SMS block). */
  suppressed?: boolean
}

export function bookingSkipReason(lead: EligibilityLead): string | null {
  if (lead.outOfArea) return 'out_of_state'
  if (lead.doNotCallAt) return 'dnc'
  if (lead.suppressed) return 'dnc'
  if (lead.consentRevokedAt) return 'opted_out'
  return null
}
