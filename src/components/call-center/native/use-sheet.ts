'use client'

import { useEffect, useRef, type RefObject } from 'react'
import { sheetOffset, sheetShouldClose } from '@/lib/call-center/native-gestures'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The sheet is laid out as a bottom sheet right now (CSS decides per width), not a desk popover. */
export function isBottomSheet(el: HTMLElement | null): boolean {
  if (!el || typeof window === 'undefined') return false
  const style = window.getComputedStyle(el)
  if (style.position !== 'fixed') return false
  const box = el.getBoundingClientRect()
  return box.width >= window.innerWidth - 2 && box.bottom >= window.innerHeight - 2 - keyboardPx()
}

/** The keyboard's height while it is up (InstalledAppRuntime publishes it). */
function keyboardPx(): number {
  const root = document.documentElement
  if (!root.classList.contains('kb-open')) return 0
  return Number.parseFloat(root.style.getPropertyValue('--kb')) || 0
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** One lock for every open sheet: the page behind them does not scroll. */
let locks = 0
let saved = ''
function lockPage() {
  if (locks++ === 0) {
    saved = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
  }
}
function unlockPage() {
  if (--locks <= 0) {
    locks = 0
    document.documentElement.style.overflow = saved
  }
}

function scrollerAbove(target: Element | null, root: HTMLElement): HTMLElement | null {
  for (let el = target as HTMLElement | null; el && el !== root.parentElement; el = el.parentElement) {
    const { overflowY } = window.getComputedStyle(el)
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el
    if (el === root) break
  }
  return null
}

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return Boolean(el.closest('input, textarea, select, [contenteditable="true"], input[type="range"]'))
}

/**
 * Native bottom-sheet behaviour for an existing sheet element (docs/NATIVE_FEEL.md):
 * drag it down by the grab handle, header or any content scrolled to its top to
 * close it; the page behind cannot scroll; Tab stays inside; focus returns to
 * what opened it; a focused field scrolls above the keyboard. Only while CSS
 * lays the element out as a bottom sheet: a desk popover is left alone.
 */
export function useSheet(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { lock?: boolean } = {},
  /** The control that opened the sheet, for Safari, which never focuses a tapped button. */
  openerRef?: RefObject<HTMLElement | null>,
): void {
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  const lock = options.lock ?? true

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const focused = document.activeElement as HTMLElement | null
    const opener = focused && focused !== document.body ? focused : (openerRef?.current ?? null)
    const bottom = isBottomSheet(el)
    if (bottom && lock) lockPage()
    const backdrop = el.previousElementSibling instanceof HTMLElement && /backdrop/.test(el.previousElementSibling.className)
      ? el.previousElementSibling
      : null

    let startY = 0
    let startX = 0
    let lastY = 0
    let lastT = 0
    let velocity = 0
    let dragging = false
    let armed = false

    const set = (dy: number, animate: boolean) => {
      el.style.transition = animate && !reducedMotion() ? 'transform .22s cubic-bezier(.2,.8,.2,1)' : 'none'
      el.style.transform = dy ? `translateY(${dy}px)` : ''
      if (backdrop) {
        backdrop.style.transition = el.style.transition.replace('transform', 'opacity')
        backdrop.style.opacity = dy > 0 ? String(Math.max(0.2, 1 - dy / Math.max(1, el.offsetHeight))) : ''
      }
    }

    const onStart = (event: TouchEvent) => {
      armed = false
      dragging = false
      if (event.touches.length !== 1 || !isBottomSheet(el)) return
      if (typing(event.target)) return
      const scroller = scrollerAbove(event.target as Element, el)
      if (scroller && scroller.scrollTop > 0) return
      // A horizontal strip (filters, emoji rows) keeps its own swipe.
      const touch = event.touches[0]
      startY = lastY = touch.clientY
      startX = touch.clientX
      lastT = event.timeStamp
      velocity = 0
      armed = true
    }

    const onMove = (event: TouchEvent) => {
      if (!armed) return
      const touch = event.touches[0]
      const dy = touch.clientY - startY
      const dx = touch.clientX - startX
      if (!dragging) {
        if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          armed = false
          return
        }
        dragging = true
      }
      event.preventDefault()
      const dt = Math.max(1, event.timeStamp - lastT)
      velocity = (touch.clientY - lastY) / dt
      lastY = touch.clientY
      lastT = event.timeStamp
      set(sheetOffset(dy), false)
    }

    const onEnd = () => {
      if (!armed) return
      armed = false
      if (!dragging) return
      dragging = false
      const dy = lastY - startY
      if (sheetShouldClose(dy, velocity, el.offsetHeight)) {
        if (reducedMotion()) {
          close.current()
          return
        }
        set(el.offsetHeight + 40, true)
        window.setTimeout(() => close.current(), 200)
      } else {
        set(0, true)
      }
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !isBottomSheet(el)) return
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => node.offsetParent !== null || node === document.activeElement)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !el.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !el.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }

    // A field focused in a sheet stays above the keyboard once it has opened.
    const onFocus = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null
      if (!target || !typing(target) || !isBottomSheet(el)) return
      window.setTimeout(() => target.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }), 320)
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    el.addEventListener('focusin', onFocus)
    document.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      el.removeEventListener('focusin', onFocus)
      document.removeEventListener('keydown', onKey)
      if (bottom && lock) unlockPage()
      // Back to whatever opened the sheet, when focus would otherwise fall to the page.
      const active = document.activeElement
      if (opener && opener.isConnected && (!active || active === document.body || !active.isConnected || el.contains(active))) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [ref, lock, openerRef])
}
