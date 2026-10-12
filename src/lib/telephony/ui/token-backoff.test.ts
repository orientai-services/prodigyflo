import { describe, expect, it } from 'vitest'
import { TOKEN_RETRY_MAX_MS, tokenRetryDelay } from './token-backoff'

describe('tokenRetryDelay', () => {
  it('doubles from 2 s and stops at 60 s without jitter', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20, 1000].map((n) => tokenRetryDelay(n, 0))).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000,
    ])
  })

  it('adds at most 10% jitter', () => {
    expect(tokenRetryDelay(0, 0.999999)).toBe(2_200)
    expect(tokenRetryDelay(10, 0.5)).toBe(TOKEN_RETRY_MAX_MS * 1.05)
    for (let i = 0; i < 50; i++) {
      const d = tokenRetryDelay(3, Math.random())
      expect(d).toBeGreaterThanOrEqual(16_000)
      expect(d).toBeLessThanOrEqual(17_600)
    }
  })

  it('treats bad input as the first attempt and clamps random', () => {
    expect(tokenRetryDelay(-3, 0)).toBe(2_000)
    expect(tokenRetryDelay(1.7, 5)).toBe(4_400)
  })
})
