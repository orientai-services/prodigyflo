/**
 * Every read.ts view must cross to a client component: no BigInt, no Decimal.
 * Seeded through mock mode (no binding, NODE_ENV=test), which also exercises
 * MockAdsSource end to end.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { syncAdsForOrg } from '@/lib/meta/ads/sync'
import { getAdsDashboard, getBillingView, getConnectionView, getCycleView, getFunnelView } from '@/lib/meta/ads/read'
import { mockAdAccountId } from '@/lib/meta/ads/allowlist'
import { startSpendCycleCore } from '@/lib/meta/ads/manage'
import { makeOrg, sessionFor } from './fixtures/meta-graph/setup'

// Session users here are synthetic (no User row), so audit rows can't reference them.
vi.mock('@/lib/audit', async (orig) => ({ ...(await orig<typeof import('@/lib/audit')>()), recordAudit: async () => {} }))

const run = `mser-${Date.now().toString(36)}`
let orgId: string

function plain(value: unknown, path = '$'): void {
  if (typeof value === 'bigint') throw new Error(`BigInt at ${path}`)
  if (value === null || typeof value !== 'object' || value instanceof Date) return
  const name = (value as object).constructor?.name
  if (name && !['Object', 'Array'].includes(name)) throw new Error(`${name} at ${path}`)
  for (const [k, v] of Object.entries(value)) plain(v, `${path}.${k}`)
}

beforeAll(async () => {
  for (const k of ['META_ADS_ORG_ID', 'META_ALLOWED_AD_ACCOUNTS', 'META_ADS_SYSTEM_USER_TOKEN', 'META_ADS_APP_ID', 'META_ADS_APP_SECRET', 'VERCEL_ENV']) vi.stubEnv(k, '')
  orgId = (await makeOrg(run)).id
  const t0 = Date.now() - 3 * 3_600_000
  // Several readings so the snapshot/billing path runs on mock data.
  for (let i = 0; i < 4; i++) await syncAdsForOrg(orgId, { force: i === 0, now: new Date(t0 + i * 600_000) })
  await startSpendCycleCore(sessionFor(orgId))
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.organization.delete({ where: { id: orgId } })
})

describe('serialization boundary', () => {
  it('mock mode stores only the workspace mock account id', async () => {
    const accounts = await db.metaAdAccount.findMany({ where: { organizationId: orgId } })
    expect(accounts.map((a) => a.adAccountId)).toEqual([mockAdAccountId(orgId)])
    expect(await db.metaAd.count({ where: { organizationId: orgId, adAccountId: mockAdAccountId(orgId) } })).toBe(9)
    const snaps = await db.metaAccountSnapshot.count({ where: { organizationId: orgId } })
    expect(snaps).toBe(4)
  })

  it('every view is plain JSON-safe data', async () => {
    const u = sessionFor(orgId)
    const views = {
      dashboard: await getAdsDashboard(u, '30d'),
      max: await getAdsDashboard(u, 'max'),
      billing: await getBillingView(u),
      cycle: await getCycleView(u),
      funnel: await getFunnelView(u, 'all'),
      connection: await getConnectionView(u),
    }
    for (const [name, v] of Object.entries(views)) {
      expect(() => plain(v), name).not.toThrow()
      expect(() => JSON.stringify(v), name).not.toThrow()
    }
    expect(views.dashboard.sync.mode).toBe('mock')
    expect(views.dashboard.account?.balance).toEqual(expect.any(Number))
    expect(views.dashboard.tree.length).toBeGreaterThan(0)
    const sum = views.dashboard.tree.reduce((a, n) => a + n.metrics.spend, 0)
    expect(Math.round(sum * 100) / 100).toBe(views.dashboard.totals.spend)
    expect(views.cycle.current?.number).toBe(1)
    expect(views.connection.mode).toBe('mock')
  })

  it('read.ts refuses a user without connectors:read', async () => {
    await expect(getAdsDashboard(sessionFor(orgId, [], 'CLOSER'), '30d')).rejects.toThrow()
    await expect(getBillingView(sessionFor(orgId, ['connectors:read'], 'CLOSER'))).rejects.toThrow()
  })
})
