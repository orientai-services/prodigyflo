'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/** Even with nothing changed, the page is re-read at least this often (what the fingerprint does not cover). */
export const FULL_REFRESH_MS = 120_000

export type VersionCheck = {
  /** Resolves true when the page should be re-read now. */
  changed: () => Promise<boolean>
  /** When a check last confirmed the desk is current (ms), or 0. */
  checkedAt: number
}

type Fetcher = () => Promise<string | null>

/**
 * Re-read the page? Yes with no fingerprint (the check failed), no earlier one
 * for this section (the first tick), a different one, or a last server render
 * older than FULL_REFRESH_MS.
 */
export function shouldReread(before: string | null, now: string | null, sinceRenderMs: number): boolean {
  if (!now || before === null || before !== now) return true
  return sinceRenderMs >= FULL_REFRESH_MS
}

const fetchVersion: Fetcher = async () => {
  const res = await fetch('/api/call-center/version', { cache: 'no-store', credentials: 'same-origin' })
  if (!res.ok) return null
  const data = (await res.json()) as { v?: unknown }
  return typeof data.v === 'string' ? data.v : null
}

/**
 * The 20 s live refresh's change check (lib/call-center/desk-version.ts):
 * before re-reading the whole page, ask the server for the desk's
 * fingerprint. The first tick after a page load always re-reads (as before)
 * and remembers the fingerprint it asked with; later ticks re-read only when
 * it moved, when FULL_REFRESH_MS has passed since the last server render, or
 * when the check itself fails. `scope` is the open section: a new one starts
 * over. Off (`enabled` false) every tick re-reads, as before.
 */
export function useDeskVersion(scope: string, renderedAt: string | undefined, enabled: boolean, load: Fetcher = fetchVersion): VersionCheck {
  const known = useRef<{ scope: string; v: string } | null>(null)
  const lastRender = useRef(0)
  const [checkedAt, setCheckedAt] = useState(0)

  // Every server render (a navigation, an action's refresh, pull to refresh, a tick) is a full read.
  useEffect(() => {
    lastRender.current = Date.now()
  }, [renderedAt])

  const changed = useCallback(async (): Promise<boolean> => {
    if (!enabled) return true
    let v: string | null = null
    try {
      v = await load()
    } catch {
      v = null
    }
    if (!v) return true // A failed check re-reads, as every tick did before.
    const before = known.current && known.current.scope === scope ? known.current.v : null
    known.current = { scope, v }
    if (shouldReread(before, v, Date.now() - lastRender.current)) return true
    setCheckedAt(Date.now())
    return false
  }, [enabled, load, scope])

  return { changed, checkedAt }
}
