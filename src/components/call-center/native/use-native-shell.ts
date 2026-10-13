'use client'

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  edgeSwipeGoesBack,
  edgeSwipeIsHorizontal,
  edgeSwipeStarts,
  pullDistance,
  pullTriggers,
} from '@/lib/call-center/native-gestures'

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Each section keeps its own scroll position, like a native tab bar: leaving
 * a section remembers where it was, coming back puts it there again.
 * `remember()` is called just before a tab navigates.
 */
export function useSectionScroll(section: string): { remember: () => void } {
  const positions = useRef(new Map<string, number>())
  const current = useRef(section)
  /** Set by a tab-bar tap; any other link (a Today tile, More) opens its section at the top as usual. */
  const fromTab = useRef(false)
  useLayoutEffect(() => {
    if (current.current === section) return
    current.current = section
    if (!fromTab.current) return
    fromTab.current = false
    window.scrollTo({ top: positions.current.get(section) ?? 0, behavior: 'instant' as ScrollBehavior })
  }, [section])
  return {
    remember: () => {
      positions.current.set(current.current, window.scrollY)
      fromTab.current = true
    },
  }
}

/**
 * Pull down at the top of the page to refresh (iOS has none in a home-screen
 * app). Touch only; the indicator is drawn by the caller from `pull`.
 * `refresh` returns a promise that settles when the new data is on screen.
 */
export function usePullToRefresh(enabled: boolean, refresh: () => Promise<void> | void): { pull: number; busy: boolean } {
  const [pull, setPull] = useState(0)
  const [busy, setBusy] = useState(false)
  const live = useRef({ refresh, busy })
  useEffect(() => {
    live.current = { refresh, busy }
  })

  useEffect(() => {
    if (!enabled) return
    let startY = 0
    let startX = 0
    let armed = false
    let dy = 0
    const onStart = (event: TouchEvent) => {
      armed = false
      if (live.current.busy || event.touches.length !== 1 || window.scrollY > 0) return
      if (!window.matchMedia('(max-width: 1023.98px), (pointer: coarse)').matches) return
      const target = event.target as HTMLElement | null
      // Not from inside a sheet, an open lead or anything with its own scroll.
      if (target?.closest('[role="dialog"], dialog, .detail.open, .pad, input, textarea, select, .filters, .cc-tabs')) return
      startY = event.touches[0].clientY
      startX = event.touches[0].clientX
      dy = 0
      armed = true
    }
    const onMove = (event: TouchEvent) => {
      if (!armed) return
      const touch = event.touches[0]
      dy = touch.clientY - startY
      if (window.scrollY > 0 || dy <= 0 || Math.abs(touch.clientX - startX) > Math.abs(dy)) {
        if (dy <= 0 || window.scrollY > 0) {
          armed = false
          setPull(0)
        }
        return
      }
      setPull(pullDistance(dy))
    }
    const onEnd = () => {
      if (!armed) return
      armed = false
      if (!pullTriggers(dy)) {
        setPull(0)
        return
      }
      setBusy(true)
      setPull(56)
      Promise.resolve(live.current.refresh())
        .catch(() => {})
        .finally(() => {
          setBusy(false)
          setPull(0)
        })
    }
    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onEnd)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [enabled])

  return { pull, busy }
}

/**
 * Swipe from the left edge to go back from a pushed full-screen view (the
 * lead on a phone), the way iOS does in an app; a home-screen web app gets no
 * such gesture from Safari. The view follows the finger and slides out.
 */
export function useEdgeSwipeBack(ref: RefObject<HTMLElement | null>, active: boolean, onBack: () => void): void {
  const back = useRef(onBack)
  useEffect(() => {
    back.current = onBack
  })
  useEffect(() => {
    const el = ref.current
    if (!el || !active) return
    let startX = 0
    let startY = 0
    let lastX = 0
    let lastT = 0
    let velocity = 0
    let armed = false
    let owning = false
    const set = (dx: number, animate: boolean) => {
      el.style.transition = animate && !reducedMotion() ? 'transform .24s cubic-bezier(.2,.8,.2,1)' : 'none'
      el.style.transform = dx > 0 ? `translateX(${dx}px)` : ''
      el.style.boxShadow = dx > 0 ? '-8px 0 24px rgba(18, 32, 44, .18)' : ''
    }
    const onStart = (event: TouchEvent) => {
      armed = false
      owning = false
      if (event.touches.length !== 1 || window.getComputedStyle(el).position !== 'fixed') return
      const touch = event.touches[0]
      if (!edgeSwipeStarts(touch.clientX)) return
      startX = lastX = touch.clientX
      startY = touch.clientY
      lastT = event.timeStamp
      velocity = 0
      armed = true
    }
    const onMove = (event: TouchEvent) => {
      if (!armed) return
      const touch = event.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (!owning) {
        if (!edgeSwipeIsHorizontal(dx, dy)) {
          if (Math.abs(dy) > 10) armed = false
          return
        }
        owning = true
      }
      event.preventDefault()
      velocity = (touch.clientX - lastX) / Math.max(1, event.timeStamp - lastT)
      lastX = touch.clientX
      lastT = event.timeStamp
      set(Math.max(0, dx), false)
    }
    const onEnd = () => {
      if (!armed) return
      armed = false
      if (!owning) return
      owning = false
      const dx = lastX - startX
      if (edgeSwipeGoesBack(dx, velocity, el.offsetWidth)) {
        if (reducedMotion()) {
          set(0, false)
          back.current()
          return
        }
        set(el.offsetWidth, true)
        window.setTimeout(() => {
          back.current()
          set(0, false)
        }, 220)
      } else {
        set(0, true)
      }
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      set(0, false)
    }
  }, [ref, active])
}
