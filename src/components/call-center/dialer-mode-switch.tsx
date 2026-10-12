'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Dialer mode = the Call Center on its own, without the desk's side menu.
 * The switch lives in the desk rail (off) and in the Call Center header
 * (on). Flipping it is a navigation: on opens /call-center, off returns to
 * the Board. Nothing is stored; the page you are on is the mode.
 */
export function DialerModeSwitch({ on, className }: { on: boolean; className?: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <label className={`dialer-switch${on ? ' on' : ''}${className ? ` ${className}` : ''}`}>
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={pending}
        aria-checked={on}
        onChange={() => start(() => router.push(on ? '/board' : '/call-center'))}
      />
      <span className="dialer-track" aria-hidden="true">
        <span className="dialer-knob" />
      </span>
      <span className="dialer-label">Dialer mode</span>
    </label>
  )
}
