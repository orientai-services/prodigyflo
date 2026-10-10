/**
 * Connectors → Meta Ads guard (docs/META_ADS_SCS.md §2.2 rule 5): only the
 * bound workspace may store the ad account id or the ads credentials, and only
 * an approved ad account id. Lead-intake fields are untouched by the guard.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const actor: { current: unknown } = { current: null }
vi.mock('@/lib/rbac', async (orig) => ({ ...(await orig<typeof import('@/lib/rbac')>()), requirePermission: async () => actor.current }))
vi.mock('@/lib/stepup', async (orig) => ({ ...(await orig<typeof import('@/lib/stepup')>()), requireStepUp: async () => {} }))
vi.mock('@/lib/audit', async (orig) => ({ ...(await orig<typeof import('@/lib/audit')>()), recordAudit: async () => {} }))

import { db } from '@/lib/db'
import { saveConnectorCredentials, rotateConnectorCredential } from '@/lib/connectors/provision'
import { ALLOWED_ACCOUNT, FOREIGN_ACCOUNT } from './fixtures/meta-graph/ids'
import { makeAdmin, makeOrg, sessionFor } from './fixtures/meta-graph/setup'

const run = `mprov-${Date.now().toString(36)}`
let bound: string
let other: string
const admins: Record<string, string> = {}

beforeAll(async () => {
  vi.stubEnv('VAULT_KEY', process.env.VAULT_KEY || 'test-vault-key-meta-ads')
  bound = (await makeOrg(`${run}-b`)).id
  other = (await makeOrg(`${run}-o`)).id
  admins[bound] = await makeAdmin(bound)
  admins[other] = await makeAdmin(other)
})

beforeEach(() => {
  vi.stubEnv('META_ADS_ORG_ID', bound)
  vi.stubEnv('META_ALLOWED_AD_ACCOUNTS', ALLOWED_ACCOUNT)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db.organization.deleteMany({ where: { id: { in: [bound, other] } } })
})

const save = (orgId: string, values: Record<string, string>) => {
  actor.current = sessionFor(orgId, undefined, 'SUPER_ADMIN', admins[orgId])
  return saveConnectorCredentials(actor.current as never, { defId: 'meta-ads-api', values })
}

describe('Meta Ads credential guard', () => {
  it('another workspace may not store the ad account or the ads credentials', async () => {
    const attempts: Record<string, string>[] = [{ adAccountId: ALLOWED_ACCOUNT }, { adsSystemUserToken: 'x' }, { adsAppId: '1' }, { adsAppSecret: 's' }]
    for (const values of attempts) {
      const r = await save(other, values)
      expect(r).toEqual({ ok: false, error: 'Ads reporting is connected to a different ProdigyFlo workspace.' })
    }
    expect(await db.connectorCredential.count({ where: { organizationId: other } })).toBe(0)
  })

  it('lead-intake fields are unaffected in any workspace', async () => {
    const r = await save(other, { appId: 'intake-app', appSecret: 'intake-secret', systemUserToken: 'intake-token' })
    expect(r.ok).toBe(true)
  })

  it('the bound workspace may store only an approved ad account', async () => {
    expect(await save(bound, { adAccountId: FOREIGN_ACCOUNT })).toEqual({ ok: false, error: "This ad account isn't approved for ProdigyFlo." })
    expect(await save(bound, { adAccountId: 'act%5F999000111222333' })).toEqual({ ok: false, error: "This ad account isn't approved for ProdigyFlo." })
    const ok = await save(bound, { adAccountId: ALLOWED_ACCOUNT, adsAppId: 'ads-app-1', adsAppSecret: 's', adsSystemUserToken: 't' })
    expect(ok.ok).toBe(true)
  })

  it('rotation is guarded the same way', async () => {
    actor.current = sessionFor(bound, undefined, 'SUPER_ADMIN', admins[bound])
    const r = await rotateConnectorCredential(actor.current as never, { defId: 'meta-ads-api', fieldKey: 'adAccountId', value: FOREIGN_ACCOUNT })
    expect(r).toEqual({ ok: false, error: "This ad account isn't approved for ProdigyFlo." })
  })
})
