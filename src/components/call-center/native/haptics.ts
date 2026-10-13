'use client'

/**
 * A short tap of the phone's vibration on key moments (a call starts or ends,
 * a result is saved). Android has `navigator.vibrate`; iOS has no vibration
 * API, but Safari 18+ plays the system "tick" when a switch checkbox flips
 * through its label, so on iOS we flip a hidden one. Anything else, or a
 * person who asked for reduced motion, gets nothing: haptics never throw and
 * never block.
 */
export type HapticKind = 'tap' | 'success' | 'warning' | 'call'

const PATTERN: Record<HapticKind, number | number[]> = {
  tap: 8,
  success: [10, 40, 14],
  warning: [18, 60, 18],
  call: 22,
}

let label: HTMLLabelElement | null = null

function iosTick(times: number) {
  if (!label) {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('switch', '')
    input.id = 'cc-haptic'
    input.tabIndex = -1
    input.setAttribute('aria-hidden', 'true')
    label = document.createElement('label')
    label.htmlFor = 'cc-haptic'
    label.setAttribute('aria-hidden', 'true')
    label.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
    label.appendChild(input)
    document.body.appendChild(label)
  }
  const tick = label
  for (let i = 0; i < times; i++) window.setTimeout(() => tick.click(), i * 70)
}

export function haptic(kind: HapticKind = 'tap'): void {
  try {
    if (typeof window === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(PATTERN[kind])
      return
    }
    // Touch screens only (no user-agent sniffing): elsewhere the flip is silent anyway.
    if (window.matchMedia('(pointer: coarse)').matches) {
      iosTick(kind === 'success' || kind === 'warning' ? 2 : 1)
    }
  } catch {
    // Haptics are a nicety.
  }
}
