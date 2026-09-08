import { describe, expect, it } from 'vitest'
import { callScoringBlock, MAX_SCORING_CALLS_PER_CLIENT_PER_DAY } from '@/lib/call-log'

process.env.AUTH_SECRET ??= 'test-secret'

describe('callScoringBlock', () => {
  it('lets a normal connected call earn adherence credit', () => {
    expect(callScoringBlock({ outcome: 'CONNECTED', durationSeconds: 120, sameDayCallCount: 0 })).toBeNull()
  })

  it('blocks a zero-duration CONNECTED call — that is not a conversation', () => {
    expect(callScoringBlock({ outcome: 'CONNECTED', durationSeconds: 0, sameDayCallCount: 0 })).toBe(
      'zero_duration_connected',
    )
  })

  it('does not apply the zero-duration block to non-connected outcomes', () => {
    // A no-answer or voicemail attempt legitimately has no talk time. It stores
    // whatever checklist was sent (usually empty), same as before the guard.
    for (const outcome of ['VOICEMAIL', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'DECLINED', 'FAILED'] as const) {
      expect(callScoringBlock({ outcome, durationSeconds: 0, sameDayCallCount: 0 })).toBeNull()
    }
  })

  it('caps points-eligible calls per closer per client per day', () => {
    const under = MAX_SCORING_CALLS_PER_CLIENT_PER_DAY - 1
    expect(callScoringBlock({ outcome: 'CONNECTED', durationSeconds: 60, sameDayCallCount: under })).toBeNull()
    expect(
      callScoringBlock({
        outcome: 'CONNECTED',
        durationSeconds: 60,
        sameDayCallCount: MAX_SCORING_CALLS_PER_CLIENT_PER_DAY,
      }),
    ).toBe('daily_cap')
    expect(
      callScoringBlock({
        outcome: 'CONNECTED',
        durationSeconds: 60,
        sameDayCallCount: MAX_SCORING_CALLS_PER_CLIENT_PER_DAY + 5,
      }),
    ).toBe('daily_cap')
  })

  it('reports the zero-duration block before the daily cap', () => {
    expect(
      callScoringBlock({
        outcome: 'CONNECTED',
        durationSeconds: 0,
        sameDayCallCount: MAX_SCORING_CALLS_PER_CLIENT_PER_DAY,
      }),
    ).toBe('zero_duration_connected')
  })
})
