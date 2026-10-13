import { noteText } from './app-shell'
import type { CallLead, TrailEvent } from './model'

/**
 * The desk list's lead trails, trimmed to what the rows and the Today ranking
 * read (docs/DIALER_APP.md). Every list-level reading of a trail looks at
 * either "today" or the newest event of some kind, so a lead keeps:
 *
 *  - every event of the last RECENT_MS (today's counts, the wrap-up check,
 *    a result logged after a call), and
 *  - for older events, the newest one of each kind a row reads: contact
 *    (call / inbound / text / result), touch (anything but lock, form,
 *    status), result, call-or-result, call or inbound, recording, the lead's
 *    own note, and follow-up mark.
 *
 * The lead panel's Comms trail shows the whole history: it is read when a
 * lead opens (loadLeadTrail) or sent in full for the `?lead=` in the URL.
 * `trailPartial` marks a lead whose trail was trimmed.
 */

/** Two days: "today" in any zone of a page that has been open a whole day still falls inside it. */
export const RECENT_MS = 48 * 60 * 60_000

const CONTACT = new Set(['call', 'inbound', 'sms', 'outcome'])
const NOT_TOUCH = new Set(['lock', 'form', 'status'])

type Pick = (event: TrailEvent) => boolean

const NEWEST_OF: Pick[] = [
  (e) => CONTACT.has(e.kind),
  (e) => !NOT_TOUCH.has(e.kind),
  (e) => e.kind === 'outcome',
  (e) => e.kind === 'outcome' || e.kind === 'call',
  (e) => e.kind === 'call' || e.kind === 'inbound',
  (e) => Boolean(e.recording),
  (e) => noteText(e) !== null,
  (e) => e.followUp !== undefined,
]

export function compactTrail(trail: readonly TrailEvent[], nowMs: number): TrailEvent[] {
  const keep = new Set<number>()
  const since = nowMs - RECENT_MS
  trail.forEach((event, index) => {
    const at = Date.parse(event.at)
    if (!Number.isFinite(at) || at >= since) keep.add(index)
  })
  for (const pick of NEWEST_OF) {
    // The trail is oldest first, so the newest match is the last one; a later
    // event out of order (a call saved after a result) is still found because
    // every reader walks the same array order.
    for (let index = trail.length - 1; index >= 0; index -= 1) {
      if (pick(trail[index])) {
        keep.add(index)
        break
      }
    }
  }
  // lastContactAt / lastTouchAt take the latest timestamp, not the last in order: keep those too.
  for (const pick of [NEWEST_OF[0], NEWEST_OF[1]]) {
    let best = -1
    let bestAt = -Infinity
    trail.forEach((event, index) => {
      const at = Date.parse(event.at)
      if (pick(event) && Number.isFinite(at) && at > bestAt) {
        best = index
        bestAt = at
      }
    })
    if (best >= 0) keep.add(best)
  }
  if (keep.size === trail.length) return [...trail]
  return trail.filter((_, index) => keep.has(index))
}

/** The desk list: trimmed trails, except `fullFor` (the lead open in the URL), which keeps its whole history. */
export function compactLeads(leads: CallLead[], nowMs: number, fullFor: string | null = null): CallLead[] {
  return leads.map((lead) => {
    if (lead.id === fullFor) return lead
    const trail = compactTrail(lead.trail, nowMs)
    return trail.length === lead.trail.length ? lead : { ...lead, trail, trailPartial: true }
  })
}
