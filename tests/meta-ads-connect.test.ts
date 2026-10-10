/**
 * scripts/meta-ads-connect.ts core (docs/META_ADS_SCS.md §5.1): read-only
 * without --commit, refuses every listed condition, idempotent on rerun.
 * Graph is the fake one; the lead workspace and the scrub count are mocked so
 * the shared test database can't skew them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state: { leadOrg: string; named: number; vault: Record<string, string> | null } = { leadOrg: '', named: 0, vault: null }
vi.mock('@/lib/meta/webhook-context', () => ({ resolveMetaOrg: async () => (state.leadOrg ? { id: state.leadOrg } : null) }))
// The connector vault: real unless a test saves an ads set "there".
vi.mock('@/lib/connectors/credentials', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/connectors/credentials')>()
  return {
    ...real,
    getConnectorCredentials: async (...a: Parameters<typeof real.getConnectorCredentials>) => state.vault ?? real.getConnectorCredentials(...a),
  }
})
vi.mock('../scripts/meta-attribution-scrub', () => ({ countNamedAttributionRows: async () => state.named }))

import { db } from '@/lib/db'
import { connectMetaAds } from '../scripts/meta-ads-connect'
import { GraphAdsSource } from '@/lib/meta/ads/source'
import { fakeGraph, type FakeGraphOptions } from './fixtures/meta-graph/fake-graph'
import { ALLOWED_ACCOUNT, ALLOWED_DIGITS, FOREIGN_ACCOUNT, FOREIGN_DIGITS } from './fixtures/meta-graph/ids'
import { clearSharedRows, makeOrg } from './fixtures/meta-graph/setup'

const run = `mcon-${Date.now().toString(36)}`
let orgId: string
let otherId: string

const envFor = (over: Record<string, string> = {}) => ({
  NODE_ENV: 'test',
  META_ADS_ORG_ID: orgId,
  META_ALLOWED_AD_ACCOUNTS: ALLOWED_ACCOUNT,
  META_ADS_APP_ID: 'ads-app-1',
  META_ADS_APP_SECRET: 'test-ads-secret-not-real',
  META_ADS_SYSTEM_USER_TOKEN: 'TEST-ADS-TOKEN-not-real',
  META_ADS_CYCLE_DAYS: '14',
  ...over,
})

function source(o: FakeGraphOptions = {}, env = envFor()) {
  return new GraphAdsSource(ALLOWED_ACCOUNT, { orgId, token: 'TEST-ADS-TOKEN-not-real', appId: 'ads-app-1', env, fetchImpl: fakeGraph(o).fetchImpl })
}

async function rows() {
  return {
    accounts: await db.metaAdAccount.count({ where: { adAccountId: ALLOWED_ACCOUNT } }),
    cycles: await db.metaSpendCycle.count({ where: { organizationId: orgId } }),
    audits: await db.auditEvent.count({ where: { organizationId: orgId, action: 'meta.ads.connected' } }),
  }
}

beforeAll(async () => {
  await clearSharedRows()
  orgId = (await makeOrg(run)).id
  otherId = (await makeOrg(`${run}-o`)).id
})

beforeEach(async () => {
  state.leadOrg = orgId
  state.named = 0
  state.vault = null
  await db.metaAdAccount.deleteMany({ where: { adAccountId: { in: [ALLOWED_ACCOUNT, FOREIGN_ACCOUNT] } } })
  await db.metaSpendCycle.deleteMany({ where: { organizationId: orgId } })
})

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: [orgId, otherId] } } })
  await clearSharedRows()
})

describe('connectMetaAds', () => {
  it('with no --org-id it only lists, and changes nothing', async () => {
    const r = await connectMetaAds({ env: envFor() })
    expect(r.committed).toBe(false)
    expect(r.lines.join('\n')).toContain(orgId)
    expect(r.lines.join('\n')).toContain('Nothing was changed')
    expect(await rows()).toEqual({ accounts: 0, cycles: 0, audits: 0 })
  })

  it('--check alone is read-only and prints the token facts', async () => {
    const r = await connectMetaAds({ orgId, adAccountId: ALLOWED_ACCOUNT, check: true, env: envFor(), source: source() })
    expect(r.committed).toBe(false)
    expect(r.refused).toEqual([])
    const text = r.lines.join('\n')
    expect(text).toContain('Token valid: yes')
    expect(text).toContain('Token sees other accounts: no')
    expect(text).not.toContain('TEST-ADS-TOKEN')
    expect(await rows()).toEqual({ accounts: 0, cycles: 0, audits: 0 })
  })

  const refusals: [string, () => Partial<Parameters<typeof connectMetaAds>[0]>, RegExp][] = [
    ['META_ADS_ORG_ID differs', () => ({ env: envFor({ META_ADS_ORG_ID: otherId }) }), /does not equal --org-id/],
    ['account not allowlisted', () => ({ adAccountId: FOREIGN_ACCOUNT }), /not in META_ALLOWED_AD_ACCOUNTS/],
    ['malformed account', () => ({ adAccountId: 'act_x' }), /act_ followed by digits/],
    ['lead workspace differs', () => { state.leadOrg = otherId; return {} }, /receives Meta leads/],
    ['scrub not done', () => { state.named = 3; return {} }, /scrub still finds 3/],
    ['token app is not ours', () => ({ source: source({ token: { appId: 'someone-elses-app' } }) }), /not the ads app ID/],
    ['not a system user', () => ({ source: source({ token: { type: 'USER' } }) }), /not a system user/],
    // No target list on a non-system-user token really is "all accounts".
    ['ads_read on all accounts', () => ({ source: source({ token: { adsReadTargets: 'all', type: 'USER' } }) }), /covers all accounts/],
    // A system user with no target list is judged by me/adaccounts.
    ['system user without target ids can reach others', () => ({ source: source({ token: { adsReadTargets: 'all' }, othersVisible: true }) }), /reach other ad accounts/],
    ['ads_read includes another account', () => ({ source: source({ token: { adsReadTargets: [ALLOWED_DIGITS, FOREIGN_DIGITS] } }) }), /only approved accounts/],
    ['token sees other accounts', () => ({ source: source({ othersVisible: true }) }), /reach other ad accounts/],
    ['credentials incomplete', () => ({ env: envFor({ META_ADS_APP_SECRET: '' }) }), /aren't live/],
  ]
  it.each(refusals)('refuses --commit when %s', async (_name, over, why) => {
    const r = await connectMetaAds({ orgId, adAccountId: ALLOWED_ACCOUNT, commit: true, startCycle: true, env: envFor(), source: source(), ...over() })
    expect(r.committed).toBe(false)
    expect(r.refused.join('\n')).toMatch(why)
    expect(await rows()).toEqual({ accounts: 0, cycles: 0, audits: 0 })
  })

  it('refuses when another workspace already holds the account', async () => {
    await db.metaAdAccount.create({ data: { organizationId: otherId, adAccountId: ALLOWED_ACCOUNT } })
    const r = await connectMetaAds({ orgId, adAccountId: ALLOWED_ACCOUNT, commit: true, env: envFor(), source: source() })
    expect(r.refused.join('\n')).toMatch(/Another workspace/)
    expect(await db.metaAdAccount.count({ where: { organizationId: orgId } })).toBe(0)
  })

  it('a system user token whose debug_token lists no target ids commits when it reaches only the approved account', async () => {
    const r = await connectMetaAds({ orgId, adAccountId: ALLOWED_ACCOUNT, commit: true, env: envFor(), source: source({ token: { adsReadTargets: 'all' } }) })
    expect(r.refused).toEqual([])
    expect(r.committed).toBe(true)
    expect(r.lines.join('\n')).toContain('not listed by Meta')
    // The token's app is stored, so the first sync knows it.
    expect((await db.metaAdAccount.findUniqueOrThrow({ where: { adAccountId: ALLOWED_ACCOUNT } })).tokenAppId).toBe('ads-app-1')
    await db.auditEvent.deleteMany({ where: { organizationId: orgId, action: 'meta.ads.connected' } })
  })

  it('credentials saved only in the vault (no META_ADS_* env) commit when the token is from that app', async () => {
    state.vault = { adsAppId: 'vault-app-9', adsAppSecret: 'vault-secret-not-real', adsSystemUserToken: 'VAULT-TOKEN-not-real' }
    const env = envFor({ META_ADS_APP_ID: '', META_ADS_APP_SECRET: '', META_ADS_SYSTEM_USER_TOKEN: '' })
    const r = await connectMetaAds({ orgId, adAccountId: ALLOWED_ACCOUNT, commit: true, env, source: source({ token: { appId: 'vault-app-9' } }, env) })
    expect(r.refused).toEqual([])
    expect(r.committed).toBe(true)
    expect((await db.metaAdAccount.findUniqueOrThrow({ where: { adAccountId: ALLOWED_ACCOUNT } })).tokenAppId).toBe('vault-app-9')
    await db.auditEvent.deleteMany({ where: { organizationId: orgId, action: 'meta.ads.connected' } })
  })

  it('a stale env app id next to newer vault credentials is not what the token is checked against', async () => {
    state.vault = { adsAppId: 'vault-app-9', adsAppSecret: 'vault-secret-not-real', adsSystemUserToken: 'VAULT-TOKEN-not-real' }
    // Env still names the old app; the token belongs to it, not to the vault set in use.
    const r = await connectMetaAds({ orgId, adAccountId: ALLOWED_ACCOUNT, commit: true, env: envFor(), source: source({ token: { appId: 'ads-app-1' } }) })
    expect(r.committed).toBe(false)
    expect(r.refused.join('\n')).toMatch(/not the ads app ID/)
    expect(await rows()).toEqual({ accounts: 0, cycles: 0, audits: 0 })
  })

  it('commits once, then reruns change nothing', async () => {
    const first = await connectMetaAds({ orgId, adAccountId: ALLOWED_ACCOUNT, commit: true, startCycle: true, env: envFor(), source: source() })
    expect(first.refused).toEqual([])
    expect(first.committed).toBe(true)
    expect(await rows()).toEqual({ accounts: 1, cycles: 1, audits: 1 })
    expect((await db.metaAdAccount.findUniqueOrThrow({ where: { adAccountId: ALLOWED_ACCOUNT } })).cycleDays).toBe(14)

    const again = await connectMetaAds({ orgId, adAccountId: ALLOWED_ACCOUNT, commit: true, startCycle: true, env: envFor(), source: source() })
    expect(again.committed).toBe(false)
    expect(again.alreadyConnected).toBe(true)
    expect(again.lines.join('\n')).toContain('Already connected')
    expect(await rows()).toEqual({ accounts: 1, cycles: 1, audits: 1 })
  })
})
