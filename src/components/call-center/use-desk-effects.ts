'use client'

import { useEffect, useRef, useState } from 'react'
import { deskKeyAction, isTypingTarget, type DeskKeyAction } from '@/lib/call-center/shortcuts'

/** The desk's own clock: starts at the server's render time, then ticks. */
export function useDeskClock(startMs: number, everyMs = 15_000): number {
  const [now, setNow] = useState(startMs)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const first = window.setTimeout(tick, 0)
    const timer = window.setInterval(tick, everyMs)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [everyMs])
  return now
}

/**
 * Desk shortcuts on the document. Never while the rep is typing, and never
 * with Ctrl/Cmd/Alt (browser shortcuts stay theirs). The handler returns true
 * when it used the key, so only those keys lose their default.
 */
export function useDeskKeys(handle: (action: DeskKeyAction) => boolean): void {
  const ref = useRef(handle)
  useEffect(() => {
    ref.current = handle
  }, [handle])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return
      const action = deskKeyAction(event)
      if (!action) return
      if (action.kind !== 'close' && isTypingTarget(document.activeElement as HTMLElement | null)) return
      // A focused button already answers Space; leave it alone.
      if (action.kind === 'pause' && (document.activeElement as HTMLElement | null)?.tagName === 'BUTTON') return
      if (ref.current(action)) event.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * Live-ish refresh: re-read the desk from the server every 20 s while the tab
 * is visible, no call is up and nothing is being typed. `quiet` is checked at
 * each tick, so a call starting mid-interval simply skips that tick. With
 * `changed`, a tick asks it first and re-reads only when it says so.
 */
export function useLiveRefresh(refresh: () => void, quiet: () => boolean, everyMs = 20_000, changed?: () => Promise<boolean>): void {
  const refreshRef = useRef(refresh)
  const quietRef = useRef(quiet)
  const changedRef = useRef(changed)
  const checking = useRef(false)
  useEffect(() => {
    refreshRef.current = refresh
    quietRef.current = quiet
    changedRef.current = changed
  }, [refresh, quiet, changed])
  useEffect(() => {
    const ready = () =>
      document.visibilityState === 'visible' && !isTypingTarget(document.activeElement as HTMLElement | null) && quietRef.current()
    const timer = window.setInterval(() => {
      if (!ready()) return
      const check = changedRef.current
      if (!check) {
        refreshRef.current()
        return
      }
      // A change check first (use-desk-version.ts): re-read only when the desk moved. The same gates apply
      // again when it answers, in case a call or typing started meanwhile.
      if (checking.current) return
      checking.current = true
      check()
        .then((yes) => {
          if (yes && ready()) refreshRef.current()
        })
        .catch(() => {
          if (ready()) refreshRef.current()
        })
        .finally(() => {
          checking.current = false
        })
    }, everyMs)
    return () => window.clearInterval(timer)
  }, [everyMs])
}
