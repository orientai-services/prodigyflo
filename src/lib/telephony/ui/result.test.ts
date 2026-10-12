import { describe, expect, it } from 'vitest'

describe('isDialCheckAnswer', () => {
  it('treats a refused dial as a dial answer, so its reason and override survive', async () => {
    const { isDialCheckAnswer, actionFailure } = await import('./result')
    const refused = { ok: false, code: 'OUTSIDE_HOURS', reason: "It's 5:25 am for them.", canOverride: 'hours' }
    expect(isDialCheckAnswer(refused)).toBe(true)
    expect(isDialCheckAnswer({ ok: true, who: 'x' })).toBe(true)
    expect(isDialCheckAnswer({ ok: false, error: 'boom' })).toBe(false)
    expect(actionFailure({ ok: false, error: 'boom' })?.error).toBe('boom')
  })
})
