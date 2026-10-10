/**
 * The operations behind the /marketing/meta server actions (src/lib/meta/ads/manage.ts).
 * Mock mode (no binding, NODE_ENV=test) for the happy paths; a bound env for
 * the separation check, where the other workspace must never reach Graph.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { ForbiddenError } from '@/lib/rbac'
import { mockAdAccountId } from '@/lib/meta/ads/allowlist'
import {
  refreshAdsNowCore, rematchLeadsCore, recheckConnectionCore, setCycleLengthCore, startSpendCycleCore,
} from '@/lib/meta/ads/manage'
import { makeOrg, sessionFor, stubLiveEnv } from './fixtures/meta-graph/setup'

// Session users here are synthetic (no User row), so audit rows can't reference them.
vi.mock('@/lib/audit', async (orig) => ({ ...(await orig<typeof import('@/lib/audit')>()), recordAudit: async () => {} }))

const run = `mman-${Date.now().toString(36)}`
let orgA: string
let orgB: string

function mockEnv() {
  for (const k of ['META_ADS_ORG_ID', 'META_ALLOWED_AD_ACCOUNTS', 'META_ADS_SYSTEM_USER_TOKEN', 'META_ADS_APP_ID', 'META_ADS_APP_SECRET', 'VERCEL_ENV']) vi.stubEnv(k, '')
}

beforeAll(async () => {
  orgA = (await makeOrg(`${run}-a`)).id
  orgB = (await makeOrg(`${run}-b`)).id
})

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
})

describe('manage operations', () => {
  it('need connectors:manage', async () => {
    mockEnv()
    const viewer = sessionFor(orgA, ['connectors:read'], 'CLOSER')
    await expect(refreshAdsNowCore(viewer)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(startSpendCycleCore(viewer)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(setCycleLengthCore(viewer, 10)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('refresh runs once, then waits 2 minutes (counted in the database)', async () => {
    mockEnv()
    const u = sessionFor(orgA)
    const first = await refreshAdsNowCore(u)
    expect(first.ok).toBe(true)
    const row = await db.metaAdAccount.findFirst({ where: { organizationId: orgA } })
    expect(row?.adAccountId).toBe(mockAdAccountId(orgA))
    // The first run created the row; the next two are the claimed refresh and the refused one.
    expect((await refreshAdsNowCore(u)).ok).toBe(true)
    const third = await refreshAdsNowCore(u)
    expect(third.ok).toBe(false)
    expect(third.message).toMatch(/couple of minutes/)
  })

  it('start cycle closes the open one; cycle length applies to the open cycle', async () => {
    mockEnv()
    const u = sessionFor(orgA)
    const one = await startSpendCycleCore(u)
    const two = await startSpendCycleCore(u)
    expect(one.ok && two.ok).toBe(true)
    const cycles = await db.metaSpendCycle.findMany({ where: { organizationId: orgA }, orderBy: { number: 'asc' } })
    expect(cycles.map((c) => c.number)).toEqual([1, 2])
    expect(cycles[0].endedAt).not.toBeNull()
    expect(cycles[0].finalAfter).not.toBeNull()
    expect(cycles[1].endedAt).toBeNull()

    expect((await setCycleLengthCore(u, 0)).ok).toBe(false)
    expect((await setCycleLengthCore(u, 91)).ok).toBe(false)
    const set = await setCycleLengthCore(u, 7)
    expect(set).toEqual({ ok: true, message: 'Cycles now last 7 days.' })
    const open = await db.metaSpendCycle.findFirst({ where: { organizationId: orgA, endedAt: null } })
    expect(open?.lengthDays).toBe(7)
    expect(cycles[0].lengthDays).not.toBe(7)
    expect((await db.metaAdAccount.findFirst({ where: { organizationId: orgA } }))?.cycleDays).toBe(7)
  })

  it('re-check and re-match work in mock mode', async () => {
    mockEnv()
    const u = sessionFor(orgA)
    expect((await recheckConnectionCore(u)).ok).toBe(true)
    const r = await rematchLeadsCore(u)
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/^Checked \d+ leads/)
  })

  it('a workspace that is not bound gets a plain refusal, writes nothing and never reaches Graph', async () => {
    stubLiveEnv(orgA)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const u = sessionFor(orgB)
    const NOT_HERE = "Meta Ads reporting isn't connected for this workspace."
    for (const r of [
      await refreshAdsNowCore(u), await startSpendCycleCore(u), await setCycleLengthCore(u, 10),
      await recheckConnectionCore(u), await rematchLeadsCore(u),
    ]) expect(r).toEqual({ ok: false, message: NOT_HERE })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    expect(await db.metaAdAccount.count({ where: { organizationId: orgB } })).toBe(0)
    expect(await db.metaSpendCycle.count({ where: { organizationId: orgB } })).toBe(0)
  })
})
