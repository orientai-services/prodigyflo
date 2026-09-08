import { describe, expect, it } from 'vitest'
import { FUNNEL_STEPS, adherencePct, parseAdherence, type AdherenceEntry } from '@/lib/adherence'

const all = (done: boolean): AdherenceEntry[] => FUNNEL_STEPS.map((s) => ({ step: s.key, done }))

describe('FUNNEL_STEPS', () => {
  it('is the documented 5-step funnel, in order', () => {
    expect(FUNNEL_STEPS.map((s) => s.key)).toEqual([
      'brief_reviewed',
      'discovery',
      'present',
      'objections',
      'commitment',
    ])
    for (const step of FUNNEL_STEPS) {
      expect(step.label.length).toBeGreaterThan(0)
      expect(step.hint.length).toBeGreaterThan(0)
    }
  })
})

describe('adherencePct', () => {
  it('scores full and zero adherence', () => {
    expect(adherencePct(all(true))).toBe(100)
    expect(adherencePct(all(false))).toBe(0)
  })

  it('is null with nothing to score — old calls never count as 0%', () => {
    expect(adherencePct([])).toBeNull()
  })

  it('always divides by all 5 steps, even when only some were recorded', () => {
    expect(adherencePct([{ step: 'brief_reviewed', done: true }])).toBe(20)
    expect(
      adherencePct([
        { step: 'brief_reviewed', done: true },
        { step: 'discovery', done: true },
        { step: 'present', done: false },
      ]),
    ).toBe(40)
  })

  it('rounds to an integer', () => {
    expect(
      adherencePct([
        { step: 'brief_reviewed', done: true },
        { step: 'discovery', done: true },
        { step: 'present', done: true },
      ]),
    ).toBe(60)
  })

  it('lets the last duplicate win and ignores unknown steps', () => {
    expect(
      adherencePct([
        { step: 'discovery', done: true },
        { step: 'discovery', done: false },
        { step: 'made_up' as never, done: true },
      ]),
    ).toBe(0)
  })
})

describe('parseAdherence', () => {
  it('round-trips a clean payload in canonical order', () => {
    const entries = parseAdherence([
      { step: 'commitment', done: true },
      { step: 'brief_reviewed', done: false },
    ])
    expect(entries).toEqual([
      { step: 'brief_reviewed', done: false },
      { step: 'commitment', done: true },
    ])
  })

  it('returns [] for every non-array shape', () => {
    for (const junk of [null, undefined, 'x', 42, {}, { step: 'discovery', done: true }]) {
      expect(parseAdherence(junk)).toEqual([])
    }
  })

  it('drops malformed items and unknown steps, keeps the rest', () => {
    const entries = parseAdherence([
      null,
      'nope',
      { step: 'not_a_step', done: true },
      { step: 'present', done: true },
      { done: true },
      { step: 'objections', done: 'yes' }, // non-boolean done -> treated as not done
    ])
    expect(entries).toEqual([
      { step: 'present', done: true },
      { step: 'objections', done: false },
    ])
  })

  it('dedupes a repeated step, last value winning', () => {
    expect(
      parseAdherence([
        { step: 'discovery', done: false },
        { step: 'discovery', done: true },
      ]),
    ).toEqual([{ step: 'discovery', done: true }])
  })

  it('composes with adherencePct on database JSON', () => {
    expect(adherencePct(parseAdherence('[]'))).toBeNull()
    expect(adherencePct(parseAdherence([]))).toBeNull()
    expect(adherencePct(parseAdherence(FUNNEL_STEPS.map((s) => ({ step: s.key, done: true }))))).toBe(100)
  })
})
