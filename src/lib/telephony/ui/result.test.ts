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

describe('whenLabel', () => {
  it('is Pacific whatever the machine zone, so a server render and the browser agree', async () => {
    const { whenLabel } = await import('./result')
    expect(whenLabel('2026-10-12T07:43:00.000Z')).toBe('Oct 12, 12:43 am')
    expect(whenLabel('2026-10-08T15:04:00Z')).toBe('Oct 8, 8:04 am')
    expect(whenLabel(null)).toBe('—')
    expect(whenLabel('nope')).toBe('—')
  })
})
