import { describe, expect, it } from 'vitest'
import {
  AdAccountNotAllowedError, adsBinding, adsMockAllowed, allowedAccountsForOrg, assertAllowedAdAccount, isAllowedAdAccount,
  isBoundOrg, mockAdAccountId, normalizeAdAccountId, refFor,
} from './allowlist'

const ALLOWED = 'act_1742876583597558'
const FOREIGN = 'act_999000111222333'
const ORG = 'org_bound_1'
const env = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'test', META_ADS_ORG_ID: ORG, META_ALLOWED_AD_ACCOUNTS: ALLOWED, ...over,
})

describe('normalizeAdAccountId', () => {
  it('accepts act_ prefixed and bare digits', () => {
    expect(normalizeAdAccountId('act_1742876583597558')).toBe(ALLOWED)
    expect(normalizeAdAccountId('1742876583597558')).toBe(ALLOWED)
    expect(normalizeAdAccountId('  act_1742876583597558 ')).toBe(ALLOWED)
  })
  it('decodes until stable (act%5F, double encoding)', () => {
    expect(normalizeAdAccountId('act%5F1742876583597558')).toBe(ALLOWED)
    expect(normalizeAdAccountId('act%255F1742876583597558')).toBe(ALLOWED)
    expect(normalizeAdAccountId('act%5F999000111222333')).toBe(FOREIGN)
  })
  it('rejects anything else', () => {
    for (const bad of ['', 'act_', 'act_12', 'act_123456789012345678901', 'act_17428abc', '1,2,3', 'me', 'act_1742876583597558/campaigns', '%E0%A4%A', 'act_mock_x']) {
      expect(normalizeAdAccountId(bad)).toBeNull()
    }
  })
})

describe('binding', () => {
  it('needs BOTH variables', () => {
    expect(adsBinding(env())).toEqual({ orgId: ORG, accounts: new Set([ALLOWED]) })
    expect(adsBinding(env({ META_ADS_ORG_ID: '' }))).toBeNull()
    expect(adsBinding(env({ META_ALLOWED_AD_ACCOUNTS: '' }))).toBeNull()
    expect(adsBinding(env({ META_ADS_ORG_ID: undefined }))).toBeNull()
  })
  it('one malformed entry fails the whole list closed', () => {
    expect(adsBinding(env({ META_ALLOWED_AD_ACCOUNTS: `${ALLOWED},act_bad` }))).toBeNull()
    expect(adsBinding(env({ META_ADS_ORG_ID: 'has space' }))).toBeNull()
  })
  it('an unbound org is never allowed anything', () => {
    expect(isBoundOrg(ORG, env())).toBe(true)
    expect(isBoundOrg('org_other', env())).toBe(false)
    expect(allowedAccountsForOrg('org_other', env({ NODE_ENV: 'production' }))).toEqual([])
    expect(allowedAccountsForOrg(ORG, env({ NODE_ENV: 'production' }))).toEqual([ALLOWED])
    expect(() => assertAllowedAdAccount(ALLOWED, 'org_other', env())).toThrow(AdAccountNotAllowedError)
    try {
      assertAllowedAdAccount(ALLOWED, 'org_other', env())
    } catch (e) {
      expect((e as AdAccountNotAllowedError).reason).toBe('unbound_org')
    }
  })
  it('refuses foreign, malformed and unconfigured', () => {
    expect(isAllowedAdAccount(FOREIGN, env())).toBe(false)
    expect(isAllowedAdAccount(ALLOWED, env())).toBe(true)
    const reason = (id: string, e = env()) => {
      try {
        assertAllowedAdAccount(id, ORG, e)
        return 'ok'
      } catch (err) {
        return (err as AdAccountNotAllowedError).reason
      }
    }
    expect(reason(ALLOWED)).toBe('ok')
    expect(reason(FOREIGN)).toBe('not_allowlisted')
    expect(reason('act_nope')).toBe('malformed')
    expect(reason(ALLOWED, env({ META_ADS_ORG_ID: '' }))).toBe('not_bound')
    expect(assertAllowedAdAccount('1742876583597558', ORG, env())).toBe(ALLOWED)
  })
  it('the mock id is added only where mock is allowed, and only for a workspace that could be in mock mode', () => {
    expect(allowedAccountsForOrg(ORG, env())).toEqual([ALLOWED, mockAdAccountId(ORG)])
    expect(allowedAccountsForOrg('org_other', env())).toEqual([])
    expect(allowedAccountsForOrg('org_any', { NODE_ENV: 'test' })).toEqual([mockAdAccountId('org_any')])
    expect(allowedAccountsForOrg('org_any', { NODE_ENV: 'production' })).toEqual([])
  })
})

describe('refFor', () => {
  it('contains no digits at all, so no digit run of the id can leak', () => {
    for (const id of [FOREIGN, ALLOWED, '999000111222333', 'act%5F999000111222333']) {
      const ref = refFor(id)
      expect(ref).toMatch(/^acct#[a-p]{10}$/)
      expect(ref).not.toMatch(/\d/)
    }
  })
  it('is stable across spellings of the same id and distinct across ids', () => {
    expect(refFor(FOREIGN)).toBe(refFor('999000111222333'))
    expect(refFor(FOREIGN)).not.toBe(refFor(ALLOWED))
  })
})

describe('adsMockAllowed', () => {
  it('never on Vercel production or the production hosts', () => {
    expect(adsMockAllowed({ VERCEL_ENV: 'production', NODE_ENV: 'test' })).toBe(false)
    expect(adsMockAllowed({ VERCEL_ENV: 'preview', APP_URL: 'https://prodigyflo.ai' })).toBe(false)
    expect(adsMockAllowed({ VERCEL_ENV: 'preview', AUTH_URL: 'https://www.prodigyflo.ai/' })).toBe(false)
    expect(adsMockAllowed({ NODE_ENV: 'production' })).toBe(false)
  })
  it('in development, test and preview', () => {
    expect(adsMockAllowed({ NODE_ENV: 'test' })).toBe(true)
    expect(adsMockAllowed({ NODE_ENV: 'development' })).toBe(true)
    expect(adsMockAllowed({ VERCEL_ENV: 'preview', APP_URL: 'https://x-git-y.vercel.app' })).toBe(true)
  })
})
