/**
 * Where the call bar shows (docs/MOBILE.md §1).
 *
 * The dialer lives in Call Center. On every other page the bar appears only
 * while a call is connecting, ringing or in progress, so a rep who navigated
 * away can still hang up, mute or use the keypad. It also stays while the
 * call that just ended left an error the rep hasn't dismissed, because a rep
 * who looked away must still learn why the call dropped. The incoming-call
 * banner is separate and always app-wide.
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
}: {
  pathname: string | null | undefined
  status: 'idle' | 'connecting' | 'ringing' | 'in-call'
  /** The last call ended with an error that is still on screen. */
  callError?: boolean
}): boolean {
  if (onCallDesk(pathname)) return true
  return status !== 'idle' || callError
}
