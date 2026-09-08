import { describe, expect, it } from 'vitest'
import {
  clampScore,
  formatChange,
  kindChipClass,
  orderSteps,
  parseCitations,
  parseOutcome,
  runDuration,
  runTone,
  stepTone,
} from './engine-view'

describe('parseCitations', () => {
  it('returns [] for non-array evidence', () => {
    expect(parseCitations(null)).toEqual([])
    expect(parseCitations(undefined)).toEqual([])
    expect(parseCitations({ source: 'x' })).toEqual([])
    expect(parseCitations('nope')).toEqual([])
  })

  it('keeps well-formed citations and fills defaults', () => {
    const out = parseCitations([
      { source: 'metrics', ref: 'ads:30d', text: 'CPL rose 40%' },
      { ref: 'x', text: 'no source given' },
      { source: 'notes', text: 'no ref' },
    ])
    expect(out).toEqual([
      { source: 'metrics', ref: 'ads:30d', text: 'CPL rose 40%' },
      { source: 'context', ref: 'x', text: 'no source given' },
      { source: 'notes', ref: '', text: 'no ref' },
    ])
  })

  it('drops entries without usable text', () => {
    expect(
      parseCitations([{ source: 'a', ref: 'b' }, { text: '   ' }, { text: 42 }, null, ['x'], 'raw']),
    ).toEqual([])
  })
})

describe('parseOutcome', () => {
  it('returns null for non-object outcomes', () => {
    expect(parseOutcome(null)).toBeNull()
    expect(parseOutcome(undefined)).toBeNull()
    expect(parseOutcome([1, 2])).toBeNull()
    expect(parseOutcome('measured')).toBeNull()
  })

  it('reads measuredAt and sorts deltas by movement, dropping unchanged KPIs', () => {
    const out = parseOutcome({
      measuredAt: '2026-08-20T00:00:00.000Z',
      delta: {
        closeRate: { before: 10, after: 12, change: 2 },
        leads: { before: 100, after: 100, change: 0 },
        atRisk: { before: 8, after: 3, change: -5 },
      },
    })
    expect(out).not.toBeNull()
    expect(out!.measuredAt).toBe('2026-08-20T00:00:00.000Z')
    expect(out!.deltas.map((d) => d.key)).toEqual(['atRisk', 'closeRate'])
  })

  it('keeps zero-change deltas only when nothing moved, and caps at 4', () => {
    const flat = parseOutcome({ delta: { a: { before: 1, after: 1, change: 0 } } })
    expect(flat!.deltas).toEqual([{ key: 'a', before: 1, after: 1, change: 0 }])

    const wide = parseOutcome({
      delta: Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`k${i}`, { before: 0, after: i + 1, change: i + 1 }]),
      ),
    })
    expect(wide!.deltas).toHaveLength(4)
    expect(wide!.deltas[0]!.change).toBe(8)
  })

  it('skips malformed delta entries', () => {
    const out = parseOutcome({
      measuredAt: 7, // wrong type → null
      delta: {
        good: { before: 1, after: 2, change: 1 },
        bad1: { before: '1', after: 2, change: 1 },
        bad2: null,
        bad3: { before: 1, after: 2, change: Number.NaN },
      },
    })
    expect(out!.measuredAt).toBeNull()
    expect(out!.deltas.map((d) => d.key)).toEqual(['good'])
  })
})

describe('formatChange', () => {
  it('signs positives explicitly', () => {
    expect(formatChange(3.2)).toBe('+3.2')
    expect(formatChange(-1)).toBe('-1')
    expect(formatChange(0)).toBe('0')
  })
})

describe('orderSteps', () => {
  it('sorts into canonical insight_scan order', () => {
    const shuffled = ['measure', 'collect', 'persist', 'retrieve', 'analyze'].map((key) => ({ key }))
    expect(orderSteps(shuffled).map((s) => s.key)).toEqual([
      'collect',
      'retrieve',
      'analyze',
      'persist',
      'measure',
    ])
  })

  it('keeps unknown keys in stored order after the known ones', () => {
    const steps = [{ key: 'zeta' }, { key: 'measure' }, { key: 'alpha' }, { key: 'collect' }]
    expect(orderSteps(steps).map((s) => s.key)).toEqual(['collect', 'measure', 'zeta', 'alpha'])
  })

  it('does not mutate its input', () => {
    const steps = [{ key: 'measure' }, { key: 'collect' }]
    orderSteps(steps)
    expect(steps.map((s) => s.key)).toEqual(['measure', 'collect'])
  })
})

describe('tones', () => {
  it('maps step statuses to semantic tokens', () => {
    expect(stepTone('COMPLETED')).toBe('success')
    expect(stepTone('RUNNING')).toBe('warning')
    expect(stepTone('READY')).toBe('warning')
    expect(stepTone('FAILED')).toBe('danger')
    expect(stepTone('PENDING')).toBe('muted')
    expect(stepTone('SKIPPED')).toBe('muted')
  })

  it('maps run statuses to semantic tokens', () => {
    expect(runTone('COMPLETED')).toBe('success')
    expect(runTone('FAILED')).toBe('danger')
    expect(runTone('RUNNING')).toBe('warning')
    expect(runTone('PENDING')).toBe('muted')
  })
})

describe('runDuration', () => {
  it('is null when either bound is missing or the range is inverted', () => {
    expect(runDuration(null, '2026-01-01T00:00:00Z')).toBeNull()
    expect(runDuration('2026-01-01T00:00:00Z', null)).toBeNull()
    expect(runDuration('2026-01-01T00:01:00Z', '2026-01-01T00:00:00Z')).toBeNull()
    expect(runDuration('not a date', '2026-01-01T00:00:00Z')).toBeNull()
  })

  it('formats seconds, minutes and hours', () => {
    expect(runDuration('2026-01-01T00:00:00Z', '2026-01-01T00:00:42Z')).toBe('42s')
    expect(runDuration('2026-01-01T00:00:00Z', '2026-01-01T00:03:07Z')).toBe('3m 07s')
    expect(runDuration('2026-01-01T00:00:00Z', '2026-01-01T01:05:00Z')).toBe('1h 05m')
  })
})

describe('clampScore', () => {
  it('clamps into 0–100 integers and nulls the unusable', () => {
    expect(clampScore(84.4)).toBe(84)
    expect(clampScore(140)).toBe(100)
    expect(clampScore(-3)).toBe(0)
    expect(clampScore(null)).toBeNull()
    expect(clampScore(Number.NaN)).toBeNull()
  })
})

describe('kindChipClass', () => {
  it('gives risk/operations semantic tints and unknown kinds the neutral chip', () => {
    expect(kindChipClass('risk')).toContain('danger')
    expect(kindChipClass('operations')).toContain('warning')
    expect(kindChipClass('pipeline')).toContain('primary')
    expect(kindChipClass('made-up')).toContain('muted')
  })
})
