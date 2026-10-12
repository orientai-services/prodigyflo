/**
 * Where the call bar shows (docs/MOBILE.md §1).
 *
 * The bar appears while a call is connecting, ringing or in progress, so a rep
 * can hang up, mute or use the keypad from any page. It also stays while the
 * call that just ended left an error the rep hasn't dismissed, because a rep
 * who looked away must still learn why the call dropped. On the Call Center
 * desk the phone pill in the header holds the idle state and the phone
 * settings, so the bar folds away there too when idle; it still shows any
 * error from a dial placed on the desk. The incoming-call banner is separate
 * and always app-wide.
 */

export const DESK_PATH = '/call-center'

export function onCallDesk(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return pathname === DESK_PATH || pathname.startsWith(`${DESK_PATH}/`)
}

export function dockVisible({
  pathname,
  status,
  callError = false,
  error = false,
}: {
  pathname: string | null | undefined
  status: 'idle' | 'connecting' | 'ringing' | 'in-call'
  /** The last call ended with an error that is still on screen. */
  callError?: boolean
  /** Any dial error still on screen (a dial that never became a call, too). */
  error?: boolean
}): boolean {
  if (status !== 'idle' || callError) return true
  return onCallDesk(pathname) && error
}
