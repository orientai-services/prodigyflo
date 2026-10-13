import { describe, expect, it } from 'vitest'
import { FULL_REFRESH_MS, shouldReread } from './use-desk-version'

describe('shouldReread', () => {
  it('re-reads on the first tick, a failed check and a changed desk', () => {
    expect(shouldReread(null, 'a', 0)).toBe(true)
    expect(shouldReread('a', null, 0)).toBe(true)
    expect(shouldReread('a', 'b', 0)).toBe(true)
  })
  it('skips an unchanged desk until the full re-read is due', () => {
    expect(shouldReread('a', 'a', 20_000)).toBe(false)
    expect(shouldReread('a', 'a', FULL_REFRESH_MS - 1)).toBe(false)
    expect(shouldReread('a', 'a', FULL_REFRESH_MS)).toBe(true)
  })
})
