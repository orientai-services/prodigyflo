import { type Edge, type Recommendation, type Verdict, isEdge } from '@/lib/telephony/quality'

/**
 * Per-browser phone preferences beyond the mic/speaker pick: the edge a full
 * test measured, low-data mode, the ringtone mute, and the last test's
 * headline. Conveniences, not records: every read and write is wrapped
 * because private windows and blocked site data throw, and calling must keep
 * working on the defaults when they do.
 */

export const EDGE_PREF_KEY = 'pf-voice-edge'
export const LOW_DATA_KEY = 'pf-voice-low-data'
export const RING_MUTED_KEY = 'pf-voice-ring-muted'
export const LAST_TEST_KEY = 'pf-voice-last-test'

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Not saved; the choice still applies for this page.
  }
}

export function readMeasuredEdge(): Edge | null {
  const v = read(EDGE_PREF_KEY)
  return isEdge(v) ? v : null
}

export function writeMeasuredEdge(edge: Edge | null): void {
  write(EDGE_PREF_KEY, edge)
}

export function readLowData(): boolean {
  return read(LOW_DATA_KEY) === '1'
}

export function writeLowData(on: boolean): void {
  write(LOW_DATA_KEY, on ? '1' : null)
}

export function readRingMuted(): boolean {
  return read(RING_MUTED_KEY) === '1'
}

export function writeRingMuted(on: boolean): void {
  write(RING_MUTED_KEY, on ? '1' : null)
}

/** The headline of the last test, shown before the rep runs a new one. */
export type LastTest = { at: number; full: boolean; verdict: Verdict; edge: Edge | null; mos: number | null }

export function readLastTest(): LastTest | null {
  const raw = read(LAST_TEST_KEY)
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<LastTest>
    if (typeof v.at !== 'number' || typeof v.verdict !== 'string') return null
    return { at: v.at, full: Boolean(v.full), verdict: v.verdict as Verdict, edge: isEdge(v.edge) ? v.edge : null, mos: typeof v.mos === 'number' ? v.mos : null }
  } catch {
    return null
  }
}

export function writeLastTest(full: boolean, rec: Recommendation): void {
  const last: LastTest = { at: Date.now(), full, verdict: rec.verdict, edge: rec.measured?.edge ?? null, mos: rec.measured?.mos ?? null }
  write(LAST_TEST_KEY, JSON.stringify(last))
}

/** The browser's IANA zone, or '' when the runtime can't say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    return ''
  }
}
