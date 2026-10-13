import { describe, expect, it } from 'vitest'
import { invalidNumber, lastContactAt, latestRecording, noteSnippet, stageOf } from './app-shell'
import { BOOKED_DETAIL, attemptAlreadyCounted, followUpOf, hasCall, seedLeads, type CallLead, type TrailEvent, type TrailKind } from './model'
import { lastTouchAt, rankLeads, todayBoard } from './priority'
import { RECENT_MS, compactLeads, compactTrail } from './trail-summary'

// A small deterministic PRNG, so a failure names its seed.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const KINDS: TrailKind[] = ['form', 'inbound', 'call', 'sms', 'status', 'outcome', 'note', 'lock', 'intake']
const OUTCOME_LABELS = ['No answer', 'Wrong number', 'Callback', 'Booked']
const NOTES = ['Wants a callback after 5', 'Calendar hold placed with Dakota', 'Call back due Oct 13', '   ', 'Account 1234567890 overdue', 'Roof leak, HOA']

const NOW = Date.parse('2026-10-13T19:30:00.000Z')

function randomTrail(rand: () => number): TrailEvent[] {
  const n = Math.floor(rand() * 40)
  const trail: TrailEvent[] = []
  for (let i = 0; i < n; i += 1) {
    const kind = KINDS[Math.floor(rand() * KINDS.length)]
    // Up to 30 days back, a third of them inside the last two days.
    const ago = rand() < 0.33 ? rand() * RECENT_MS : rand() * 30 * 86_400_000
    const event: TrailEvent = {
      kind,
      at: new Date(NOW - ago).toISOString(),
      label: kind === 'outcome' ? OUTCOME_LABELS[Math.floor(rand() * OUTCOME_LABELS.length)] : kind,
      detail: kind === 'note' ? NOTES[Math.floor(rand() * NOTES.length)] : kind === 'outcome' && rand() < 0.3 ? BOOKED_DETAIL : `${kind} ${i}`,
    }
    const mark = rand()
    if (mark < 0.15) event.followUp = 'callback'
    else if (mark < 0.3) event.followUp = 'cadence'
    else if (mark < 0.4) event.followUp = 'none'
    if ((kind === 'call' || kind === 'inbound') && rand() < 0.3) event.recording = { src: `/api/voice/recordings/r${i}`, seconds: Math.floor(rand() * 300) }
    trail.push(event)
  }
  // Mostly oldest first, as the desk sends it; a few out of order, as a late carrier row can be.
  trail.sort((a, b) => a.at.localeCompare(b.at))
  if (trail.length > 3 && rand() < 0.2) [trail[1], trail[2]] = [trail[2], trail[1]]
  return trail
}

/** A ranking with each lead named by id (the trimmed and the full lead objects differ only in their trail). */
function byId(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, v) => (v && typeof v === 'object' && 'trail' in v && 'id' in v ? `lead:${(v as CallLead).id}` : v)))
}

/** Everything the list, the rows and the Today ranking read from a trail. */
function readings(lead: CallLead) {
  return {
    lastContactAt: lastContactAt(lead),
    lastTouchAt: lastTouchAt(lead),
    invalidNumber: invalidNumber(lead),
    latestRecording: latestRecording(lead),
    noteSnippet: noteSnippet(lead),
    stage: stageOf(lead),
    followUp: followUpOf(lead),
    attemptAlreadyCounted: attemptAlreadyCounted(lead),
    hasCall: hasCall(lead),
  }
}

describe('compactTrail', () => {
  it('keeps every reading the desk list makes, for random trails', () => {
    const base = seedLeads()
    for (let seed = 1; seed <= 400; seed += 1) {
      const rand = rng(seed)
      const leads: CallLead[] = base.map((lead) => ({
        ...lead,
        trail: randomTrail(rand),
        followUp: null,
        nextAttemptAt: rand() < 0.5 ? new Date(NOW + (rand() - 0.5) * 86_400_000).toISOString() : null,
        tries: Math.floor(rand() * 4),
      }))
      const compact = compactLeads(leads, NOW)
      for (let i = 0; i < leads.length; i += 1) {
        expect(readings(compact[i]), `seed ${seed} lead ${i}`).toEqual(readings(leads[i]))
      }
      // The Today board (KPIs, ranking, Call first, queues) at render time and later the same day.
      for (const at of [NOW, NOW + 3 * 3_600_000, NOW + 23 * 3_600_000]) {
        const now = new Date(at)
        expect(byId(todayBoard(compact, now)), `seed ${seed} at ${now.toISOString()}`).toEqual(byId(todayBoard(leads, now)))
        expect(byId(rankLeads(compact, now))).toEqual(byId(rankLeads(leads, now)))
      }
    }
  })

  it('a result after a recent call is still seen (the wrap-up check)', () => {
    const trail: TrailEvent[] = [
      { kind: 'outcome', at: new Date(NOW - 10 * 86_400_000).toISOString(), label: 'No answer', detail: '' },
      { kind: 'call', at: new Date(NOW - 5 * 60_000).toISOString(), label: 'Call', detail: '' },
      { kind: 'outcome', at: new Date(NOW - 60_000).toISOString(), label: 'Callback', detail: '' },
    ]
    const kept = compactTrail(trail, NOW)
    const since = NOW - 10 * 60_000
    expect(kept.some((e) => e.kind === 'outcome' && Date.parse(e.at) >= since)).toBe(true)
  })

  it('leaves short trails alone and marks only trimmed leads', () => {
    const [lead] = seedLeads()
    const [same] = compactLeads([lead], Date.parse(lead.arrivedAt))
    expect(same).toBe(lead)
    const old = Array.from({ length: 12 }, (_, i): TrailEvent => ({ kind: 'lock', at: new Date(NOW - (30 - i) * 86_400_000).toISOString(), label: 'Took', detail: '' }))
    const [trimmed] = compactLeads([{ ...lead, trail: old }], NOW)
    expect(trimmed.trailPartial).toBe(true)
    expect(trimmed.trail.length).toBeLessThan(old.length)
    const [open] = compactLeads([{ ...lead, trail: old }], NOW, lead.id)
    expect(open.trail).toHaveLength(12)
    expect(open.trailPartial).toBeUndefined()
  })
})
