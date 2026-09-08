import { describe, expect, it } from 'vitest'
import {
  defineDag,
  failureCascadeKeys,
  getDag,
  initialStepStatuses,
  isRunSettled,
  promotableStepKeys,
  runOutcome,
  stepRetryBackoffMs,
  validateDagSteps,
  type DagStepState,
} from '@/lib/engine/dag'

// Pure graph-logic tests: no database, no clock. The runner persists these
// exact transitions; here they are exercised directly.

const noop = async () => ({})

describe('validateDagSteps', () => {
  it('returns a topological order, roots first', () => {
    const order = validateDagSteps([
      { key: 'persist', dependsOn: ['analyze'] },
      { key: 'collect' },
      { key: 'analyze', dependsOn: ['collect', 'retrieve'] },
      { key: 'retrieve', dependsOn: ['collect'] },
    ])
    expect(order.indexOf('collect')).toBeLessThan(order.indexOf('retrieve'))
    expect(order.indexOf('retrieve')).toBeLessThan(order.indexOf('analyze'))
    expect(order.indexOf('analyze')).toBeLessThan(order.indexOf('persist'))
  })

  it('rejects a two-step cycle at definition time', () => {
    expect(() =>
      validateDagSteps([
        { key: 'a', dependsOn: ['b'] },
        { key: 'b', dependsOn: ['a'] },
      ]),
    ).toThrow(/cycle/)
  })

  it('rejects a longer cycle hidden behind valid roots', () => {
    expect(() =>
      validateDagSteps([
        { key: 'root' },
        { key: 'a', dependsOn: ['root', 'c'] },
        { key: 'b', dependsOn: ['a'] },
        { key: 'c', dependsOn: ['b'] },
      ]),
    ).toThrow(/cycle/)
  })

  it('rejects self-dependencies, unknown dependencies, and duplicate keys', () => {
    expect(() => validateDagSteps([{ key: 'a', dependsOn: ['a'] }])).toThrow(/itself/)
    expect(() => validateDagSteps([{ key: 'a', dependsOn: ['ghost'] }])).toThrow(/unknown step "ghost"/)
    expect(() => validateDagSteps([{ key: 'a' }, { key: 'a' }])).toThrow(/twice/)
  })
})

describe('defineDag', () => {
  it('registers a valid DAG and rejects an invalid one before registration', () => {
    defineDag({ kind: 'test_valid', steps: [{ key: 'only', run: noop }] })
    expect(getDag('test_valid')?.steps).toHaveLength(1)

    expect(() =>
      defineDag({
        kind: 'test_cyclic',
        steps: [
          { key: 'a', dependsOn: ['b'], run: noop },
          { key: 'b', dependsOn: ['a'], run: noop },
        ],
      }),
    ).toThrow(/cycle/)
    expect(getDag('test_cyclic')).toBeUndefined()
  })
})

describe('initialStepStatuses', () => {
  it('marks roots READY and dependent steps PENDING', () => {
    expect(
      initialStepStatuses([
        { key: 'collect' },
        { key: 'retrieve', dependsOn: ['collect'] },
        { key: 'other-root', dependsOn: [] },
      ]),
    ).toEqual({ collect: 'READY', retrieve: 'PENDING', 'other-root': 'READY' })
  })
})

describe('promotableStepKeys (readiness promotion)', () => {
  const state = (key: string, status: DagStepState['status'], dependsOn: string[] = []): DagStepState => ({
    key,
    status,
    dependsOn,
  })

  it('promotes a PENDING step once every dependency has COMPLETED', () => {
    expect(
      promotableStepKeys([
        state('collect', 'COMPLETED'),
        state('retrieve', 'PENDING', ['collect']),
      ]),
    ).toEqual(['retrieve'])
  })

  it('does not promote a step while any of its dependencies is unfinished', () => {
    for (const blocking of ['PENDING', 'READY', 'RUNNING', 'FAILED', 'SKIPPED'] as const) {
      expect(
        promotableStepKeys([
          state('a', 'COMPLETED'),
          state('b', blocking, ['a-missing-dep-elsewhere']),
          state('join', 'PENDING', ['a', 'b']),
        ]),
      ).not.toContain('join')
    }
  })

  it('promotes a diamond join only after both branches complete', () => {
    const diamond = (left: DagStepState['status'], right: DagStepState['status']) =>
      promotableStepKeys([
        state('root', 'COMPLETED'),
        state('left', left, ['root']),
        state('right', right, ['root']),
        state('join', 'PENDING', ['left', 'right']),
      ])
    expect(diamond('COMPLETED', 'RUNNING')).toEqual([])
    expect(diamond('COMPLETED', 'COMPLETED')).toEqual(['join'])
  })

  it('never re-promotes steps that already left PENDING', () => {
    expect(
      promotableStepKeys([
        state('collect', 'COMPLETED'),
        state('retrieve', 'READY', ['collect']),
        state('analyze', 'RUNNING', ['collect']),
        state('persist', 'COMPLETED', ['collect']),
      ]),
    ).toEqual([])
  })
})

describe('failureCascadeKeys (failure cascade)', () => {
  it('skips everything not yet started, and nothing else', () => {
    expect(
      failureCascadeKeys([
        { key: 'collect', status: 'COMPLETED', dependsOn: [] },
        { key: 'retrieve', status: 'FAILED', dependsOn: ['collect'] },
        { key: 'analyze', status: 'PENDING', dependsOn: ['retrieve'] },
        { key: 'parallel', status: 'READY', dependsOn: ['collect'] },
        { key: 'inflight', status: 'RUNNING', dependsOn: ['collect'] },
      ]),
    ).toEqual(['analyze', 'parallel'])
  })
})

describe('isRunSettled / runOutcome', () => {
  it('settles only when every step is terminal', () => {
    expect(
      isRunSettled([
        { key: 'a', status: 'COMPLETED', dependsOn: [] },
        { key: 'b', status: 'READY', dependsOn: [] },
      ]),
    ).toBe(false)
    expect(
      isRunSettled([
        { key: 'a', status: 'COMPLETED', dependsOn: [] },
        { key: 'b', status: 'SKIPPED', dependsOn: [] },
      ]),
    ).toBe(true)
  })

  it('a run with any FAILED or SKIPPED step is FAILED, else COMPLETED', () => {
    expect(
      runOutcome([
        { key: 'a', status: 'COMPLETED', dependsOn: [] },
        { key: 'b', status: 'COMPLETED', dependsOn: [] },
      ]),
    ).toBe('COMPLETED')
    expect(
      runOutcome([
        { key: 'a', status: 'COMPLETED', dependsOn: [] },
        { key: 'b', status: 'FAILED', dependsOn: [] },
        { key: 'c', status: 'SKIPPED', dependsOn: [] },
      ]),
    ).toBe('FAILED')
  })
})

describe('stepRetryBackoffMs', () => {
  it('doubles from 15 minutes per failed attempt', () => {
    expect(stepRetryBackoffMs(1)).toBe(15 * 60_000)
    expect(stepRetryBackoffMs(2)).toBe(30 * 60_000)
    expect(stepRetryBackoffMs(3)).toBe(60 * 60_000)
  })
})
