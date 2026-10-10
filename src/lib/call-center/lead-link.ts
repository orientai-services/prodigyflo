/**
 * Links into the desk. Lead ids are cuids, or Meta ids shaped
 * `meta:<org>:<leadgen>`, so they are checked with the same character rule
 * as the telephony target keys (`parseTargetKey`), never `^[A-Za-z0-9_-]+$`.
 * Pure and client-safe: the incoming-call banner uses it too.
 */

const ID = /^[A-Za-z0-9:_-]{1,200}$/
const TARGET = /^(client|lead|missed):([A-Za-z0-9:_-]{1,200})$/

/** A `?lead=` value the desk will open, or null. */
export function leadIdParam(value: string | string[] | undefined | null): string | null {
  const v = Array.isArray(value) ? value[0] : value
  return v && ID.test(v) ? v : null
}

export function leadHref(id: string): string {
  return `/call-center?lead=${encodeURIComponent(id)}`
}

/** 'client:<id>' → the client's page; 'lead:<id>' → that lead on the desk; else null. */
export function targetHref(target: string | null | undefined): string | null {
  const m = TARGET.exec((target ?? '').trim())
  if (!m) return null
  if (m[1] === 'client') return `/clients/${encodeURIComponent(m[2])}`
  if (m[1] === 'lead') return leadHref(m[2])
  return null
}

/** 'lead:<id>' → the lead id, else null. */
export function leadIdOfTarget(target: string | null | undefined): string | null {
  const m = TARGET.exec((target ?? '').trim())
  return m && m[1] === 'lead' ? m[2] : null
}
