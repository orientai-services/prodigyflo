import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@/lib/rbac'

const lookups = vi.hoisted(() => ({ calls: 0, answer: 7 as number | null, delayMs: 20 }))
vi.mock('@/lib/sunoff-bridge/handoff', () => ({
  sunoffUserIdFor: vi.fn(async () => {
    lookups.calls += 1
    await new Promise((r) => setTimeout(r, lookups.delayMs))
    return lookups.answer
  }),
  provisionSunoffUserFor: vi.fn(),
}))
vi.mock('@/lib/automation/actor', () => ({ loadActor: vi.fn() }))

import { clearLinkCache, linkedSunoffId } from './link'

const user = { id: 'u_link_1', name: 'Rep', email: 'rep@example.com', organizationId: 'org_1' } as SessionUser

describe('linkedSunoffId', () => {
  beforeEach(() => {
    process.env.PF_SUNOFF_BRIDGE_KEY = 'k'.repeat(40)
    lookups.calls = 0
    lookups.answer = 7
    clearLinkCache()
  })
  afterEach(() => {
    delete process.env.PF_SUNOFF_BRIDGE_KEY
  })

  it('asks SunOff once when the badge and the Team chat slot ask in the same render', async () => {
    const [a, b, c] = await Promise.all([linkedSunoffId(user), linkedSunoffId(user), linkedSunoffId(user)])
    expect([a, b, c]).toEqual([7, 7, 7])
    expect(lookups.calls).toBe(1)
  })

  it('answers from the cache afterwards and asks again once the entry is old', async () => {
    const t0 = Date.now()
    expect(await linkedSunoffId(user, t0)).toBe(7)
    expect(await linkedSunoffId(user, t0 + 1000)).toBe(7)
    expect(lookups.calls).toBe(1)
    expect(await linkedSunoffId(user, t0 + 6 * 60_000)).toBe(7)
    expect(lookups.calls).toBe(2)
  })

  it('a failed lookup reads as unlinked and is not shared with the next ask after it settles', async () => {
    lookups.answer = null
    const t0 = Date.now()
    expect(await linkedSunoffId(user, t0)).toBeNull()
    lookups.answer = 9
    // Misses are kept a minute, as before.
    expect(await linkedSunoffId(user, t0 + 1000)).toBeNull()
    expect(await linkedSunoffId(user, t0 + 61_000)).toBe(9)
    expect(lookups.calls).toBe(2)
  })
})
