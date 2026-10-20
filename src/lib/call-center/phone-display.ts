/**
 * How a lead's phone number reads in the dialer (docs/DIALER_APP.md §Phone
 * numbers). Pure: safe for client components and unit tests.
 *
 * The server scopes the record to the authenticated user, then supplies the
 * full number as a `LeadPhoneView`. Calling permissions are separate.
 */

/** What the viewer gets for one lead. Absent = no full number was loaded. */
export type LeadPhoneView =
  /** `display` "(702) 555-0123" or "+57 3001234567"; `copy` the E.164 for the clipboard. */
  | { state: 'shown'; display: string; copy: string }
  /** Allowed, but the stored number can't be read (no secret, or it won't decrypt). */
  | { state: 'unavailable' }

export const NUMBER_UNAVAILABLE = 'Number unavailable'

/** The viewer fields the rule reads. */
export type PhoneViewer = { id: string; role: string }
/** The lead fields the rule reads. */
export type PhoneLeadGate = { lockedBy: string | null; doNotCallAt: Date | string | null }

/**
 * Every authenticated user sees full numbers on records they can access.
 * Call/text authorization is checked separately when an action is requested.
 */
export function maySeeLeadPhone(viewer: PhoneViewer, _lead: PhoneLeadGate): boolean {
  // Callers have already scoped the record to the authenticated viewer's workspace.
  // Display is independent of who may call/text it; those write gates remain in place.
  void _lead
  return Boolean(viewer.id)
}

/**
 * A stored number in E.164, or null. The secret holds what `dialablePhone`
 * kept: "+17025550123", "17025550123", "7025550123", or another country's
 * "+<digits>".
 */
export function phoneE164(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null
  if (trimmed.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
}

/** "+17025550123" → "(702) 555-0123"; any other country stays "+<digits>". */
export function formatLeadPhone(raw: string | null | undefined): { display: string; copy: string } | null {
  const e164 = phoneE164(raw)
  if (!e164) return null
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return { display: us ? `(${us[1]}) ${us[2]}-${us[3]}` : e164, copy: e164 }
}

/**
 * The view for an allowed viewer. `plain` is the decrypted secret (null when
 * missing or unreadable); `hasNumber` is whether the lead ever had one (a
 * secret or a stored last four). No number at all → null, so the row shows "—".
 */
export function leadPhoneView(plain: string | null, hasNumber: boolean): LeadPhoneView | null {
  const shown = formatLeadPhone(plain)
  if (shown) return { state: 'shown', ...shown }
  return hasNumber ? { state: 'unavailable' } : null
}

/** The masked form everyone without the permission keeps. */
export function maskedLast4(last4: string | null | undefined): string {
  return last4 && /^\d{4}$/.test(last4) ? `•••-•••-${last4}` : '—'
}

/** One line of text for places that can't render the copy button (titles, aria). */
export function phoneText(view: LeadPhoneView | null | undefined, last4: string | null | undefined): string {
  if (view?.state === 'shown') return view.display
  if (view?.state === 'unavailable') return NUMBER_UNAVAILABLE
  return maskedLast4(last4)
}
