import { afterEach, describe, expect, it, vi } from 'vitest'
import { visibleCampaignName } from './where'
import { mockAdAccountId } from './allowlist'

const BOUND = 'org_bound'
const OTHER = 'org_other'
const ALLOWED = 'act_1742876583597558'

function bind() {
  vi.stubEnv('META_ADS_ORG_ID', BOUND)
  vi.stubEnv('META_ALLOWED_AD_ACCOUNTS', ALLOWED)
}

afterEach(() => vi.unstubAllEnvs())

describe('visibleCampaignName', () => {
  it('always shows non-meta campaigns', () => {
    bind()
    expect(visibleCampaignName(OTHER, { name: 'Door hangers', channel: 'print', adAccountId: null })).toBe('Door hangers')
  })

  it('shows a meta campaign only to the bound workspace and only for an allowed account', () => {
    bind()
    const allowed = { name: 'Allowed', channel: 'meta', adAccountId: ALLOWED }
    expect(visibleCampaignName(BOUND, allowed)).toBe('Allowed')
    expect(visibleCampaignName(OTHER, allowed)).toBeNull()
    expect(visibleCampaignName(BOUND, { name: 'Legacy', channel: 'meta', adAccountId: null })).toBeNull()
    expect(visibleCampaignName(BOUND, { name: 'Foreign', channel: 'meta', adAccountId: 'act_99999' })).toBeNull()
    expect(visibleCampaignName(BOUND, null)).toBeNull()
  })

  it('hides mock rows outside mock mode', () => {
    bind()
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(visibleCampaignName(BOUND, { name: 'Sample', channel: 'meta', adAccountId: mockAdAccountId(BOUND) })).toBeNull()
  })
})
