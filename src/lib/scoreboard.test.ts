import { describe, expect, it } from 'vitest'
import {
  POINT_RULES,
  aiAlignmentPct,
  callHadBrief,
  computePoints,
  firstBriefViewByClient,
  leakTone,
  qaTone,
  rankRows,
  scoreboardRange,
  toneVsTarget,
  weekStartUtc,
} from '@/lib/scoreboard'

describe('computePoints', () => {
  it('scores the documented example transparently', () => {
    // 3 wins (2 hot), 5 briefed calls, 2 full-funnel calls, QA scores 8 and
    // 10, 1 leaking lead:
    // 3×10 + 2×5 + 5×2 + 2×1 + (1+3)×1 − 1×3 = 30+10+10+2+4−3 = 53
    const { total, lines } = computePoints({
      wins: 3,
      hotWins: 2,
      briefedCalls: 5,
      fullFunnelCalls: 2,
      qaScores: [8, 10],
      leakingLeads: 1,
    })
    expect(total).toBe(53)
    expect(lines).toHaveLength(POINT_RULES.length)
    expect(Object.fromEntries(lines.map((l) => [l.key, l.points]))).toEqual({
      win: 30,
      hotWin: 10,
      briefedCall: 10,
      fullFunnel: 2,
      qa: 4,
      leak: -3,
    })
  })

  it('zeroes cleanly with no activity', () => {
    const { total, lines } = computePoints({
      wins: 0,
      hotWins: 0,
      briefedCalls: 0,
      fullFunnelCalls: 0,
      qaScores: [],
      leakingLeads: 0,
    })
    expect(total).toBe(0)
    expect(lines.every((l) => l.count === 0 && l.points === 0)).toBe(true)
  })

  it('caps hot-win bonuses at the win count', () => {
    const { lines } = computePoints({
      wins: 1,
      hotWins: 4, // bad upstream data — bonus must not exceed actual wins
      briefedCalls: 0,
      fullFunnelCalls: 0,
      qaScores: [],
      leakingLeads: 0,
    })
    expect(lines.find((l) => l.key === 'hotWin')?.points).toBe(5)
  })

  it('only QA points above 7 earn, clamped to the 1-10 scale', () => {
    const qa = (scores: number[]) =>
      computePoints({ wins: 0, hotWins: 0, briefedCalls: 0, fullFunnelCalls: 0, qaScores: scores, leakingLeads: 0 })
        .lines.find((l) => l.key === 'qa')!.points
    expect(qa([7])).toBe(0)
    expect(qa([1, 5, 7])).toBe(0)
    expect(qa([9])).toBe(2)
    expect(qa([15])).toBe(3) // out-of-range score treated as a 10
  })

  it('can go negative when leaks dominate — the hole stays visible', () => {
    const { total } = computePoints({
      wins: 0,
      hotWins: 0,
      briefedCalls: 1,
      fullFunnelCalls: 0,
      qaScores: [],
      leakingLeads: 3,
    })
    expect(total).toBe(-7)
  })

  it('pays +1 per 100%-adherence call, itemized on its own line', () => {
    const { total, lines } = computePoints({
      wins: 0,
      hotWins: 0,
      briefedCalls: 0,
      fullFunnelCalls: 3,
      qaScores: [],
      leakingLeads: 0,
    })
    expect(total).toBe(3)
    expect(lines.find((l) => l.key === 'fullFunnel')).toMatchObject({ count: 3, each: 1, points: 3 })
  })

  it('ignores negative or fractional garbage counts', () => {
    const { total } = computePoints({
      wins: -2,
      hotWins: -1,
      briefedCalls: 2.9,
      fullFunnelCalls: -3,
      qaScores: [],
      leakingLeads: -5,
    })
    expect(total).toBe(4) // only floor(2.9)=2 briefed calls count
  })
})

describe('rankRows', () => {
  const row = (name: string, points: number, revenueWon = 0) => ({ name, points, revenueWon })

  it('uses competition ranking: ties share a rank, next rank skips', () => {
    const ranked = rankRows([row('a', 10), row('b', 20), row('c', 10), row('d', 5)])
    expect(ranked.map((r) => [r.name, r.rank])).toEqual([
      ['b', 1],
      ['a', 2],
      ['c', 2],
      ['d', 4],
    ])
  })

  it('breaks display order by revenue then name without changing rank', () => {
    const ranked = rankRows([row('zoe', 10, 100), row('amy', 10, 500)])
    expect(ranked.map((r) => r.name)).toEqual(['amy', 'zoe'])
    expect(ranked.map((r) => r.rank)).toEqual([1, 1])
  })
})

describe('tones', () => {
  it('toneVsTarget colors green/amber/red around the target', () => {
    expect(toneVsTarget(null, 35)).toBe('muted')
    expect(toneVsTarget(35, 35)).toBe('good')
    expect(toneVsTarget(28, 35)).toBe('warn') // exactly 80% of target
    expect(toneVsTarget(27.9, 35)).toBe('bad')
  })

  it('qaTone bands the 1-10 scale', () => {
    expect(qaTone(null)).toBe('muted')
    expect(qaTone(8)).toBe('good')
    expect(qaTone(6.5)).toBe('warn')
    expect(qaTone(5.9)).toBe('bad')
  })

  it('leakTone only forgives zero', () => {
    expect(leakTone(0)).toBe('good')
    expect(leakTone(2)).toBe('warn')
    expect(leakTone(3)).toBe('bad')
  })
})

describe('aiAlignmentPct', () => {
  const deals = (p: number, n: number, won: number) =>
    Array.from({ length: n }, (_, i) => ({ probability: p, won: i < won }))

  it('is null below the sample floor', () => {
    expect(aiAlignmentPct(deals(90, 4, 3))).toBeNull() // default floor 5
    expect(aiAlignmentPct([])).toBeNull()
  })

  it('is 100% when the AI read every decided deal perfectly', () => {
    // Five wins scored 100, five losses scored 0 → Brier 0 → alignment 100.
    expect(aiAlignmentPct([...deals(100, 5, 5), ...deals(0, 5, 0)])).toBe(100)
  })

  it('is 75% on coin-flip 50% scores (Brier 0.25)', () => {
    expect(aiAlignmentPct(deals(50, 6, 3))).toBe(75)
  })

  it('drops as outcomes diverge from the score', () => {
    // Six deals scored 90 but only two won → Brier high → alignment well below 75.
    const a = aiAlignmentPct(deals(90, 6, 2))
    expect(a).not.toBeNull()
    expect(a!).toBeLessThan(60)
  })

  it('honors a custom minimum sample', () => {
    expect(aiAlignmentPct(deals(80, 3, 3), 3)).not.toBeNull()
  })
})

describe('brief-before-call adoption', () => {
  const call = (clientId: string, iso: string) => ({ clientId, occurredAt: new Date(iso) })

  it('counts a call only when a brief was VIEWED at/before it', () => {
    const first = firstBriefViewByClient([
      { clientId: 'c1', viewedAt: new Date('2026-08-20T10:00:00Z') },
    ])
    expect(callHadBrief(first, call('c1', '2026-08-20T11:00:00Z'))).toBe(true)
    expect(callHadBrief(first, call('c1', '2026-08-20T10:00:00Z'))).toBe(true) // exact boundary
    // Viewed AFTER hanging up — the old generatedAt-only logic scored this.
    expect(callHadBrief(first, call('c1', '2026-08-20T09:00:00Z'))).toBe(false)
    expect(callHadBrief(first, call('c2', '2026-08-20T11:00:00Z'))).toBe(false) // no brief at all
  })

  it('keeps the EARLIEST view per client and ignores unviewed briefs', () => {
    const first = firstBriefViewByClient([
      { clientId: 'c1', viewedAt: new Date('2026-08-20T12:00:00Z') },
      { clientId: 'c1', viewedAt: new Date('2026-08-19T09:00:00Z') },
      { clientId: 'c2', viewedAt: null },
    ])
    expect(first.get('c1')).toBe(Date.parse('2026-08-19T09:00:00Z'))
    expect(first.has('c2')).toBe(false)
  })
})

describe('weekStartUtc', () => {
  const LA = 'America/Los_Angeles'

  it('starts the week on the ORG Monday midnight, as a UTC instant', () => {
    // 02:00Z Wed Aug 26 is Tue evening in LA → week began Monday Aug 24, 00:00 PDT.
    expect(weekStartUtc(new Date('2026-08-26T02:00:00Z'), LA).toISOString()).toBe(
      '2026-08-24T07:00:00.000Z',
    )
  })

  it('uses the LOCAL weekday even when UTC has already rolled into a new week', () => {
    // 05:00Z Monday Aug 24 is still Sunday evening in LA — a server-local cut
    // would jump a whole week ahead of the org here.
    expect(weekStartUtc(new Date('2026-08-24T05:00:00Z'), LA).toISOString()).toBe(
      '2026-08-17T07:00:00.000Z',
    )
  })

  it('is a no-op from Monday itself', () => {
    expect(weekStartUtc(new Date('2026-08-24T15:00:00Z'), LA).toISOString()).toBe(
      '2026-08-24T07:00:00.000Z',
    )
  })

  it('lands on standard-time midnight after the fall-back DST switch', () => {
    // US DST ends Sun Nov 1 2026, so the week of Thu Nov 5 starts in PST (UTC-8).
    expect(weekStartUtc(new Date('2026-11-05T20:00:00Z'), LA).toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    )
  })
})

describe('scoreboardRange', () => {
  it('cuts "this week" in the org timezone when one is given', () => {
    const r = scoreboardRange('week', new Date('2026-08-26T02:00:00Z'), 'America/Los_Angeles')
    expect(r.key).toBe('week')
    expect(r.label).toBe('This week')
    expect(r.from?.toISOString()).toBe('2026-08-24T07:00:00.000Z')
  })

  it('starts "this week" on Monday 00:00 local time', () => {
    const now = new Date(2026, 7, 26, 15, 30) // Wednesday Aug 26 2026
    const r = scoreboardRange('week', now)
    expect(r.key).toBe('week')
    expect(r.from?.getDay()).toBe(1) // Monday
    expect(r.from?.getDate()).toBe(24)
    expect(r.from?.getHours()).toBe(0)
  })

  it('handles a Sunday by going back to the previous Monday', () => {
    const now = new Date(2026, 7, 30, 9, 0) // Sunday Aug 30 2026
    expect(scoreboardRange('week', now).from?.getDate()).toBe(24)
  })

  it('falls back to 30 days for unknown params and supports 90/all', () => {
    const now = new Date(2026, 7, 26)
    expect(scoreboardRange(undefined, now).key).toBe('30')
    expect(scoreboardRange('bogus', now).key).toBe('30')
    expect(scoreboardRange('90', now).key).toBe('90')
    expect(scoreboardRange('all', now)).toEqual({ key: 'all', label: 'All time' })
  })
})
